/**
 * Portal API — Server-to-Server-Endpoints für das Spoxhub-Portal.
 *
 * Auth: Bearer-Token via Env `PORTAL_API_TOKEN`.
 * Bewusst KEIN CORS — nur server-seitige Aufrufe aus dem Portal-Backend.
 */

const express = require('express');
const router = express.Router();
const paypal = require('../lib/paypal');
const etermin = require('../lib/etermin');

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

function pickBookingFields(rec, { customer = null, bike = null } = {}) {
  const f = rec?.fields || {};
  return {
    id: rec?.id,
    bookingRef: f.BookingRef || null,
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
    selectedSlot: f.SelectedSlot || null,
    eterminBookingId: f.EterminBookingID || null,
    payPalOrderId: f.PayPalOrderID || null,
    payPalCaptureId: f.PayPalCaptureID || null,
    status: f.Status || null,
    cancellationReason: f.CancellationReason || null,
    cancellationLog: f.CancellationLog || null,
    createdAt: f.CreatedAt || null,
    customer,
    bike
  };
}

async function fetchRelatedById(table, recordIds = []) {
  if (!recordIds.length) return [];
  const ors = recordIds.map(id => `RECORD_ID()='${escapeFormulaString(id)}'`).join(',');
  const filter = recordIds.length === 1 ? ors : `OR(${ors})`;
  const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=${recordIds.length}`;
  const data = await airtable('GET', table, params);
  return data.records || [];
}

async function expandBookingRecord(rec) {
  const customers = airtableConfig().customers;
  const bikes = airtableConfig().bikes;
  const customerIds = rec.fields?.Customer || [];
  const bikeIds = rec.fields?.Bike || [];
  const [custRecs, bikeRecs] = await Promise.all([
    customers && customerIds.length ? fetchRelatedById(customers, customerIds) : Promise.resolve([]),
    bikes && bikeIds.length ? fetchRelatedById(bikes, bikeIds) : Promise.resolve([])
  ]);
  return pickBookingFields(rec, {
    customer: custRecs[0] ? pickCustomerFields(custRecs[0]) : null,
    bike: bikeRecs[0] ? pickBikeFields(bikeRecs[0]) : null
  });
}

// ─── GET /api/portal/bookings ──────────────────────────────────────────────

router.get('/bookings', async (req, res) => {
  try {
    const { from, to, status } = req.query;
    const { bookings, customers } = airtableConfig();
    if (!bookings) return res.status(503).json({ error: 'bookings table not configured' });

    const filters = [];
    if (from) filters.push(`IS_AFTER({SelectedSlot}, DATETIME_PARSE('${escapeFormulaString(from)}'))`);
    if (to)   filters.push(`IS_BEFORE({SelectedSlot}, DATETIME_PARSE('${escapeFormulaString(to)}'))`);
    if (status) filters.push(`{Status}='${escapeFormulaString(status)}'`);

    let filterExpr = '';
    if (filters.length === 1) filterExpr = filters[0];
    else if (filters.length > 1) filterExpr = `AND(${filters.join(',')})`;

    const sortQS = '&sort%5B0%5D%5Bfield%5D=SelectedSlot&sort%5B0%5D%5Bdirection%5D=asc';
    const filterQS = filterExpr ? `?filterByFormula=${encodeURIComponent(filterExpr)}&pageSize=100${sortQS}` : `?pageSize=100${sortQS}`;

    const data = await airtable('GET', bookings, filterQS);
    const recs = data.records || [];

    // Batch-fetch all customers + bikes referenced in this list
    const allCustomerIds = [...new Set(recs.flatMap(r => r.fields?.Customer || []))];
    const allBikeIds = [...new Set(recs.flatMap(r => r.fields?.Bike || []))];
    const [custRecs, bikeRecs] = await Promise.all([
      customers && allCustomerIds.length ? fetchRelatedById(customers, allCustomerIds) : Promise.resolve([]),
      airtableConfig().bikes && allBikeIds.length ? fetchRelatedById(airtableConfig().bikes, allBikeIds) : Promise.resolve([])
    ]);
    const custMap = new Map(custRecs.map(r => [r.id, pickCustomerFields(r)]));
    const bikeMap = new Map(bikeRecs.map(r => [r.id, pickBikeFields(r)]));

    const bookings_ = recs.map(rec => {
      const cust = (rec.fields?.Customer || [])[0];
      const bike = (rec.fields?.Bike || [])[0];
      return pickBookingFields(rec, {
        customer: cust ? (custMap.get(cust) || null) : null,
        bike:     bike ? (bikeMap.get(bike) || null) : null
      });
    });
    res.json({ bookings: bookings_ });
  } catch (err) {
    console.error('[portal] list bookings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/portal/bookings/:recordId ────────────────────────────────────

router.get('/bookings/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    const { bookings } = airtableConfig();
    const data = await airtable('GET', bookings, `/${encodeURIComponent(recordId)}`);
    const expanded = await expandBookingRecord(data);
    res.json({ booking: expanded });
  } catch (err) {
    console.error('[portal] booking detail error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /api/portal/bookings/:recordId/cancel ────────────────────────────

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

module.exports = router;
