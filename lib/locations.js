/**
 * Locations Service — synct eTermin-Termine (mobile Kalender) nach Airtable
 * (Tabelle tbl3IDm2tNEUipn4B), geocodet einmalig je Datensatz und liefert
 * sie für die Karte im Admin-Dashboard.
 *
 * Idempotent über Booking-ID. Geocoded-Flag verhindert wiederholte Geocoding-Calls.
 */

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';
const TABLE_ID = 'tbl3IDm2tNEUipn4B';

const calendars = require('./calendars');
const etermin = require('./etermin');

// Nominatim (OSM) für Batch-Geocoding — kostenlos, max 1 req/s.
// TravelTime ist für den User-Flow (Echtzeit-Check) reserviert.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT = 'SpoxHub-BookingTool/1.0 (admin@spoxhub.io)';

/**
 * Normalisiert eTermin-Locationstrings, die durch eingebaute Newlines
 * Artefakte wie "Sophienterrasse 15nHamburg" enthalten können.
 */
function normalizeAddress(raw) {
  let s = String(raw || '').trim();
  // "Strassenname 12nHamburg" → "Strassenname 12, Hamburg"  (n war ein \n)
  s = s.replace(/(\d[A-Za-z]?)n([A-ZÄÖÜ])/g, '$1, $2');
  // Mehrfache Spaces, Kommas
  s = s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/,+/g, ',').trim();
  // Ländernamen-Übersetzung normalisieren
  s = s.replace(/\bDuitsland\b/gi, 'Deutschland')
       .replace(/\bGermany\b/gi, 'Deutschland')
       .replace(/\bAlemanha\b/gi, 'Deutschland');
  return s;
}

async function geocodeNominatim(address) {
  const q = encodeURIComponent(normalizeAddress(address));
  const url = `${NOMINATIM_URL}?q=${q}&format=json&limit=1&addressdetails=0&countrycodes=de`;
  const r = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'de' }
  });
  if (!r.ok) {
    if (r.status === 429) throw new Error('Nominatim rate-limited (429)');
    throw new Error(`Nominatim ${r.status}`);
  }
  const data = await r.json();
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit) return null;
  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, label: hit.display_name };
}

function config() {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error('Airtable nicht konfiguriert');
  return { token, baseId };
}

async function airtable(method, path, body) {
  const { token, baseId } = config();
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${TABLE_ID}${path}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) {
    throw new Error(`Airtable ${method} ${path} → ${r.status}: ${d?.error?.message || d?.error?.type || t}`);
  }
  return d;
}

// ─── Read ────────────────────────────────────────────────────────────────────

async function listAllRecords() {
  let all = [], offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const d = await airtable('GET', `?${qs.toString()}`);
    all = all.concat(d.records || []);
    offset = d.offset;
  } while (offset);
  return all;
}

async function listGeocoded() {
  const records = await listAllRecords();
  return records
    .filter(r => r.fields.Geocoded && Number.isFinite(r.fields.Lat) && Number.isFinite(r.fields.Lng))
    .map(r => ({
      id: r.id,
      bookingId: r.fields.BookingID || '',
      vorname: r.fields.Vorname || '',
      name: r.fields.Name || '',
      anschrift: r.fields.Anschrift || '',
      datum: r.fields.Datum || null,
      kalender: r.fields.Kalender || '',
      lat: r.fields.Lat,
      lng: r.fields.Lng
    }));
}

// ─── Write ───────────────────────────────────────────────────────────────────

async function createRecords(records) {
  // Airtable Batch-Limit: 10
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const r = await airtable('POST', '', { records: chunk.map(fields => ({ fields })) });
    created.push(...(r.records || []));
  }
  return created;
}

async function updateRecords(records) {
  const updated = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const r = await airtable('PATCH', '', { records: chunk });
    updated.push(...(r.records || []));
  }
  return updated;
}

// ─── eTermin → Records ──────────────────────────────────────────────────────

