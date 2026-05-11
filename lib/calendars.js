/**
 * Calendar Service — lädt eTermin-Kalender-Konfiguration aus Airtable
 * (Tabelle "Kalender" / tbluykbJ3BpZS2wE5).
 *
 * Mobile Kalender enthalten Geo-Konfiguration (StartLat/Lng + MaxFahrzeitMin)
 * für die Reichweiten-Prüfung. Werkstatt-Kalender werden für gleichmäßige
 * Auslastung anhand der Tagesbelegung gewählt.
 */

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';
const TABLE_ID = 'tbluykbJ3BpZS2wE5';
const CACHE_TTL = 60 * 60 * 1000; // 1h

let _cache = null;
let _cacheTime = 0;

async function loadCalendars() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.warn('[calendars] Airtable not configured');
    return _cache || [];
  }

  try {
    let all = [], offset = null;
    do {
      let url = `${AIRTABLE_BASE_URL}/${baseId}/${TABLE_ID}?pageSize=100`;
      if (offset) url += `&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error(`Airtable ${r.status}`);
      const d = await r.json();
      all = all.concat(d.records || []);
      offset = d.offset;
    } while (offset);

    _cache = all
      .map(r => ({
        recordId: r.id,
        id: Number(r.fields.eTerminKalender),
        name: r.fields.Name || '',
        typ: r.fields.Typ || null,
        aktiv: !!r.fields.Aktiv,
        lat: r.fields.StartLat ?? null,
        lng: r.fields.StartLng ?? null,
        maxMin: r.fields.MaxFahrzeitMin ?? null,
        prio: r.fields['Priorität'] ?? 99,
        arbeitszeitStart: r.fields.ArbeitszeitStart || '',
        arbeitszeitEnde: r.fields.ArbeitszeitEnde || '',
        samstagsAktiv: !!r.fields.SamstagsAktiv,
        pausenLaenge: r.fields.PausenLaenge ?? null,
        pausenFenstrStart: r.fields.PausenFenstrStart || '12:00',
        pausenFenstrEnde: r.fields.PausenFenstrEnde || '14:00',
        travelBufferMin: r.fields.TravelBufferMin ?? null,
        description: r.fields.Beschreibung || ''
      }))
      .filter(c => Number.isFinite(c.id));

    _cacheTime = Date.now();
    console.log(`[calendars] Loaded ${_cache.length} calendars from Airtable`);
    return _cache;
  } catch (err) {
    console.error('[calendars] load error:', err.message);
    return _cache || [];
  }
}

async function getActiveMobileCalendars() {
  const all = await loadCalendars();
  return all.filter(c => c.aktiv && c.typ === 'mobil'
    && Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.maxMin > 0);
}

async function getActiveWorkshopCalendars() {
  const all = await loadCalendars();
  return all.filter(c => c.aktiv && c.typ === 'werkstatt');
}

async function isMobileCalendarId(id) {
  const list = await getActiveMobileCalendars();
  return list.some(c => c.id === Number(id));
}

function invalidateCache() { _cache = null; _cacheTime = 0; }

async function updateCalendarFields(recordId, fields) {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error('Airtable nicht konfiguriert');

  const url = `${AIRTABLE_BASE_URL}/${baseId}/${TABLE_ID}/${recordId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Airtable PATCH ${r.status}: ${text}`);
  }
  invalidateCache();
  return await r.json();
}

module.exports = {
  loadCalendars,
  getActiveMobileCalendars,
  getActiveWorkshopCalendars,
  isMobileCalendarId,
  invalidateCache,
  updateCalendarFields
};
