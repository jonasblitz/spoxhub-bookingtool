const express = require('express');
const router = express.Router();
const etermin = require('../lib/etermin');
const analytics = require('../lib/analytics');
const paypal = require('../lib/paypal');
const voucher = require('./api-voucher');
const { getActiveWorkshopCalendars, loadCalendars } = require('../lib/calendars');
const autoPause = require('../lib/auto-pause');
const config = require('../lib/config');
const reservations = require('../lib/reservations');

/**
 * eTermin booking failed *after* PayPal capture: refund the deposit and log
 * the failed booking to Airtable so we don't lose the customer's data.
 * Always returns a recovery summary; never throws.
 */
async function handleBookingFailureAfterPayment(state, errorMessage) {
  const captureId = state?.payment?.captureId;
  const orderId   = state?.payment?.orderId;
  const method    = state?.payment?.method;
  let refund = { status: 'skipped' };

  // Voucher bookings never charged money — nothing to refund, just log.
  if (method === 'voucher') {
    refund = { status: 'skipped', reason: 'voucher (no charge)' };
  } else if (captureId) {
    try {
      const refundRes = await paypal.refundCapture(captureId, {
        reason: 'Buchung konnte nicht erstellt werden — Anzahlung erstattet.',
        invoiceId: orderId || undefined
      });
      refund = {
        status: 'refunded',
        refundId: refundRes?.id || null,
        amount: refundRes?.amount?.value || null
      };
      console.log('[booking-failure] auto-refund OK:', { captureId, refundId: refund.refundId });
    } catch (err) {
      refund = { status: 'failed', error: err.message };
      console.error('[booking-failure] auto-refund FAILED:', { captureId, error: err.message });
    }
  } else {
    console.warn('[booking-failure] no PayPal captureId — refund skipped');
  }

  // Log to Airtable (best-effort, never block).
  try {
    await analytics.createFailedBooking({ state, errorMessage, refund });
  } catch (e) {
    console.error('[booking-failure] failed-bookings log error:', e.message);
  }

  return refund;
}

/**
 * Pick the workshop calendar with the lowest appointment count for a given date.
 * Tie-broken by Priorität (asc). Kept for backward-compat.
 */
async function pickLeastBusyWorkshopCalendar(date) {
  const calendars = await getActiveWorkshopCalendars();
  if (calendars.length === 0) return null;
  return pickLeastBusyFromSet(date, calendars.map(c => c.id));
}

/**
 * Pick the least-busy calendar from a given set of IDs for a date.
 *
 * Sort order:
 *   1. Termin-Count ascending (= least-busy first)
 *   2. travelTime ascending (only for Mobil — caller passes via opts.travelTimes)
 *   3. Priorität ascending (Stammdaten)
 *
 * @param {string} date         "YYYY-MM-DD"
 * @param {number[]} calIds     Candidate calendar IDs (must be active)
 * @param {object} [opts]
 * @param {Object<number, number>} [opts.travelTimes]  Map calId → travelTimeMinutes (Mobil)
 */
async function pickLeastBusyFromSet(date, calIds, opts = {}) {
  if (!Array.isArray(calIds) || calIds.length === 0) return null;
  if (calIds.length === 1) return Number(calIds[0]);

  const all = await loadCalendars();
  const byId = new Map(all.map(c => [c.id, c]));
  const travelTimes = opts.travelTimes || {};

  const counts = await Promise.all(calIds.map(async id => {
    const cal = byId.get(Number(id));
    try {
      const apps = await etermin.getAppointments(id, date, date);
      return {
        id: Number(id),
        count: Array.isArray(apps) ? apps.length : 0,
        travel: Number.isFinite(travelTimes[id]) ? travelTimes[id] : Number.MAX_SAFE_INTEGER,
        prio: cal?.prio ?? 99
      };
    } catch (err) {
      console.warn(`[booking] count error for cal ${id}:`, err.message);
      return {
        id: Number(id),
        count: Number.MAX_SAFE_INTEGER,
        travel: Number.MAX_SAFE_INTEGER,
        prio: cal?.prio ?? 99
      };
    }
  }));

  counts.sort((a, b) =>
    (a.count - b.count) ||
    (a.travel - b.travel) ||
    (a.prio - b.prio)
  );

  console.log('[booking] load:',
    counts.map(c => `${c.id}=${c.count}` + (c.travel < Number.MAX_SAFE_INTEGER ? `/${c.travel}min` : '')).join(', '),
    '→ chose', counts[0].id);
  return counts[0].id;
}

