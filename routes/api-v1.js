/**
 * Externe Buchungs-API v1 — Server-zu-Server REST-API, mit der eine andere
 * Software Buchungen einstellen kann.
 *
 * Auth:   Bearer-Token via Env `EXTERNAL_API_TOKEN`.
 * CORS:   bewusst KEINS — reiner Server-zu-Server-Zugriff (wie api-portal.js).
 * Doku:   OpenAPI-Spec unter /openapi.json, Swagger-UI unter /docs (beide ohne Auth).
 *
 * Anders als der Web-Flow (/api/booking/confirm) verlangt diese API KEINE
 * Anzahlung und keine Slot-Reservierung. Sie kann sowohl Katalog-Leistungen
 * (per Airtable-Record-ID) als auch frei definierte Positionen buchen.
 */

const path = require('path');
const express = require('express');
const router = express.Router();

const etermin = require('../lib/etermin');
const catalog = require('../lib/catalog');
const pricing = require('../lib/pricing');
const { getActiveWorkshopCalendars } = require('../lib/calendars');
const { createBookingFromState } = require('../lib/booking-core');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.json');

// ─── Public docs (vor der Auth-Middleware) ──────────────────────────────────

router.get('/openapi.json', (req, res) => {
  res.sendFile(OPENAPI_PATH, err => {
    if (err) res.status(500).json({ error: 'OpenAPI-Spec nicht gefunden' });
  });
});

router.get('/docs', (req, res) => {
  // Swagger-UI via CDN. Relative Spec-URL → funktioniert auch unter /booking-Prefix.
  res.type('html').send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spoxhub Booking API — Doku</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: './openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    };
  </script>
</body>
</html>`);
});

// ─── Bearer-Auth ─────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  const expected = process.env.EXTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'EXTERNAL_API_TOKEN not configured on server' });
  }
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function publicBaseFromReq(req) {
  return (process.env.PUBLIC_BASE_URL
    || `${req.protocol}://${req.get('host')}${(req.baseUrl || '').replace(/\/api.*$/, '')}`
  ).replace(/\/$/, '');
}

/**
 * Resolve calendar IDs for read endpoints (availability/slots).
 *   - explicit ?calendarId=  → genau dieser
 *   - sonst → alle aktiven Werkstatt-Kalender
 */
async function resolveReadCalendarIds(calendarId) {
  if (calendarId) return [Number(calendarId)].filter(Number.isFinite);
  const workshops = await getActiveWorkshopCalendars();
  return workshops.sort((a, b) => (a.prio || 99) - (b.prio || 99)).map(w => w.id);
}

/**
 * Map the external API payload → internal booking `state`, dabei Leistungen
 * (Katalog-IDs + freie Positionen) zu Line-Items / Preisen auflösen.
 *
 * @returns {Promise<{ state: object } | { error: string }>}
 */
