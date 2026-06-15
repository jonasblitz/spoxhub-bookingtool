/**
 * Booking Core — gemeinsame Buchungs-Logik für den Web-Flow
 * (routes/api-booking.js → /confirm) und die externe REST-API
 * (routes/api-v1.js → POST /bookings).
 *
 * Hier liegen die reinen, von Express entkoppelten Bausteine:
 *   - Kalender-Auswahl (least-busy)
 *   - Aufbau der strukturierten eTermin-Notizen
 *   - Persistenz nach Airtable (Customer/Bike/Booking/Session)
 *   - createBookingFromState(): High-Level-Orchestrator für die externe API
 *
 * Bewusst KEINE Reservierungs-/PayPal-Logik — die bleibt web-spezifisch im
 * /confirm-Handler. Diese Funktionen sind verhaltensgleich aus api-booking.js
 * extrahiert.
 */

const etermin = require('./etermin');
const analytics = require('./analytics');
const autoPause = require('./auto-pause');
const { getActiveWorkshopCalendars, loadCalendars } = require('./calendars');
const reservations = require('./reservations');

// ─────────────────────────────────────────────────────────────────────────────
// Kalender-Auswahl
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the workshop calendar with the lowest appointment count for a given date.
 * Tie-broken by Priorität (asc).
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

async function getDefaultCalendarId() {
  const calendars = await etermin.listCalendars();
  const enabled = calendars.filter(c => c.Enabled !== false);
  return enabled[0]?.CalendarID;
}

/**
 * Resolve the concrete eTermin calendar ID for a booking state.
 *
 * Priorität:
 *   1. Lebende Memory-Reservierung (state.reservation.id) ist autoritativ
 *   2. state.reservation.slot.calendarId / slot.calendarId
 *   3. slot.eligibleCalendarIds → least-busy aus dem Set (Travel-Tie-Breaker
 *      aus state.geoResult.eligible)
 *   4. least-busy Werkstatt-Kalender
 *   5. erster aktiver Kalender (Default)
 */