// Build public URL for files in /uploads/ — used by Airtable to fetch attachments.
// Requires PUBLIC_BASE_URL env (e.g. "https://spoxhub.io/booking") for production.
function filenameToPublicUrl(filename, req) {
  if (!filename) return null;
  const base = process.env.PUBLIC_BASE_URL
    || `${req.protocol}://${req.get('host')}${(req.baseUrl || '').replace(/\/api.*$/, '')}`;
  return `${base.replace(/\/$/, '')}/uploads/${filename}`;
}

// Write booking + customer + bike + session completion to Airtable (fail-soft).
async function persistBookingToAirtable(state, eterminBookingId, req) {
  if (!analytics.isConfigured()) return;

  try {
    const customer = state.customer || {};
    const bike = state.bike || {};

    // 1. Customer (upsert by Email)
    const customerRecord = await analytics.findOrCreateCustomer(customer.email, customer);

    // 2. Bike (always new)
    const bikeRecord = await analytics.createBike(
      customerRecord?.id,
      bike,
      state.vehicleType
    );

    // 3. Problem media URLs
    const problemMediaUrls = (state.uploadedFiles || [])
      .map(f => filenameToPublicUrl(f.filename, req))
      .filter(Boolean);

    // 5. Booking
    const bookingRecord = await analytics.createBooking({
      customerRecordId: customerRecord?.id,
      bikeRecordId: bikeRecord?.id,
      state,
      eterminBookingId,
      problemMediaUrls
    });

    // 6. Complete session
    if (state.sessionId) {
      await analytics.completeSession(state.sessionId, bookingRecord?.id, customerRecord?.id);
    }

    console.log('[analytics] booking persisted:', {
      customerId: customerRecord?.id,
      bikeId: bikeRecord?.id,
      bookingId: bookingRecord?.id
    });
  } catch (err) {
    // Airtable failure shouldn't block successful eTermin booking
    console.error('[analytics] persist error:', err.message);
  }
}

