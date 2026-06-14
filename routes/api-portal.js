/**
 * Portal API — Server-to-Server-Endpoints für das Spoxhub-Portal.
 *
 * Architektur (seit Mai 2026):
 *   - eTermin ist Source of Truth für die Terminliste (Kalender, Start, Dauer)
 *   - Airtable ist Enrichment für eigene Buchungen via Booking-Tool
 *     (PayPal, Storno-Log, reicheres Customer/Bike-Profil)
 *   - Termine ohne ExternalID (manuell in eTermin, Mittagspausen, alte Daten)
 *     erscheinen als "etermin-only" — read-only, kein Storno-Button.
 *
 * Auth: Bearer-Token via Env `PORTAL_API_TOKEN`.
 * Bewusst KEIN CORS — nur server-seitige Aufrufe aus dem Portal-Backend.
 */

const express = require('express');
const router = express.Router();
const paypal = require('../lib/paypal');
const etermin = require('../lib/etermin');
const { loadCalendars, updateCalendarFields, invalidateCache: invalidateCalendarsCache } = require('../lib/calendars');
const config = require('../lib/config');
const catalog = require('../lib/catalog');

const BASE_URL = 'https://api.airtable.com/v0';

function airtableConfig() {
  return {
    token:    process.env.AIRTABLE_TOKEN,
    baseId:   process.env.AIRTABLE_BASE_ID,
    bookings: process.env.AIRTABLE_BOOKINGS_TABLE,
    customers: process.env.AIRTABLE_CUSTOMERS_TABLE,
    bikes:    process.env.AIRTABLE_BIKES_TABLE
  };
}

