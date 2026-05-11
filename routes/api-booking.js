const express = require('express');
const router = express.Router();
const etermin = require('../lib/etermin');
const analytics = require('../lib/analytics');
const paypal = require('../lib/paypal');
const voucher = require('./api-voucher');
const { getActiveWorkshopCalendars } = require('../lib/calendars');
const autoPause = require('../lib/auto-pause');

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
 * Tie-broken by Priorität (asc).
 */
async function pickLeastBusyWorkshopCalendar(date) {
  const calendars = await getActiveWorkshopCalendars();
  if (calendars.length === 0) return null;
  if (calendars.length === 1) return calendars[0].id;

  const counts = await Promise.all(calendars.map(async cal => {
    try {
      const apps = await etermin.getAppointments(cal.id, date, date);
      return { id: cal.id, count: Array.isArray(apps) ? apps.length : 0, prio: cal.prio || 99 };
    } catch (err) {
      console.warn(`[booking] count error for cal ${cal.id}:`, err.message);
      return { id: cal.id, count: Number.MAX_SAFE_INTEGER, prio: cal.prio || 99 };
    }
  }));
  counts.sort((a, b) => (a.count - b.count) || (a.prio - b.prio));
  console.log('[booking] workshop load:', counts.map(c => `${c.id}=${c.count}`).join(', '), '→ chose', counts[0].id);
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

    // 2. Bike photo URL
    const bikePhotoUrl = state.bikePhoto?.filename
      ? filenameToPublicUrl(state.bikePhoto.filename, req)
      : null;

    // 3. Bike (always new)
    const bikeRecord = await analytics.createBike(
      customerRecord?.id,
      bike,
      state.vehicleType,
      bikePhotoUrl
    );

    // 4. Problem media URLs
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

  const c = state.customer || {};
  if (!c.vorname || !c.name || !c.email || !c.mobil) {
    return res.status(400).json({ success: false, error: 'Kundendaten unvollständig' });
  }

  const b = state.bike || {};
  if (!b.marke) {
    return res.status(400).json({ success: false, error: 'Fahrraddaten unvollständig' });
  }

  // Payment validation — either a real PayPal capture OR a valid voucher code.
  // The voucher path skips PayPal entirely (no money flow), but still requires
  // a server-side check so a manipulated frontend can't fake it.
  const p = state.payment || {};
  if (p.method === 'voucher') {
    if (!voucher.isValidVoucher(p.code)) {
      return res.status(400).json({ success: false, error: 'Gutscheincode ungültig.' });
    }
    // Normalize so downstream code (etermin appattrib, Airtable) treats it
    // identically to a paid deposit.
    state.payment = {
      method: 'voucher',
      code: String(p.code).trim().toUpperCase(),
      amount: 20,
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
  const bikePhotoUrl = fileUrl(state.bikePhoto?.filename);
  if (bikePhotoUrl) mediaLines.push(`Bike-Foto: ${bikePhotoUrl}`);
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
    state.address ? state.address : null
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

      // Resolve calendar:
      //   - mobile flow: slot.calendarId is set (server-picked at address-check time)
      //   - werkstatt flow: pick the least-busy active workshop calendar for that date
      let resolvedCalendarId = slot.calendarId;
      if (!resolvedCalendarId) {
        resolvedCalendarId = await pickLeastBusyWorkshopCalendar(slot.date);
        if (!resolvedCalendarId) resolvedCalendarId = await getDefaultCalendarId();
      }

      // Re-validate slot still available (race-condition guard) — only if local engine is in use
      try {
        const duration = state.pricing?.estimatedDurationMinutes || 60;
        const liveSlots = await etermin.getAvailableSlots(resolvedCalendarId, slot.date, duration, eterminServiceIds);
        const stillAvailable = liveSlots.some(s => s.start === slot.start);
        if (!stillAvailable) {
          return res.status(409).json({
            success: false,
            error: 'Dieser Termin wurde leider gerade gebucht. Bitte wähle einen anderen.'
          });
        }
      } catch (e) {
        console.warn('[booking] re-validation skipped:', e.message);
      }

      const result = await etermin.createAppointment({
        calendarId: resolvedCalendarId,
        start: startDateTime,
        end: endDateTime,
        customer: c,
        services: eterminServiceIds,
        notes,
        agbAccepted:        !!state.agbAccepted,
        privacyAccepted:    !!state.privacyAccepted,
        newsletter:         !!state.newsletterOptIn,
        feedbackPermission: !!state.feedbackOptIn,
        bike:               state.bike || {},
        payment:            state.payment || null,
        location:           appointmentLocation
      });

      console.log('eTermin appointment created:', result);

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

async function getDefaultCalendarId() {
  const calendars = await etermin.listCalendars();
  const enabled = calendars.filter(c => c.Enabled !== false);
  return enabled[0]?.CalendarID;
}

module.exports = router;