router.post('/confirm', async (req, res) => {
  const state = req.body;

  // Server-side validation
  if (!state.selectedSlot) {
    return res.status(400).json({ success: false, error: 'Kein Termin gewählt' });
  }

  if (!state.selectedServices || state.selectedServices.length === 0) {
    return res.status(400).json({ success: false, error: 'Keine Leistungen gewählt' });
  }

  // Aufbau-Termine sind ausschließlich in der Werkstatt möglich.
  if (state.serviceType === 'aufbau' && state.locationType !== 'werkstatt') {
    return res.status(400).json({
      success: false,
      error: 'Aufbau-Termine sind nur in der Werkstatt möglich.'
    });
  }

  const c = state.customer || {};
  if (!c.vorname || !c.name || !c.email || !c.mobil) {
    return res.status(400).json({ success: false, error: 'Kundendaten unvollständig' });
  }

  // Fahrradmarke ist optional (User kann ohne Marke buchen).
  const b = state.bike || {};

  // Payment validation — either a real PayPal capture OR a valid voucher code.
  // The voucher path skips PayPal entirely (no money flow), but still requires
  // a server-side check so a manipulated frontend can't fake it.
  const p = state.payment || {};
  if (p.method === 'voucher') {
    if (!voucher.isValidVoucher(p.code)) {
      return res.status(400).json({ success: false, error: 'Gutscheincode ungültig.' });
    }
    // Normalize so downstream code (etermin appattrib, Airtable) treats it
    // identically to a paid deposit. amount kommt aus Konfiguration.
    const voucherAmount = await config.get('DepositAmountEUR', 20);
    state.payment = {
      method: 'voucher',
      code: String(p.code).trim().toUpperCase(),
      amount: voucherAmount,
      status: 'completed'
    };
    state.depositPaid = true;
  } else if (!p.captureId || p.status !== 'completed') {
    return res.status(400).json({ success: false, error: 'Anzahlung fehlt oder nicht bestätigt.' });
  }

  // ─── Build structured notes ──────────────────────────────────────────────
  const vehicleLabel  = state.vehicleType === 'ebike' ? 'E-Bike' : 'Cargobike';
  const locationLabels = { mobil: 'Mobil', anderer_ort: 'Anderer Ort', werkstatt: 'Werkstatt' };
  const fmtEur = n => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}${(req.baseUrl || '').replace(/\/api.*$/, '')}`).replace(/\/$/, '');
  const fileUrl = filename => filename ? `${PUBLIC_BASE}/uploads/${filename}` : null;

  const sections = [];

  // 0. TESTBUCHUNG banner — only when paid via voucher (no real money flow)
  if (state.payment?.method === 'voucher') {
    sections.push(
      '🚧🚧🚧  T E S T B U C H U N G  🚧🚧🚧\n' +
      '(Gutscheincode statt Anzahlung — kein Geld geflossen)'
    );
  }

  // 1. Leistungen
  const lineItems = (state.pricing?.lineItems || state.selectedServices || []).map(item => {
    const qty = item.quantity || 1;
    const label = qty > 1 ? `${qty}× ${item.name}` : item.name;
    const inspBadge = item.includedInInspektion ? '  (inkl. Inspektion)' : '';
    return `- ${label} (${fmtEur(item.price)})${inspBadge}`;
  });
  if (state.pricing?.inspektionOverage?.cost > 0) {
    const o = state.pricing.inspektionOverage;
    lineItems.push(`+ Zusätzliche Arbeitszeit über Inspektions-Bonus: ${o.minutes} Min × ${o.rate} €/Min = ${fmtEur(o.cost)}`);
  }
  sections.push('══ LEISTUNGEN ══\n' + lineItems.join('\n'));

  // 2. Problembeschreibung (only if filled)
  if (state.problemDescription) {
    sections.push('══ PROBLEMBESCHREIBUNG ══\n' + state.problemDescription.trim());
  }

  // 3. Fahrzeug
  const vehicleLines = [
    `${vehicleLabel} — ${b.marke}${b.modell ? ' ' + b.modell : ''}`,
    b.rahmennummer ? `Rahmennummer: ${b.rahmennummer}` : null,
    b.leasing      ? `Leasing:       ${b.leasing}${b.leasingNr ? ' (Vertrags-Nr ' + b.leasingNr + ')' : ''}` : null,
    b.versicherung ? `Versicherung:  ${b.versicherung}${b.versicherungNr ? ' (Vertrags-Nr ' + b.versicherungNr + ')' : ''}` : null
  ].filter(Boolean);
  sections.push('══ FAHRZEUG ══\n' + vehicleLines.join('\n'));

  // 4. Fotos / Videos (only if any)
  const mediaLines = [];
  (state.uploadedFiles || []).forEach((f, i) => {
    const u = fileUrl(f.filename);
    if (u) mediaLines.push(`Problem ${i + 1}: ${u}`);
  });
  if (mediaLines.length > 0) {
    sections.push('══ FOTOS / VIDEOS ══\n' + mediaLines.join('\n'));
  }

  // 5. Kunde
  const customerSalutation = c.anrede ? c.anrede + ' ' : '';
  const customerLines = [
    `${customerSalutation}${c.vorname} ${c.name}`,
    `${c.email} · ${c.mobil}`,
    `${c.strasse}, ${c.plz} ${c.ort}`
  ];
  sections.push('══ KUNDE ══\n' + customerLines.join('\n'));

  // 6. Rechnung (only if abweichend)
  if (c.rechnungStrasse || c.rechnungFirma) {
    const billingLines = [
      'Abweichend:',
      c.rechnungFirma || null,
      c.rechnungStrasse || null,
      `${c.rechnungPlz || ''} ${c.rechnungOrt || ''}`.trim() || null
    ].filter(Boolean);
    sections.push('══ RECHNUNG ══\n' + billingLines.join('\n'));
  }

  // 7. Standort (Service-Location summary)
  const locationLines = [
    `${locationLabels[state.locationType] || state.locationType}`,
    state.address ? state.address : null,
    state.addressNotes ? `Hinweise zur Zufahrt: ${state.addressNotes}` : null
  ].filter(Boolean);
  sections.push('══ SERVICE-ORT ══\n' + locationLines.join('\n'));

  // 8. Preis & Zahlung
  const priceLines = [];
  if (state.pricing?.total != null) priceLines.push(`Geschätzter Gesamtpreis: ${fmtEur(state.pricing.total)}`);
  if (state.pricing?.travelFee > 0) priceLines.push(`   Anfahrtskosten:       ${fmtEur(state.pricing.travelFee)}`);
  if (state.payment?.amount)        priceLines.push(`Anzahlung (PayPal):       ${fmtEur(state.payment.amount)}`);
  if (state.payment?.orderId)       priceLines.push(`PayPal Order-ID:          ${state.payment.orderId}`);
  if (priceLines.length > 0) sections.push('══ PREIS & ZAHLUNG ══\n' + priceLines.join('\n'));

  const notes = sections.join('\n\n');

  // Format start/end for eTermin: yyyy-mm-dd HH:MM
  const slot = state.selectedSlot;
  const startDateTime = `${slot.date} ${slot.start}`;
  const endDateTime = `${slot.date} ${slot.end}`;

  // Try eTermin booking
  if (process.env.ETERMIN_PUBLIC_KEY && process.env.ETERMIN_PRIVATE_KEY) {
    try {
      // Build unique comma-separated list of eTermin service IDs
      const eterminServiceIds = [
        ...new Set((state.selectedServices || [])
          .map(s => s.eterminId)
          .filter(Boolean))
      ];

      // Service location: for mobile service, the customer address; otherwise empty
      // (eTermin keeps the calendar's default location for werkstatt).
      let appointmentLocation = '';
      if (state.locationType !== 'werkstatt') {
        const a = state.addressFields || {};
        const street = a.street || c.strasse || '';
        const plz    = a.plz    || c.plz    || '';
        const city   = a.city   || c.ort    || '';
        appointmentLocation = `${street}, ${plz} ${city}`
          .replace(/^,\s*/, '')     // trim leading comma
          .replace(/\s+,\s*$/, '')  // trim trailing comma
          .replace(/\s{2,}/g, ' ')  // collapse double spaces
          .trim();
      }

      // Kalender-Auflösung:
      //   - Reservation hält schon den Slot → der calendarId der Memory-Reservation
      //     ist autoritativ (state.reservation.id + state.reservation.slot.calendarId)
      //   - sonst: slot.calendarId / slot.eligibleCalendarIds / Werkstatt-Default
      const reservationId = state.reservation?.id;
      const liveReservation = reservationId ? reservations.get(reservationId) : null;

      let resolvedCalendarId = liveReservation?.calendarId
        || state.reservation?.slot?.calendarId
        || slot.calendarId;
      if (!resolvedCalendarId && Array.isArray(slot.eligibleCalendarIds) && slot.eligibleCalendarIds.length > 0) {
        const travelTimes = {};
        const geo = state.geoResult?.eligible;
        if (Array.isArray(geo)) {
          for (const e of geo) {
            if (e?.calendarId && Number.isFinite(e?.travelTimeMinutes)) {
              travelTimes[e.calendarId] = e.travelTimeMinutes;
            }
          }
        }
        resolvedCalendarId = await pickLeastBusyFromSet(slot.date, slot.eligibleCalendarIds, { travelTimes });
      }
      if (!resolvedCalendarId) {
        resolvedCalendarId = await pickLeastBusyWorkshopCalendar(slot.date);
        if (!resolvedCalendarId) resolvedCalendarId = await getDefaultCalendarId();
      }

      // Reservation-Status prüfen: wenn der Client eine reservationId mitschickt,
      // muss sie noch leben. Wenn sie abgelaufen ist, prüfen wir den Slot direkt
      // gegen eTermin (großzügig — wenn frei, durchwinken; wenn belegt, 409).
      if (reservationId && !liveReservation) {
        try {
          const duration = state.pricing?.estimatedDurationMinutes || 60;
          const checkCalIds = Array.isArray(slot.eligibleCalendarIds) && slot.eligibleCalendarIds.length > 0
            ? slot.eligibleCalendarIds
            : [resolvedCalendarId];
          const liveResults = await Promise.all(checkCalIds.map(id =>
            etermin.getAvailableSlots(id, slot.date, duration, eterminServiceIds).catch(() => [])
          ));
          const stillAvailable = liveResults.some(slots => slots.some(s => s.start === slot.start));
          if (!stillAvailable) {
            return res.status(409).json({
              success: false,
              error: 'Deine Reservierung ist abgelaufen und der Slot wurde inzwischen vergeben. Bitte wähle einen anderen Termin.'
            });
          }
          console.log(`[booking] reservation ${reservationId} expired, but slot is still free — confirming anyway`);
        } catch (e) {
          console.warn('[booking] post-expire revalidation failed:', e.message);
        }
      }

      // Re-validate slot still available — auch wenn KEINE reservationId mitgeschickt
      // wurde (Legacy-Pfad oder voucher-direct). Wenn Reservation lebt, ist der
      // Slot für andere geblockt, dieser Check kann übersprungen werden.
      if (!liveReservation) {
        try {
          const duration = state.pricing?.estimatedDurationMinutes || 60;
          const checkCalIds = Array.isArray(slot.eligibleCalendarIds) && slot.eligibleCalendarIds.length > 0
            ? slot.eligibleCalendarIds
            : [resolvedCalendarId];
          const liveResults = await Promise.all(checkCalIds.map(id =>
            etermin.getAvailableSlots(id, slot.date, duration, eterminServiceIds).catch(() => [])
          ));
          const stillAvailable = liveResults.some(slots => slots.some(s => s.start === slot.start));
          if (!stillAvailable) {
            return res.status(409).json({
              success: false,
              error: 'Dieser Termin wurde leider gerade gebucht. Bitte wähle einen anderen.'
            });
          }
        } catch (e) {
          console.warn('[booking] re-validation skipped:', e.message);
        }
      }

      // Erstellt den eTermin-Kundentermin frisch via POST. Kein PUT mehr —
      // damit verschwindet auch der frühere PUT-„Felder werden auf default
      // gesetzt"-Bug und der Verify-Read-Retry-Loop.
      const result = await etermin.createAppointment({
        calendarId: resolvedCalendarId,
        start: startDateTime, end: endDateTime,
        customer: c, services: eterminServiceIds, notes,
        agbAccepted:        !!state.agbAccepted,
        privacyAccepted:    !!state.privacyAccepted,
        newsletter:         !!state.newsletterOptIn,
        feedbackPermission: !!state.feedbackOptIn,
        bike:               state.bike || {},
        payment:            state.payment || null,
        location:           appointmentLocation
      });

      // Memory-Reservierung freigeben — der eTermin-Termin ist jetzt der echte
      // Slot-Blocker. Idempotent (auch wenn schon abgelaufen).
      if (reservationId) reservations.release(reservationId);

      const eterminBookingId = result.ID || result.IID;

      // Persist to Airtable (fail-soft; doesn't block response)
      persistBookingToAirtable(state, eterminBookingId, req).catch(e => console.error('[analytics] async error:', e.message));

      // Sync auto-pause for this calendar+date (fail-soft)
      autoPause.syncAfterBooking(resolvedCalendarId, slot.date)
        .catch(e => console.error('[auto-pause] async error:', e.message));

      return res.json({
        success: true,
        bookingId: eterminBookingId || 'BK-' + Date.now().toString(36).toUpperCase(),
        message: 'Buchung erfolgreich! Du erhältst in Kürze eine Bestätigung per E-Mail.'
      });
    } catch (err) {
      console.error('eTermin booking error:', err.message);

      // Auto-refund + log failed booking to Airtable (never throws).
      const refund = await handleBookingFailureAfterPayment(state, err.message);

      // Tailor user message based on whether refund actually went through.
      const baseMsg = 'Dein Termin konnte leider nicht erstellt werden';
      let userError;
      if (refund.status === 'refunded') {
        userError = `${baseMsg}. Deine Anzahlung wurde automatisch zurückerstattet — sie sollte in 1–3 Werktagen auf deinem PayPal-Konto eingehen. Bitte versuche es noch einmal oder kontaktiere uns telefonisch.`;
      } else if (refund.status === 'failed') {
        userError = `${baseMsg}. Wir konnten deine Anzahlung nicht automatisch zurückerstatten und haben deinen Vorgang notiert — wir melden uns innerhalb eines Werktags telefonisch bei dir.`;
      } else {
        userError = `${baseMsg}. Bitte versuche es erneut oder kontaktiere uns telefonisch.`;
      }

      return res.status(500).json({
        success: false,
        error: userError,
        refundStatus: refund.status
      });
    }
  }

  // Fallback: Mock booking
  console.log('Mock booking confirmed:', {
    customer: `${c.vorname} ${c.name}`,
    email: c.email,
    bike: `${b.marke} ${b.modell}`,
    services: serviceNames,
    slot: `${startDateTime} - ${endDateTime}`,
    total: state.pricing?.total
  });

  // Persist to Airtable even in mock mode (useful for testing)
  persistBookingToAirtable(state, null, req).catch(e => console.error('[analytics] async error:', e.message));

  res.json({
    success: true,
    bookingId: 'BK-' + Date.now().toString(36).toUpperCase(),
    message: 'Buchung erfolgreich! Du erhältst in Kürze eine Bestätigung per E-Mail.'
  });
});

/**
 * Reserve a slot — IN-MEMORY (lib/reservations.js).
 *
 * Anders als früher legt diese Route KEINEN eTermin-Hold an. Der Slot wird nur
 * im Booking-Tool-Prozess für ~20 Min blockiert (siehe lib/reservations.js).
 * eTermin sieht die Reservierung nicht — erst der /confirm-Pfad legt nach
 * erfolgter Anzahlung den Kundentermin in eTermin an.
 *
 * Verlust bei pm2-Restart ist akzeptabel: betroffene User bekommen beim Confirm
 * eine kontrollierte Fehlermeldung.
 */
router.post('/reserve-slot', async (req, res) => {
  const { slot, serviceIds, geoEligible, sessionId } = req.body || {};
  if (!slot?.date || !slot?.start || !slot?.end) {
    return res.status(400).json({ success: false, error: 'Slot-Daten unvollständig' });
  }

  // Auflösung der konkreten Kalender-ID (gleiche Logik wie bisher):
  //   1. slot.calendarId direkt → genau dieser (Legacy / Single-Cal-Use Case)
  //   2. slot.eligibleCalendarIds → least-busy aus dem Set (Travel-Tie-Breaker)
  //   3. sonst Werkstatt-Default
  let calendarId = null;
  if (slot.calendarId) {
    calendarId = Number(slot.calendarId);
  } else if (Array.isArray(slot.eligibleCalendarIds) && slot.eligibleCalendarIds.length > 0) {
    const travelTimes = {};
    if (Array.isArray(geoEligible)) {
      for (const e of geoEligible) {
        if (e?.calendarId && Number.isFinite(e?.travelTimeMinutes)) {
          travelTimes[e.calendarId] = e.travelTimeMinutes;
        }
      }
    }
    calendarId = await pickLeastBusyFromSet(slot.date, slot.eligibleCalendarIds, { travelTimes });
  } else {
    calendarId = await pickLeastBusyWorkshopCalendar(slot.date);
    if (!calendarId) calendarId = await getDefaultCalendarId();
  }
  if (!calendarId) {
    return res.status(500).json({ success: false, error: 'Kein passender Kalender gefunden.' });
  }

  const services = Array.isArray(serviceIds) ? serviceIds.filter(Boolean) : [];

  try {
    const r = reservations.reserve({
      calendarId,
      date:  slot.date,
      start: slot.start,
      end:   slot.end,
      sessionId: sessionId || null,
      serviceIds: services,
      durationMinutes: slot.durationMinutes || null
    });
    if (!r) {
      return res.status(409).json({
        success: false,
        error: 'Dieser Slot wurde soeben von jemand anderem reserviert. Bitte wähle einen anderen Termin.'
      });
    }
    res.json({
      success: true,
      reservationId: r.id,
      expiresAt:    new Date(r.expiresAt).toISOString(),
      calendarId
    });
  } catch (err) {
    console.error('[booking] reserve-slot error:', err.message);
    res.status(500).json({ success: false, error: 'Slot konnte nicht reserviert werden. Bitte versuche es erneut.' });
  }
});

/**
 * Release a previously held reservation (Memory-Store).
 * Idempotent — kein Fehler wenn die Reservierung schon weg/abgelaufen ist.
 */
router.post('/release-slot', (req, res) => {
  const { reservationId } = req.body || {};
  if (!reservationId) return res.json({ success: true, released: false });
  const released = reservations.release(reservationId);
  res.json({ success: true, released });
});

async function getDefaultCalendarId() {
  const calendars = await etermin.listCalendars();
  const enabled = calendars.filter(c => c.Enabled !== false);
  return enabled[0]?.CalendarID;
}

module.exports = router;