async function airtable(method, table, pathOrQuery = '', body = null, { typecast = false } = {}) {
  const { token, baseId } = airtableConfig();
  if (!token || !baseId) throw new Error('Airtable not configured');
  const url = `${BASE_URL}/${baseId}/${table}${pathOrQuery}`;
  const payload = body ? (typecast ? { ...body, typecast: true } : body) : null;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
    const err = new Error(`Airtable ${method} ${url} → ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── Bearer-Auth ────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  const expected = process.env.PORTAL_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'PORTAL_API_TOKEN not configured on server' });
  }
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}

function pickCustomerFields(rec) {
  const f = rec?.fields || {};
  return {
    id: rec?.id,
    email: f.Email || null,
    anrede: f.Anrede || null,
    vorname: f.Vorname || null,
    nachname: f.Nachname || null,
    mobil: f.Mobil || null
  };
}

function pickBikeFields(rec) {
  const f = rec?.fields || {};
  return {
    id: rec?.id,
    label: f.Label || null,
    marke: f.Marke || null,
    modell: f.Modell || null
  };
}

async function fetchRelatedById(table, recordIds = []) {
  if (!recordIds.length) return [];
  const ors = recordIds.map(id => `RECORD_ID()='${escapeFormulaString(id)}'`).join(',');
  const filter = recordIds.length === 1 ? ors : `OR(${ors})`;
  const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=${Math.min(recordIds.length, 100)}`;
  const data = await airtable('GET', table, params);
  return data.records || [];
}

/**
 * Find Airtable Booking records matching the given eTermin ExternalIDs
 * (which we store as `EterminBookingID`). Chunks the OR-clause to keep
 * the formula length under Airtable's limit.
 */
async function fetchAirtableBookingsByExternalIds(externalIds) {
  const { bookings } = airtableConfig();
  if (!bookings || !externalIds.length) return [];
  const CHUNK = 30;
  const out = [];
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const slice = externalIds.slice(i, i + CHUNK);
    const ors = slice.map(id => `{EterminBookingID}='${escapeFormulaString(id)}'`).join(',');
    const filter = slice.length === 1 ? ors : `OR(${ors})`;
    const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=${Math.min(slice.length, 100)}`;
    try {
      const data = await airtable('GET', bookings, params);
      out.push(...(data.records || []));
    } catch (err) {
      console.warn('[portal] airtable bookings lookup failed:', err.message);
    }
  }
  return out;
}

/**
 * Heuristic: is this eTermin entry a workshop blocker (Mittagspause,
 * Auto Mittagspause, "Radblitz Base", etc.) rather than a customer
 * appointment? Used to grey them out in the day timeline.
 */
const BLOCKER_REGEX = /(mittagspause|pause|base|blocker|abwesenheit|frei|urlaub|feiertag|krank)/i;
function detectBlocker(apt) {
  const fullName = [apt.FirstName, apt.LastName, apt.Title].filter(Boolean).join(' ').trim();
  if (!fullName) return !apt.Email; // no customer info at all → blocker
  if (!apt.Email && BLOCKER_REGEX.test(fullName)) return true;
  return false;
}

function customerFromETermin(apt) {
  if (!apt.Email && !apt.FirstName && !apt.LastName) return null;
  return {
    id: null,
    email: apt.Email || null,
    anrede: apt.Salutation || null,
    vorname: apt.FirstName || null,
    nachname: apt.LastName || null,
    mobil: apt.Phone || null
  };
}

function durationFromETermin(apt) {
  if (!apt.StartDateTimeUTC || !apt.EndDateTimeUTC) return null;
  const diff = (new Date(apt.EndDateTimeUTC).getTime() - new Date(apt.StartDateTimeUTC).getTime()) / 60000;
  return Number.isFinite(diff) && diff > 0 ? Math.round(diff) : null;
}

/**
 * Merge an eTermin appointment with optional Airtable enrichment into the
 * Booking shape exposed to the portal.
 */
function mergeAppointment(apt, calendarName, enrichment) {
  const af = enrichment?.record?.fields || {};
  const eterminBookingId = apt.ExternalID ? String(apt.ExternalID) : null;
  const isBlocker = detectBlocker(apt);

  return {
    // Stable IDs
    id: String(apt.ID),
    airtableId: enrichment?.record?.id || null,
    eterminBookingId,
    bookingRef: af.BookingRef || null,

    // Schedule (eTermin is truth)
    selectedSlot: apt.StartDateTimeUTC ? `${apt.StartDateTimeUTC}Z` : null,
    durationMinutes: durationFromETermin(apt),
    calendarName,

    // Classification
    isBlocker,
    source: enrichment ? 'airtable-merged' : 'etermin',

    // Customer / bike — Airtable wins; eTermin as fallback for non-Airtable apts
    customer: enrichment?.customer || customerFromETermin(apt),
    bike: enrichment?.bike || null,

    // Services
    serviceType: af.ServiceType || null,
    services: af.Services || apt.ServicesText || null,
    serviceIds: af.ServiceIDs || null,
    problemDescription: af.ProblemDescription || null,
    locationType: af.LocationType || null,
    address: af.Address || apt.Street || null,

    // Pricing
    estimatedPrice: af.EstimatedPrice ?? null,
    travelFee: af.TravelFee ?? null,
    depositAmount: af.DepositAmount ?? null,
    depositPaid: !!af.DepositPaid,

    // Payment (Airtable only)
    payPalOrderId: af.PayPalOrderID || null,
    payPalCaptureId: af.PayPalCaptureID || null,

    // Status / audit (Airtable only — null for eTermin-only)
    status: af.Status || null,
    cancellationReason: af.CancellationReason || null,
    cancellationLog: af.CancellationLog || null,
    createdAt: af.CreatedAt || null
  };
}

// ─── GET /api/portal/bookings ──────────────────────────────────────────────

router.get('/bookings', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from + to required (ISO datetime)' });
    }

    // 1) Load all calendars (incl. inactive — historical bookings may live there)
    const calendars = await loadCalendars();
    const cals = calendars.filter(c => Number.isFinite(c.id));
    if (!cals.length) return res.json({ bookings: [] });

    // 2) Query each calendar from eTermin, padded ±1 day around the window
    const padDate = (iso, days) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const fromDate = padDate(from, -1);
    const toDate = padDate(to, 1);

    const allAptsTagged = (await Promise.all(cals.map(async cal => {
      try {
        const apts = await etermin.getAppointments(cal.id, fromDate, toDate);
        return (apts || []).map(apt => ({ apt, calendarName: cal.name }));
      } catch (err) {
        console.warn(`[portal] eTermin getAppointments cal=${cal.id}:`, err.message);
        return [];
      }
    }))).flat();

    // 3) Filter to the exact requested window (UTC compare)
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const inWindow = allAptsTagged.filter(({ apt }) => {
      if (!apt.StartDateTimeUTC) return false;
      const ms = new Date(`${apt.StartDateTimeUTC}Z`).getTime();
      return ms >= fromMs && ms < toMs;
    });

    // 4) Enrich with Airtable for appointments where we have an ExternalID
    const externalIds = [...new Set(inWindow
      .map(({ apt }) => apt.ExternalID && String(apt.ExternalID))
      .filter(Boolean))];

    const airtableBookings = await fetchAirtableBookingsByExternalIds(externalIds);
    const customerIds = [...new Set(airtableBookings.flatMap(r => r.fields?.Customer || []))];
    const bikeIds = [...new Set(airtableBookings.flatMap(r => r.fields?.Bike || []))];
    const { customers, bikes } = airtableConfig();
    const [custRecs, bikeRecs] = await Promise.all([
      customers && customerIds.length ? fetchRelatedById(customers, customerIds) : Promise.resolve([]),
      bikes && bikeIds.length ? fetchRelatedById(bikes, bikeIds) : Promise.resolve([])
    ]);
    const customerMap = new Map(custRecs.map(r => [r.id, pickCustomerFields(r)]));
    const bikeMap = new Map(bikeRecs.map(r => [r.id, pickBikeFields(r)]));
    const enrichmentByExternalId = new Map();
    for (const rec of airtableBookings) {
      const eid = rec.fields?.EterminBookingID;
      if (!eid) continue;
      const cId = (rec.fields?.Customer || [])[0];
      const bId = (rec.fields?.Bike || [])[0];
      enrichmentByExternalId.set(String(eid), {
        record: rec,
        customer: cId ? (customerMap.get(cId) || null) : null,
        bike: bId ? (bikeMap.get(bId) || null) : null
      });
    }

    // 5) Merge
    const merged = inWindow.map(({ apt, calendarName }) => {
      const eid = apt.ExternalID ? String(apt.ExternalID) : null;
      const enrich = eid ? enrichmentByExternalId.get(eid) : null;
      return mergeAppointment(apt, calendarName, enrich);
    });
    merged.sort((a, b) => (a.selectedSlot || '').localeCompare(b.selectedSlot || ''));

    res.json({ bookings: merged });
  } catch (err) {
    console.error('[portal] list bookings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/portal/bookings/:airtableId ──────────────────────────────────
// Used by the cancel-mail flow to re-fetch fresh customer info. Takes the
// Airtable record ID (rec...). For eTermin-only appointments this endpoint
// is not applicable.

router.get('/bookings/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    const { bookings } = airtableConfig();
    const data = await airtable('GET', bookings, `/${encodeURIComponent(recordId)}`);
    const f = data.fields || {};
    const customerIds = f.Customer || [];
    const bikeIds = f.Bike || [];
    const eid = f.EterminBookingID ? String(f.EterminBookingID) : null;

    const [custRecs, bikeRecs] = await Promise.all([
      customerIds.length && airtableConfig().customers ? fetchRelatedById(airtableConfig().customers, customerIds) : Promise.resolve([]),
      bikeIds.length && airtableConfig().bikes ? fetchRelatedById(airtableConfig().bikes, bikeIds) : Promise.resolve([])
    ]);

    // Try to find the live eTermin record for accurate time/calendar
    let aptHit = null;
    let calName = null;
    if (eid) {
      const slot = f.SelectedSlot;
      const fromDate = slot ? String(slot).slice(0, 10) : null;
      if (fromDate) {
        const cals = (await loadCalendars()).filter(c => Number.isFinite(c.id));
        for (const cal of cals) {
          try {
            const apts = await etermin.getAppointments(cal.id, fromDate, fromDate);
            const match = (apts || []).find(a => String(a.ExternalID) === eid);
            if (match) { aptHit = match; calName = cal.name; break; }
          } catch { /* ignore */ }
        }
      }
    }

    const enrichment = {
      record: data,
      customer: custRecs[0] ? pickCustomerFields(custRecs[0]) : null,
      bike: bikeRecs[0] ? pickBikeFields(bikeRecs[0]) : null
    };

    // If we found an eTermin record, mergeAppointment gives us the proper shape.
    // Otherwise build from Airtable alone (graceful fallback for orphans).
    let booking;
    if (aptHit) {
      booking = mergeAppointment(aptHit, calName, enrichment);
    } else {
      booking = {
        id: data.id,
        airtableId: data.id,
        eterminBookingId: eid,
        bookingRef: f.BookingRef || null,
        selectedSlot: f.SelectedSlot || null,
        durationMinutes: null,
        calendarName: null,
        isBlocker: false,
        source: 'airtable-merged',
        customer: enrichment.customer,
        bike: enrichment.bike,
        serviceType: f.ServiceType || null,
        services: f.Services || null,
        serviceIds: f.ServiceIDs || null,
        problemDescription: f.ProblemDescription || null,
        locationType: f.LocationType || null,
        address: f.Address || null,
        estimatedPrice: f.EstimatedPrice ?? null,
        travelFee: f.TravelFee ?? null,
        depositAmount: f.DepositAmount ?? null,
        depositPaid: !!f.DepositPaid,
        payPalOrderId: f.PayPalOrderID || null,
        payPalCaptureId: f.PayPalCaptureID || null,
        status: f.Status || null,
        cancellationReason: f.CancellationReason || null,
        cancellationLog: f.CancellationLog || null,
        createdAt: f.CreatedAt || null
      };
    }

    res.json({ booking });
  } catch (err) {
    console.error('[portal] booking detail error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/portal/bookings/:airtableId/cancel ──────────────────────────
// Takes the Airtable record ID. Only Airtable-backed bookings can be cancelled
// via this endpoint (need PayPalCaptureID for refund + audit fields).

router.post('/bookings/:recordId/cancel', async (req, res) => {
  const { recordId } = req.params;
  const reason = String(req.body?.reason || '').trim();
  const refund = !!req.body?.refund;
  const actor = String(req.body?.actor || '').trim() || 'portal';

  if (!reason) return res.status(400).json({ error: 'reason required' });

  const result = {
    eterminDeleted: false,
    eterminSkipped: false,
    refund: { attempted: false, ok: false, refundId: null, error: null },
    airtableStatus: null
  };

  try {
    const { bookings } = airtableConfig();
    const current = await airtable('GET', bookings, `/${encodeURIComponent(recordId)}`);
    const f = current.fields || {};

    // 1) eTermin delete (404 ignorieren — Termin evtl. manuell schon weg)
    if (f.EterminBookingID) {
      try {
        await etermin.deleteAppointment(f.EterminBookingID);
        result.eterminDeleted = true;
      } catch (err) {
        const is404 = /\(404\)/.test(String(err.message || ''));
        if (!is404) throw err;
        result.eterminSkipped = true;
      }
    } else {
      result.eterminSkipped = true;
    }

    // 2) PayPal Refund (nur wenn explizit gewünscht UND CaptureID vorhanden)
    if (refund && f.PayPalCaptureID) {
      result.refund.attempted = true;
      try {
        const r = await paypal.refundCapture(f.PayPalCaptureID, {
          reason: reason.slice(0, 30)
        });
        result.refund.ok = true;
        result.refund.refundId = r?.id || null;
      } catch (err) {
        result.refund.error = err.message;
      }
    }

    // 3) Airtable: Status, Reason, Log
    const newStatus = result.refund.ok ? 'refunded' : 'cancelled';
    const logLine = [
      `[${new Date().toISOString()}] ${actor}: storno`,
      result.eterminDeleted ? 'eTermin=deleted' : (result.eterminSkipped ? 'eTermin=skipped' : ''),
      result.refund.attempted
        ? (result.refund.ok ? `refund=ok(${result.refund.refundId})` : `refund=failed(${result.refund.error})`)
        : 'refund=not_requested',
      `reason="${reason.replace(/"/g, '\\"')}"`
    ].filter(Boolean).join(' · ');

    const previousLog = f.CancellationLog ? `${f.CancellationLog}\n` : '';
    await airtable('PATCH', bookings, `/${encodeURIComponent(recordId)}`, {
      fields: {
        Status: newStatus,
        CancellationReason: reason,
        CancellationLog: `${previousLog}${logLine}`
      }
    }, { typecast: true });
    result.airtableStatus = newStatus;

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[portal] cancel error:', err);
    res.status(500).json({ error: err.message, partial: result });
  }
});