async function resolveCalendarId(state) {
  const slot = state.selectedSlot || {};
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
  return resolvedCalendarId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notizen-Formatierung (strukturierter eTermin-Notes-Block)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the structured "══ … ══" notes block written into the eTermin
 * appointment. Identisch zum bisherigen Web-Flow.
 *
 * @param {object} state          Booking-State
 * @param {object} [opts]
 * @param {string} [opts.publicBase]  Basis-URL für Upload-Links (ohne trailing slash)
 */
function buildEterminNotes(state, { publicBase = '' } = {}) {
  const c = state.customer || {};
  const b = state.bike || {};

  const vehicleLabel  = state.vehicleType === 'ebike' ? 'E-Bike' : 'Cargobike';
  const locationLabels = { mobil: 'Mobil', anderer_ort: 'Anderer Ort', werkstatt: 'Werkstatt' };
  const fmtEur = n => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const PUBLIC_BASE = (publicBase || '').replace(/\/$/, '');
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

  // 4. Fotos / Videos (only if any) — Upload-Dateien ODER direkte URLs (API)
  const mediaLines = [];
  (state.uploadedFiles || []).forEach((f, i) => {
    const u = fileUrl(f.filename);
    if (u) mediaLines.push(`Problem ${i + 1}: ${u}`);
  });
  (state.problemMediaUrls || []).forEach((u, i) => {
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

  return sections.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Anfahrt-/Service-Adresse für den eTermin-Termin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service location for the eTermin appointment: for mobile service the customer
 * address; for werkstatt empty (eTermin keeps the calendar's default location).
 */
function buildAppointmentLocation(state) {
  if (state.locationType === 'werkstatt') return '';
  const c = state.customer || {};
  const a = state.addressFields || {};
  const street = a.street || c.strasse || '';
  const plz    = a.plz    || c.plz    || '';
  const city   = a.city   || c.ort    || '';
  return `${street}, ${plz} ${city}`
    .replace(/^,\s*/, '')
    .replace(/\s+,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Airtable-Persistenz
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write booking + customer + bike + session completion to Airtable (fail-soft).
 * Liefert die Airtable-Records zurück (oder null bei nicht-konfiguriert / Fehler).
 *
 * @param {object} state
 * @param {string|number|null} eterminBookingId
 * @param {object} [opts]
 * @param {string} [opts.publicBase]  Basis-URL für Upload-Links
 */
async function persistBookingToAirtable(state, eterminBookingId, { publicBase = '' } = {}) {
  if (!analytics.isConfigured()) return null;

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

    // 3. Problem media URLs — Upload-Dateien (Web) oder direkte URLs (API)
    const base = (publicBase || '').replace(/\/$/, '');
    const problemMediaUrls = [
      ...(state.uploadedFiles || [])
        .map(f => f.filename ? `${base}/uploads/${f.filename}` : null),
      ...(state.problemMediaUrls || [])
    ].filter(Boolean);

    // 4. Booking
    const bookingRecord = await analytics.createBooking({
      customerRecordId: customerRecord?.id,
      bikeRecordId: bikeRecord?.id,
      state,
      eterminBookingId,
      problemMediaUrls
    });

    // 5. Complete session
    if (state.sessionId) {
      await analytics.completeSession(state.sessionId, bookingRecord?.id, customerRecord?.id);
    }

    console.log('[analytics] booking persisted:', {
      customerId: customerRecord?.id,
      bikeId: bikeRecord?.id,
      bookingId: bookingRecord?.id
    });
    return { customerRecord, bikeRecord, bookingRecord };
  } catch (err) {
    // Airtable failure shouldn't block successful eTermin booking
    console.error('[analytics] persist error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// High-Level-Orchestrator (für die externe REST-API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a booking end-to-end from a normalized booking state: eTermin-Termin
 * anlegen → Airtable persistieren → Auto-Pause syncen.
 *
 * Anders als der Web-/confirm-Flow gibt es hier KEINE Reservierungs- oder
 * PayPal-Validierung — die externe API bucht direkt. Slot-Daten (date/start/end)
 * werden als autoritativ angenommen.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {string} [opts.publicBase]   Basis-URL für Upload-/Media-Links
 * @param {number} [opts.calendarId]   Vorgegebener Kalender (sonst Auto-Resolve)
 * @returns {Promise<{ eterminBookingId: (string|number|null), calendarId: number, airtable: object|null }>}
 */
async function createBookingFromState(state, { publicBase = '', calendarId = null } = {}) {
  const c = state.customer || {};
  const slot = state.selectedSlot || {};

  // eTermin-Service-IDs (unique, comma-separated downstream)
  const eterminServiceIds = [
    ...new Set((state.selectedServices || [])
      .map(s => s.eterminId)
      .filter(Boolean))
  ];

  const resolvedCalendarId = calendarId || await resolveCalendarId(state);
  if (!resolvedCalendarId) {
    throw new Error('Kein passender Kalender gefunden.');
  }

  const notes = buildEterminNotes(state, { publicBase });
  const appointmentLocation = buildAppointmentLocation(state);

  const startDateTime = `${slot.date} ${slot.start}`;
  const endDateTime   = `${slot.date} ${slot.end}`;

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

  const eterminBookingId = result.ID || result.IID || null;

  // Persist to Airtable (fail-soft)
  const airtable = await persistBookingToAirtable(state, eterminBookingId, { publicBase });

  // Sync auto-pause for this calendar+date (fail-soft, non-blocking)
  autoPause.syncAfterBooking(resolvedCalendarId, slot.date)
    .catch(e => console.error('[auto-pause] async error:', e.message));

  return {
    eterminBookingId,
    calendarId: Number(resolvedCalendarId),
    airtable
  };
}

module.exports = {
  pickLeastBusyWorkshopCalendar,
  pickLeastBusyFromSet,
  getDefaultCalendarId,
  resolveCalendarId,
  buildEterminNotes,
  buildAppointmentLocation,
  persistBookingToAirtable,
  createBookingFromState
};
