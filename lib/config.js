/**
 * Config Service — lädt globale Booking-Tool-Konstanten aus Airtable
 * (Tabelle "Konfiguration", einreihig, Label="global").
 *
 * Vorlage: lib/calendars.js (gleiches Fetch/Cache-Muster).
 *
 * Aufruf:
 *   const config = require('./config');
 *   const buffer = await config.get('AppointmentBufferMinutes', 15);
 *   const all    = await config.getAll();
 *
 * Fallback-Strategie: bei Airtable-Fehler ODER fehlendem Wert wird der
 * an `get()` übergebene Default genutzt — d.h. die alte Hartkodierung
 * bleibt als letzte Verteidigung erhalten.
 */

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';
const TABLE_NAME_OR_ID = process.env.AIRTABLE_CONFIG_TABLE || 'Konfiguration';
const CACHE_TTL = 5 * 60 * 1000; // 5 min

let _cache = null;
let _cacheTime = 0;
let _inflight = null;

const NUMERIC_KEYS = new Set([
  'TravelFeeEUR',
  'DepositAmountEUR',
  'InspektionFreeMinutes',
  'RatePerMinuteEUR',
  'AppointmentBufferMinutes',
  'TravelBufferMinutesDefault'
]);

function normalize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (NUMERIC_KEYS.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function _fetch() {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.warn('[config] Airtable not configured — falling back to code defaults');
    return {};
  }

  const url = `${AIRTABLE_BASE_URL}/${baseId}/${encodeURIComponent(TABLE_NAME_OR_ID)}?pageSize=10`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const records = data.records || [];
  if (records.length === 0) return {};

  // Prefer record with Label="global", else first record.
  const chosen = records.find(rec => (rec.fields?.Label || '').toLowerCase() === 'global') || records[0];
  const fields = normalize(chosen.fields || {});
  fields.__recordId = chosen.id;
  return fields;
}

/**
 * Returns the cached config object (loading on first call).
 * Never throws — on error returns the last good cache or {}.
 */
async function load() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const fresh = await _fetch();
      _cache = fresh;
      _cacheTime = Date.now();
      console.log(`[config] Loaded config from Airtable (${Object.keys(fresh).filter(k => !k.startsWith('__')).length} keys)`);
      return fresh;
    } catch (err) {
      console.error('[config] load error:', err.message);
      return _cache || {};
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Returns a single config value with a guaranteed fallback.
 *
 *   const buffer = await get('AppointmentBufferMinutes', 15);
 *
 * For numeric keys: returns a finite Number or the default.
 * For other keys:   returns the value if non-empty, else the default.
 */
async function get(key, fallback) {
  const all = await load();
  const v = all[key];
  if (NUMERIC_KEYS.has(key)) {
    return Number.isFinite(v) ? v : fallback;
  }
  return (v !== undefined && v !== null && v !== '') ? v : fallback;
}

/**
 * Returns a shallow copy of the full config (without __recordId).
 */
async function getAll() {
  const all = await load();
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('__')) out[k] = v;
  }
  return out;
}

/**
 * The Airtable record-ID of the currently cached config row.
 * Needed by the portal PATCH endpoint to find the right record.
 */
async function getRecordId() {
  const all = await load();
  return all.__recordId || null;
}

/**
 * PATCH the global config record. Caller passes a {field: value} map; the
 * function writes it to Airtable, invalidates the cache, and returns the
 * fresh config.
 *
 * Throws on Airtable error.
 */
async function update(patchFields) {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error('Airtable not configured');

  const recordId = await getRecordId();
  if (!recordId) throw new Error('No "global" config record in Airtable — run scripts/setup-config-table.js first');

  const fields = { ...patchFields, UpdatedAt: new Date().toISOString() };
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${encodeURIComponent(TABLE_NAME_OR_ID)}/${recordId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  });
  if (!r.ok) {
    throw new Error(`Airtable PATCH ${r.status}: ${await r.text()}`);
  }
  invalidateCache();
  return await getAll();
}

function invalidateCache() {
  _cache = null;
  _cacheTime = 0;
  _inflight = null;
}

module.exports = {
  load,
  get,
  getAll,
  getRecordId,
  update,
  invalidateCache,
  NUMERIC_KEYS
};