// ─── GET /api/portal/config ────────────────────────────────────────────────
// Liest die globale Konfiguration (Tabelle Konfiguration, Label="global")
// für das Portal-UI.

router.get('/config', async (req, res) => {
  try {
    const fields = await config.getAll();
    const recordId = await config.getRecordId();
    res.json({ recordId, fields });
  } catch (err) {
    console.error('[portal] get config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/portal/config ──────────────────────────────────────────────
// Updates allowed numeric keys. Server-seitige Validation (keine negativen
// Werte, sinnvolle Obergrenzen). Cache wird invalidiert.

const CONFIG_VALIDATORS = {
  TravelFeeEUR:               { min: 0,  max: 1000, label: 'Anfahrts-Pauschale' },
  DepositAmountEUR:           { min: 0,  max: 1000, label: 'Anzahlung' },
  InspektionFreeMinutes:      { min: 0,  max: 480,  label: 'Inspektions-Bonus-Minuten' },
  RatePerMinuteEUR:           { min: 0,  max: 100,  label: 'Minutensatz' },
  AppointmentBufferMinutes:   { min: 0,  max: 240,  label: 'Auftrags-Puffer' },
  TravelBufferMinutesDefault: { min: 0,  max: 240,  label: 'Travel-Buffer-Default' }
};

router.patch('/config', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    const errors = [];

    for (const [key, validator] of Object.entries(CONFIG_VALIDATORS)) {
      if (body[key] === undefined) continue; // Feld nicht im Patch — ignorieren
      const n = Number(body[key]);
      if (!Number.isFinite(n)) {
        errors.push(`${validator.label}: muss eine Zahl sein`);
        continue;
      }
      if (n < validator.min) {
        errors.push(`${validator.label}: darf nicht kleiner als ${validator.min} sein`);
        continue;
      }
      if (n > validator.max) {
        errors.push(`${validator.label}: darf nicht größer als ${validator.max} sein`);
        continue;
      }
      patch[key] = n;
    }

    if (errors.length) return res.status(400).json({ error: 'validation_failed', details: errors });
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Keine Felder zum Update' });

    const updated = await config.update(patch);
    res.json({ ok: true, fields: updated });
  } catch (err) {
    console.error('[portal] patch config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/portal/calendars ─────────────────────────────────────────────
// Reduzierte Sicht für das Portal-UI — exakt die Felder, die der Editor
// rendert. Cache wird erst gefrischt (frische Daten beim Öffnen).

router.get('/calendars', async (req, res) => {
  try {
    invalidateCalendarsCache();
    const cals = await loadCalendars();
    res.json({ calendars: cals });
  } catch (err) {
    console.error('[portal] list calendars error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/portal/calendars/:recordId ─────────────────────────────────
// Editier-Felder: Working Hours, Pause-Fenster, MaxFahrzeit, Travel-Buffer,
// Aktiv. Validation: PausenLaenge ≤ Pausen-Fenster, Arbeitsstart < Arbeitsende.

const CAL_EDITABLE_FIELDS = [
  'aktiv', 'startLat', 'startLng', 'maxMin',
  'arbeitszeitStart', 'arbeitszeitEnde', 'samstagsAktiv',
  'pausenLaenge', 'pausenFenstrStart', 'pausenFenstrEnde',
  'travelBufferMin'
];

function parseHmStr(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mn = Number(m[2]);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

router.patch('/calendars/:recordId', async (req, res) => {
  const { recordId } = req.params;
  const body = req.body || {};
  const fields = {};
  const errors = [];

  // Map portal-camelCase → Airtable-Field-Names (gleicher Mapping wie api-admin)
  const map = {
    aktiv:                'Aktiv',
    startLat:             'StartLat',
    startLng:             'StartLng',
    maxMin:               'MaxFahrzeitMin',
    arbeitszeitStart:     'ArbeitszeitStart',
    arbeitszeitEnde:      'ArbeitszeitEnde',
    samstagsAktiv:        'SamstagsAktiv',
    pausenLaenge:         'PausenLaenge',
    pausenFenstrStart:    'PausenFenstrStart',
    pausenFenstrEnde:     'PausenFenstrEnde',
    travelBufferMin:      'TravelBufferMin'
  };

  for (const key of CAL_EDITABLE_FIELDS) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (key === 'aktiv' || key === 'samstagsAktiv') {
      fields[map[key]] = !!v;
    } else if (key === 'arbeitszeitStart' || key === 'arbeitszeitEnde'
            || key === 'pausenFenstrStart' || key === 'pausenFenstrEnde') {
      if (v === '' || v === null) { fields[map[key]] = ''; continue; }
      if (parseHmStr(v) == null) {
        errors.push(`${key}: ungültiges Zeitformat (HH:MM erwartet)`);
        continue;
      }
      fields[map[key]] = String(v);
    } else {
      // numeric (lat, lng, maxMin, pausenLaenge, travelBufferMin)
      if (v === null || v === '') { fields[map[key]] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`${key}: keine gültige Zahl`); continue; }
      if (key !== 'startLat' && key !== 'startLng' && n < 0) {
        errors.push(`${key}: darf nicht negativ sein`);
        continue;
      }
      fields[map[key]] = n;
    }
  }

  // Cross-field validation
  const aStart = parseHmStr(fields.ArbeitszeitStart ?? body.arbeitszeitStart);
  const aEnd   = parseHmStr(fields.ArbeitszeitEnde  ?? body.arbeitszeitEnde);
  if (aStart != null && aEnd != null && aStart >= aEnd) {
    errors.push('ArbeitszeitStart muss vor ArbeitszeitEnde liegen');
  }
  const pStart = parseHmStr(fields.PausenFenstrStart ?? body.pausenFenstrStart);
  const pEnd   = parseHmStr(fields.PausenFenstrEnde  ?? body.pausenFenstrEnde);
  const pLen   = fields.PausenLaenge ?? body.pausenLaenge;
  if (pStart != null && pEnd != null) {
    if (pStart >= pEnd) errors.push('PausenFenstrStart muss vor PausenFenstrEnde liegen');
    if (pLen != null && Number(pLen) > (pEnd - pStart)) {
      errors.push('PausenLaenge ist größer als das Pausen-Fenster');
    }
  }

  if (errors.length) return res.status(400).json({ error: 'validation_failed', details: errors });
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Keine Felder zum Update' });

  try {
    const result = await updateCalendarFields(recordId, fields);
    res.json({ ok: true, record: result });
  } catch (err) {
    console.error('[portal] update calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/portal/catalog ───────────────────────────────────────────────
// Liefert das ROHE Airtable-Catalog für den Portal-Editor: Preis, Dauer,
// addPrice, addDuration, EterminID, etc. — gruppiert nach Kategorie.

router.get('/catalog', async (req, res) => {
  try {
    catalog.invalidateCache();
    const full = await catalog.loadCatalog();
    res.json({ catalog: full });
  } catch (err) {
    console.error('[portal] list catalog error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/portal/catalog/:recordId ───────────────────────────────────
// Patcht eine einzelne Leistung. Whitelist mit Airtable-Feldnamen.

const CATALOG_EDITABLE = {
  Leistung:                'string',
  Beschreibung:            'string',
  Preis:                   { type: 'number', min: 0,  max: 5000 },
  PreisZusatz:             { type: 'number', min: 0,  max: 5000 },
  Dauer:                   { type: 'number', min: 0,  max: 480  },
  DauerZusatz:             { type: 'number', min: 0,  max: 480  },
  Materialkosten:          { type: 'number', min: 0,  max: 5000 },
  MaximaleZahl:            { type: 'number', min: 1,  max: 20   },
  EterminID:               'string',
  RadblitzID:              'string',
  KategorieSortOrder:      { type: 'number', min: 0,  max: 9999 },
  LeistungSortOrder:       { type: 'number', min: 0,  max: 9999 },
  InInspektionEnthalten:   'boolean'
};

router.patch('/catalog/:recordId', async (req, res) => {
  const { recordId } = req.params;
  const body = req.body || {};
  const fields = {};
  const errors = [];

  for (const [key, spec] of Object.entries(CATALOG_EDITABLE)) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (spec === 'string') {
      fields[key] = v == null ? '' : String(v);
    } else if (spec === 'boolean') {
      fields[key] = !!v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`${key}: keine gültige Zahl`); continue; }
      if (n < spec.min) { errors.push(`${key}: < ${spec.min}`); continue; }
      if (n > spec.max) { errors.push(`${key}: > ${spec.max}`); continue; }
      fields[key] = n;
    }
  }

  if (errors.length) return res.status(400).json({ error: 'validation_failed', details: errors });
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Keine Felder zum Update' });

  try {
    const updated = await airtable(
      'PATCH',
      'tblxfZMerv61U0hjb',
      `/${encodeURIComponent(recordId)}`,
      { fields },
      { typecast: true }
    );
    catalog.invalidateCache();
    res.json({ ok: true, record: updated });
  } catch (err) {
    console.error('[portal] update catalog error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/portal/reload ───────────────────────────────────────────────
// Webhook für das Portal: Nach einem Publish invalidiert das Booking-Tool
// SOFORT alle Konfigurations-Caches (statt auf das 5-Min-TTL zu warten).

router.post('/reload', async (req, res) => {
  try {
    config.invalidateCache();
    invalidateCalendarsCache();
    catalog.invalidateCache();
    console.log('[portal] reload webhook — caches invalidated');
    res.json({ ok: true, reloaded: ['config', 'calendars', 'catalog'], at: new Date().toISOString() });
  } catch (err) {
    console.error('[portal] reload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