async function buildStateFromPayload(payload) {
  const vehicleType = (payload.vehicleType || 'ebike').toLowerCase();
  const locationType = payload.locationType || 'werkstatt';

  const servicesIn = Array.isArray(payload.services) ? payload.services : [];
  if (servicesIn.length === 0) {
    return { error: 'Keine Leistungen angegeben (services).' };
  }

  // 1. Katalog-Positionen (mit catalogId) und freie Positionen trennen
  const catalogEntries = servicesIn.filter(s => s && s.catalogId);
  const freeEntries    = servicesIn.filter(s => s && !s.catalogId);

  const lineItems = [];

  // 2. Katalog-Positionen über die bestehende Preis-Engine auflösen
  if (catalogEntries.length > 0) {
    const serviceIds = catalogEntries.map(s => String(s.catalogId));
    const quantities = {};
    for (const s of catalogEntries) quantities[String(s.catalogId)] = Number(s.quantity) || 1;

    const calc = await pricing.calculatePricing({
      serviceIds,
      quantities,
      vehicleType,
      locationType,
      travelTimeMinutes: payload.pricing?.travelTimeMinutes ?? null
    });

    // Unbekannte Katalog-IDs erkennen (calculatePricing überspringt sie still)
    const resolvedIds = new Set(calc.lineItems.map(i => i.id));
    const missing = serviceIds.filter(id => !resolvedIds.has(id));
    if (missing.length > 0) {
      return { error: `Unbekannte Katalog-Leistung(en): ${missing.join(', ')}` };
    }

    lineItems.push(...calc.lineItems);
    // Preis-Eckdaten der Katalog-Berechnung für später merken
    payload.__calc = calc;
  }

  // 3. Freie Positionen direkt übernehmen
  for (const f of freeEntries) {
    if (!f.name) return { error: 'Freie Leistung ohne "name".' };
    const qty = Number(f.quantity) || 1;
    const unitPrice = Number(f.price) || 0;
    const material = Number(f.materialPrice) || 0;
    const duration = Number(f.durationMinutes) || 30;
    lineItems.push({
      id: f.id || `free:${f.name}`,
      name: f.name,
      bereich: f.bereich || 'Sonstiges',
      quantity: qty,
      unitPrice,
      price: (unitPrice + material) * qty,
      workPrice: unitPrice * qty,
      materialPrice: material * qty,
      duration: duration * qty,
      eterminId: f.eterminId || null,
      includedInInspektion: false,
      isCustom: true
    });
  }

  // 4. Preise zusammenführen (Payload-Override hat Vorrang)
  const calc = payload.__calc || null;
  const freeSum = lineItems.filter(i => i.isCustom).reduce((s, i) => s + i.price, 0);
  const computedTotal = (calc?.total ?? 0) + freeSum;
  const total = payload.pricing?.total != null ? Number(payload.pricing.total) : Math.round(computedTotal * 100) / 100;
  const travelFee = payload.pricing?.travelFee != null
    ? Number(payload.pricing.travelFee)
    : (calc?.travelFee ?? 0);
  const estimatedDurationMinutes = lineItems.reduce((s, i) => s + (i.duration || 0), 0);

  // 5. Slot
  const slotIn = payload.slot || {};
  const selectedSlot = {
    date: slotIn.date,
    start: slotIn.start,
    end: slotIn.end
  };
  if (payload.calendarId) selectedSlot.calendarId = Number(payload.calendarId);

  // 6. Adresse / Service-Ort
  const loc = payload.serviceLocation || {};
  const addressFields = {
    street: loc.street || undefined,
    plz:    loc.plz || undefined,
    city:   loc.city || undefined
  };

  // 7. Consent / Payment normalisieren
  const consent = payload.consent || {};
  const payment = payload.payment ? {
    method: payload.payment.method || 'external',
    amount: payload.payment.amount != null ? Number(payload.payment.amount) : undefined,
    status: payload.payment.status || undefined,
    orderId: payload.payment.orderId || undefined,
    captureId: payload.payment.captureId || undefined,
    code: payload.payment.code || undefined
  } : null;

  const state = {
    vehicleType,
    serviceType: payload.serviceType || undefined,
    locationType,
    selectedServices: lineItems,
    pricing: {
      lineItems,
      total,
      travelFee,
      estimatedDurationMinutes,
      inspektionOverage: calc?.inspektionOverage || null
    },
    problemDescription: payload.problemDescription || undefined,
    bike: payload.bike || {},
    customer: payload.customer || {},
    address: loc.address || undefined,
    addressNotes: loc.notes || undefined,
    addressFields,
    selectedSlot,
    agbAccepted: !!consent.agb,
    privacyAccepted: !!consent.privacy,
    newsletterOptIn: !!consent.newsletter,
    feedbackOptIn: !!consent.feedback,
    depositPaid: payment?.status === 'completed',
    payment,
    problemMediaUrls: Array.isArray(payload.problemMedia) ? payload.problemMedia.filter(Boolean) : [],
    sessionId: payload.sessionId || null
  };

  return { state };
}

// ─── POST /bookings ──────────────────────────────────────────────────────────

