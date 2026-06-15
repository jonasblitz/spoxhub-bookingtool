const express = require('express');
const router = express.Router();
const etermin = require('../lib/etermin');
const analytics = require('../lib/analytics');
const paypal = require('../lib/paypal');
const voucher = require('./api-voucher');
const autoPause = require('../lib/auto-pause');
const config = require('../lib/config');
const reservations = require('../lib/reservations');
const bookingCore = require('../lib/booking-core');
const {
  pickLeastBusyWorkshopCalendar,
  pickLeastBusyFromSet,
  getDefaultCalendarId,
  persistBookingToAirtable,
  buildEterminNotes,
  buildAppointmentLocation
} = bookingCore;

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

// Build the public base URL for /uploads/ links (Airtable attachments, eTermin
// notes). Prefers PUBLIC_BASE_URL env; falls back to the request host.
function publicBaseFromReq(req) {
  return (process.env.PUBLIC_BASE_URL
    || `${req.protocol}://${req.get('host')}${(req.baseUrl || '').replace(/\/api.*$/, '')}`
  ).replace(/\/$/, '');
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
  const PUBLIC_BASE = publicBaseFromReq(req);
  const notes = buildEterminNotes(state, { publicBase: PUBLIC_BASE });

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
      const appointmentLocation = buildAppointmentLocation(state);

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
      persistBookingToAirtable(state, eterminBookingId, { publicBase: PUBLIC_BASE }).catch(e => console.error('[analytics] async error:', e.message));

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
  persistBookingToAirtable(state, null, { publicBase: publicBaseFromReq(req) }).catch(e => console.error('[analytics] async error:', e.message));

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

module.exports = router;