/**
 * Robust extract a field from an eTermin appointment with various casings.
 */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

// Filter: Anschriften, die zur Werkstatt selbst gehören (Tagesstart-Platzhalter).
// Greift auf Location oder Street.
const SHOP_ADDRESS_RE = /lerchenstr(\.|aße|asse)\s*16\b/i;

// Filter: Platzhalter-Vornamen, die nicht zu echten Kunden gehören
const PLACEHOLDER_FIRSTNAMES = new Set(['base']);

/**
 * Liest die Anschrift aus dem Termin. eTermin hat zwei Felder:
 *   - Location: meist sauberes "Straße Hsnr, PLZ Ort, Land"
 *   - Street/ZIP/Town: einzelne Felder, oft leer wenn Location gesetzt ist
 * Wir bevorzugen Location, fallen sonst auf die Einzelfelder zurück.
 */
function buildAnschrift(app) {
  const location = String(pick(app, 'Location', 'location') || '').trim();
  if (location) return location;

  const street = String(pick(app, 'Street', 'street')).trim();
  const zip    = String(pick(app, 'ZIP', 'Zip', 'ZipCode', 'Zipcode', 'zip', 'zipcode', 'PLZ')).trim();
  const city   = String(pick(app, 'Town', 'town', 'City', 'city')).trim();
  return [street, [zip, city].filter(Boolean).join(' ').trim()].filter(Boolean).join(', ');
}

function shouldSkipAppointment(app, anschrift) {
  const firstName = String(pick(app, 'FirstName', 'Firstname', 'firstname')).trim();
  if (PLACEHOLDER_FIRSTNAMES.has(firstName.toLowerCase())) {
    return { skip: true, reason: `placeholder firstname "${firstName}"` };
  }
  if (!anschrift) {
    return { skip: true, reason: 'no address' };
  }
  if (SHOP_ADDRESS_RE.test(anschrift)) {
    return { skip: true, reason: 'shop address' };
  }
  return { skip: false };
}

function appointmentToRecord(app, calendarName) {
  const bookingId = String(pick(app, 'ID', 'Id', 'id', 'AppointmentID', 'AppointmentId', 'AppointmentNo', 'BookingID') || '');
  if (!bookingId) return null;

  const vorname   = String(pick(app, 'FirstName', 'Firstname', 'firstname'));
  const name      = String(pick(app, 'LastName',  'Lastname',  'lastname'));
  const anschrift = buildAnschrift(app);
  const start     = pick(app, 'StartDateTime', 'Startdatetime', 'Start', 'start');

  return {
    BookingID: bookingId,
    Vorname:   vorname,
    Name:      name,
    Anschrift: anschrift,
    Datum:     start || undefined,
    Kalender:  calendarName || ''
  };
}

/**
 * Synct alle Termine der letzten N Tage (mobile Kalender) nach Airtable
 * und geocodet die Adresse einmalig pro Datensatz.
 *
 * Returns { fetched, created, updated, geocoded, skipped }
 */
async function deleteRecords(recordIds) {
  let deleted = 0;
  for (let i = 0; i < recordIds.length; i += 10) {
    const chunk = recordIds.slice(i, i + 10);
    const qs = chunk.map(id => `records[]=${encodeURIComponent(id)}`).join('&');
    const r = await airtable('DELETE', `?${qs}`);
    deleted += (r.records || []).length;
  }
  return deleted;
}