router.post('/bookings', async (req, res) => {
  const payload = req.body || {};

  // ── Validierung (Spiegel des Web-Flows) ──
  const slot = payload.slot || {};
  if (!slot.date || !slot.start || !slot.end) {
    return res.status(400).json({ success: false, error: 'Slot unvollständig (slot.date/start/end erforderlich).' });
  }
  if (!Array.isArray(payload.services) || payload.services.length === 0) {
    return res.status(400).json({ success: false, error: 'Keine Leistungen gewählt (services).' });
  }
  const c = payload.customer || {};
  if (!c.vorname || !c.name || !c.email || !c.mobil) {
    return res.status(400).json({ success: false, error: 'Kundendaten unvollständig (vorname, name, email, mobil erforderlich).' });
  }
  if (payload.serviceType === 'aufbau' && payload.locationType !== 'werkstatt') {
    return res.status(400).json({ success: false, error: 'Aufbau-Termine sind nur in der Werkstatt möglich.' });
  }
  if (!process.env.ETERMIN_PUBLIC_KEY || !process.env.ETERMIN_PRIVATE_KEY) {
    return res.status(503).json({ success: false, error: 'eTermin ist serverseitig nicht konfiguriert.' });
  }

  // ── Payload → State ──
  const built = await buildStateFromPayload(payload);
  if (built.error) {
    return res.status(400).json({ success: false, error: built.error });
  }

  // ── Buchung anlegen ──
  try {
    const result = await createBookingFromState(built.state, {
      publicBase: publicBaseFromReq(req),
      calendarId: payload.calendarId ? Number(payload.calendarId) : null,
      // Externe API bucht standardmäßig OHNE Kollisionsprüfung (Overbooking auf
      // belegte Slots erlaubt). Mit "allowOverbooking": false kann die Dritt-
      // Software die eTermin-Prüfung pro Buchung wieder aktivieren.
      allowOverbooking: payload.allowOverbooking !== false
    });

    return res.status(201).json({
      success: true,
      bookingId: result.eterminBookingId,
      bookingRef: result.airtable?.bookingRecord?.fields?.BookingRef || null,
      airtableRecordId: result.airtable?.bookingRecord?.id || null,
      calendarId: result.calendarId,
      status: 'confirmed'
    });
  } catch (err) {
    console.error('[api-v1] booking error:', err.message);
    return res.status(502).json({
      success: false,
      error: 'Buchung konnte nicht erstellt werden.',
      detail: err.message
    });
  }
});

// ─── GET /catalog ────────────────────────────────────────────────────────────

router.get('/catalog', async (req, res) => {
  try {
    const vehicleType = (req.query.vehicleType || 'ebike').toLowerCase();
    const data = await catalog.getCatalogForVehicle(vehicleType);
    res.json(data);
  } catch (err) {
    console.error('[api-v1] catalog error:', err.message);
    res.status(500).json({ error: 'Katalog konnte nicht geladen werden.' });
  }
});

// ─── GET /calendars ──────────────────────────────────────────────────────────

router.get('/calendars', async (req, res) => {
  try {
    const calendars = await etermin.listCalendars();
    res.json(calendars.map(c => ({
      id: c.CalendarID,
      name: c.CalendarName,
      slotMinutes: c.TimeSlotMinutes,
      enabled: c.Enabled
    })));
  } catch (err) {
    console.error('[api-v1] calendars error:', err.message);
    res.status(500).json({ error: 'Kalender konnten nicht geladen werden.' });
  }
});

// ─── GET /availability ───────────────────────────────────────────────────────

router.get('/availability', async (req, res) => {
  const { year, month, duration, calendarId } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: 'year und month erforderlich' });
  }
  try {
    const calIds = await resolveReadCalendarIds(calendarId);
    if (calIds.length === 0) return res.json([]);

    const serviceIdList = req.query.serviceIds ? String(req.query.serviceIds).split(',').map(Number).filter(Boolean) : [];
    const dur = parseInt(duration) || 60;

    const perCal = await Promise.all(calIds.map(id =>
      etermin.getMonthAvailability(id, parseInt(year), parseInt(month), dur, serviceIdList).catch(() => [])
    ));

    const byDate = new Map();
    for (const arr of perCal) {
      for (const d of (arr || [])) {
        const prev = byDate.get(d.date);
        if (!prev) {
          byDate.set(d.date, { date: d.date, available: !!d.available, slotCount: d.slotCount || 0 });
        } else {
          prev.available = prev.available || !!d.available;
          prev.slotCount = Math.max(prev.slotCount, d.slotCount || 0);
        }
      }
    }
    res.json([...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)));
  } catch (err) {
    console.error('[api-v1] availability error:', err.message);
    res.status(500).json({ error: 'Verfügbarkeit konnte nicht geladen werden.' });
  }
});

// ─── GET /slots ──────────────────────────────────────────────────────────────

router.get('/slots', async (req, res) => {
  const { date, duration, calendarId } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'date erforderlich' });
  }
  try {
    const calIds = await resolveReadCalendarIds(calendarId);
    if (calIds.length === 0) return res.json([]);

    const serviceIdList = req.query.serviceIds ? String(req.query.serviceIds).split(',').map(Number).filter(Boolean) : [];
    const dur = parseInt(duration) || 60;

    const perCal = await Promise.all(calIds.map(id =>
      etermin.getAvailableSlots(id, date, dur, serviceIdList)
        .then(slots => ({ id, slots: slots || [] }))
        .catch(() => ({ id, slots: [] }))
    ));

    const slotMap = new Map();
    for (const { id, slots } of perCal) {
      for (const s of slots) {
        const key = `${s.start}-${s.end}`;
        if (!slotMap.has(key)) slotMap.set(key, { ...s, eligibleCalendarIds: [] });
        slotMap.get(key).eligibleCalendarIds.push(id);
      }
    }
    res.json([...slotMap.values()].sort((a, b) => a.start.localeCompare(b.start)));
  } catch (err) {
    console.error('[api-v1] slots error:', err.message);
    res.status(500).json({ error: 'Slots konnten nicht geladen werden.' });
  }
});

// ─── GET /customers — Bestandskunden aus eTermin abfragen ─────────────────────

/**
 * eTermin-Kontakt → normalisiertes Kunden-Objekt (Stammdaten + letztes Fahrrad).
 * Die Additional-Felder folgen der Belegung aus etermin.createAppointment:
 *   Additional1=Hersteller, 2=Modell, 3=Rahmennummer,
 *   4=Leasinggeber, 5=Leasing-Vertragsnr, 16=Versicherung, 17=Versicherungs-Vertragsnr
 */
function mapContact(c) {
  const v = x => (x === undefined || x === null || x === '') ? undefined : x;
  return {
    customer: {
      anrede:   v(c.Salutation) || v(c.Title),
      vorname:  v(c.FirstName),
      name:     v(c.LastName),
      email:    v(c.Email),
      mobil:    v(c.Phone),
      strasse:  v(c.Street),
      plz:      v(c.ZIP),
      ort:      v(c.City),
      company:  v(c.Company),
      birthday: v(c.Birthday)
    },
    bike: {
      marke:          v(c.Additional1),
      modell:         v(c.Additional2),
      rahmennummer:   v(c.Additional3),
      leasing:        v(c.Additional4),
      leasingNr:      v(c.Additional5),
      versicherung:   v(c.Additional16),
      versicherungNr: v(c.Additional17)
    },
    etermin: {
      cid:                 v(c.cid),
      externalId:          v(c.ExternalID),
      customerNumber:      v(c.CustomerNumber),
      creationDate:        v(c.CreationDate),
      lastAppointmentDate: v(c.LastAppointmentDate),
      newsletter:          !!c.Newsletter
    }
  };
}

router.get('/customers', async (req, res) => {
  const { email, name } = req.query;
  if (!email && !name) {
    return res.status(400).json({ error: 'Parameter email oder name erforderlich.' });
  }
  if (!process.env.ETERMIN_PUBLIC_KEY || !process.env.ETERMIN_PRIVATE_KEY) {
    return res.status(503).json({ error: 'eTermin ist serverseitig nicht konfiguriert.' });
  }
  try {
    // E-Mail: exakter Einzeltreffer (serverseitiger Filter)
    if (email) {
      const c = await etermin.findContactByEmail(email);
      if (!c) return res.status(404).json({ found: false, error: 'Kein Kontakt mit dieser E-Mail gefunden.' });
      return res.json({ found: true, match: mapContact(c) });
    }
    // Name: Teilsuche (gecachte Vollliste), 0..n Treffer
    const list = await etermin.searchContactsByName(name);
    return res.json({ found: list.length > 0, count: list.length, results: list.map(mapContact) });
  } catch (err) {
    console.error('[api-v1] customers error:', err.message);
    return res.status(502).json({ error: 'Kundendaten konnten nicht abgefragt werden.', detail: err.message });
  }
});

module.exports = router;