async function syncFromEtermin({ days = 365, log = () => {} } = {}) {
  const stats = { fetched: 0, created: 0, updated: 0, geocoded: 0, geocodeFailed: 0, skipped: 0, deleted: 0 };

  const mobileCals = await calendars.getActiveMobileCalendars();
  if (mobileCals.length === 0) {
    log('Keine aktiven mobilen Kalender gefunden.');
    return stats;
  }
  log(`→ ${mobileCals.length} mobile Kalender: ${mobileCals.map(c => c.name).join(', ')}`);

  const today = new Date();
  const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().substring(0, 10);

  // 1) Fetch aus eTermin (in 30-Tage-Blöcken pro Kalender)
  const allAppointments = [];
  for (const cal of mobileCals) {
    const blocks = [];
    let cursor = new Date(startDate);
    while (cursor < today) {
      const blockEnd = new Date(Math.min(cursor.getTime() + 30 * 24 * 60 * 60 * 1000, today.getTime()));
      blocks.push([fmt(cursor), fmt(blockEnd)]);
      cursor = new Date(blockEnd.getTime() + 24 * 60 * 60 * 1000);
    }
    for (const [s, e] of blocks) {
      try {
        const apts = await etermin.getAppointments(cal.id, s, e);
        const arr = Array.isArray(apts) ? apts : [];
        log(`  · ${cal.name} ${s}…${e}: ${arr.length} Termine`);
        for (const a of arr) {
          allAppointments.push({ app: a, calendarName: cal.name });
        }
      } catch (err) {
        log(`  ⚠ ${cal.name} ${s}…${e}: ${err.message}`);
      }
    }
  }
  stats.fetched = allAppointments.length;
  log(`→ Insgesamt ${stats.fetched} Termine aus eTermin geholt.`);

  // 2) Bestehende Airtable-Records laden, indexiert nach BookingID
  const existingRecords = await listAllRecords();
  const byBookingId = new Map(
    existingRecords
      .filter(r => r.fields.BookingID)
      .map(r => [String(r.fields.BookingID), r])
  );

  // 3) Termine in Datensätze konvertieren, Filter anwenden, neue erkennen
  const toCreate = [];
  const toUpdateBasic = [];
  const validBookingIds = new Set();
  for (const { app, calendarName } of allAppointments) {
    const rec = appointmentToRecord(app, calendarName);
    if (!rec) continue;

    const skipCheck = shouldSkipAppointment(app, rec.Anschrift);
    if (skipCheck.skip) {
      stats.skipped++;
      continue;
    }
    validBookingIds.add(rec.BookingID);

    const existing = byBookingId.get(rec.BookingID);
    if (!existing) {
      toCreate.push(rec);
    } else {
      // Anschrift/Datum aktualisieren falls geändert (aber Geocoded nur droppen wenn Anschrift sich ändert)
      const e = existing.fields;
      const addressChanged = (e.Anschrift || '') !== rec.Anschrift;
      const fieldsToUpdate = {};
      if ((e.Vorname || '')   !== rec.Vorname)   fieldsToUpdate.Vorname = rec.Vorname;
      if ((e.Name || '')      !== rec.Name)      fieldsToUpdate.Name = rec.Name;
      if ((e.Anschrift || '') !== rec.Anschrift) fieldsToUpdate.Anschrift = rec.Anschrift;
      if ((e.Kalender || '')  !== rec.Kalender)  fieldsToUpdate.Kalender = rec.Kalender;
      if (rec.Datum && (e.Datum || '').substring(0, 16) !== String(rec.Datum).substring(0, 16)) {
        fieldsToUpdate.Datum = rec.Datum;
      }
      if (addressChanged) {
        fieldsToUpdate.Geocoded = false;
        fieldsToUpdate.Lat = null;
        fieldsToUpdate.Lng = null;
      }
      if (Object.keys(fieldsToUpdate).length > 0) {
        toUpdateBasic.push({ id: existing.id, fields: fieldsToUpdate });
      }
    }
  }

  // 3b) Bestehende Records löschen, die jetzt durch den Filter rausfallen
  //     (z. B. "Base"-Tagesstart oder leere Anschrift, vorher fälschlich angelegt)
  const toDeleteIds = new Set();
  for (const [bid, rec] of byBookingId) {
    const fields = rec.fields || {};
    const fakeApp = {
      FirstName: fields.Vorname || '',
      Location: fields.Anschrift || ''
    };
    const skipCheck = shouldSkipAppointment(fakeApp, fields.Anschrift || '');
    if (skipCheck.skip) {
      toDeleteIds.add(rec.id);
      log(`  · entferne ${bid} (${skipCheck.reason}): ${fields.Vorname || ''} ${fields.Name || ''} — ${fields.Anschrift || ''}`);
    }
  }
  if (toDeleteIds.size) {
    log(`→ ${toDeleteIds.size} bestehende Records aufräumen…`);
    stats.deleted = await deleteRecords([...toDeleteIds]);
    for (const [bid, r] of [...byBookingId]) {
      if (toDeleteIds.has(r.id)) byBookingId.delete(bid);
    }
  }

  // 4) Neue Records anlegen (ohne Geocode noch)
  if (toCreate.length) {
    log(`→ ${toCreate.length} neue Records anlegen…`);
    const created = await createRecords(toCreate);
    stats.created = created.length;
    for (const rec of created) {
      byBookingId.set(String(rec.fields.BookingID), rec);
    }
  }

  // 5) Basic-Updates (ohne Records, die wir gerade gelöscht haben)
  const safeUpdates = toUpdateBasic.filter(u => !toDeleteIds.has(u.id));
  if (safeUpdates.length) {
    log(`→ ${safeUpdates.length} Records aktualisieren…`);
    await updateRecords(safeUpdates);
    stats.updated = safeUpdates.length;
    // Cache neu laden
    const refreshed = await listAllRecords();
    byBookingId.clear();
    for (const r of refreshed) {
      if (r.fields.BookingID) byBookingId.set(String(r.fields.BookingID), r);
    }
  }

  // 6) Geocoding für alle, bei denen Geocoded != true
  const needsGeocode = [];
  for (const r of byBookingId.values()) {
    const f = r.fields;
    if (!f.Anschrift) continue;
    if (f.Geocoded && Number.isFinite(f.Lat) && Number.isFinite(f.Lng)) continue;
    needsGeocode.push(r);
  }
  if (needsGeocode.length) {
    log(`→ ${needsGeocode.length} Adressen geocoden…`);
  } else {
    log(`→ Alles schon geocodiert.`);
  }

  // Geocoden seriell — Nominatim erlaubt max. 1 req/s.
  // Updates in 25er-Chunks zurückschreiben, damit ein Abbruch keinen Fortschritt verliert.
  const flushUpdates = async (batch) => {
    if (!batch.length) return;
    await updateRecords(batch);
  };

  let pendingUpdates = [];
  for (let i = 0; i < needsGeocode.length; i++) {
    const rec = needsGeocode[i];
    const addr = rec.fields.Anschrift;
    try {
      const coords = await geocodeNominatim(addr);
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
        pendingUpdates.push({
          id: rec.id,
          fields: {
            Lat: Number(coords.lat.toFixed(6)),
            Lng: Number(coords.lng.toFixed(6)),
            Geocoded: true,
            GeocodedAt: new Date().toISOString()
          }
        });
        stats.geocoded++;
      } else {
        stats.geocodeFailed++;
        log(`  ⚠ nicht gefunden: ${addr}`);
      }
    } catch (err) {
      stats.geocodeFailed++;
      log(`  ⚠ Geocode-Fehler ("${addr}"): ${err.message}`);
      // bei 429 zusätzlich warten
      if (/429/.test(err.message)) await new Promise(r => setTimeout(r, 5000));
    }

    if (pendingUpdates.length >= 25) {
      await flushUpdates(pendingUpdates);
      log(`  · ${i + 1}/${needsGeocode.length} verarbeitet, ${stats.geocoded} geocoded`);
      pendingUpdates = [];
    }
    // Nominatim Usage Policy: max 1 req/s
    if (i < needsGeocode.length - 1) await new Promise(res => setTimeout(res, 1100));
  }
  await flushUpdates(pendingUpdates);
  log(`→ Geocoding fertig: ${stats.geocoded} ok, ${stats.geocodeFailed} fail`);

  return stats;
}

module.exports = {
  syncFromEtermin,
  listGeocoded
};
