/**
 * Ergänzt die Airtable-Tabellen `Sessions` und `Bookings` um Source-/UTM-/
 * Click-ID-Felder für Traffic-Attribution (Last-Touch).
 *
 * Idempotent: prüft pro Feld ob es existiert, legt nur neue an.
 *
 * Run once:
 *   node scripts/setup-source-fields.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID;
const TABLE_BOOKINGS = process.env.AIRTABLE_BOOKINGS_TABLE;
const TABLE_SESSIONS = process.env.AIRTABLE_SESSIONS_TABLE;

if (!TOKEN || !BASE) {
  console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in .env');
  process.exit(1);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${method} → ${r.status}: ${d?.error?.message || d?.error?.type || t}`);
  return d;
}

// Felder, die ergänzt werden sollen (gleich für Sessions + Bookings)
const FIELDS = [
  { name: 'Source', type: 'singleSelect', options: { choices: [
      { name: 'adwords',   color: 'blueLight2' },
      { name: 'meta_ads',  color: 'purpleLight2' },
      { name: 'organisch', color: 'greenLight2' },
      { name: 'direkt',    color: 'grayLight2' },
      { name: 'sonstige',  color: 'yellowLight2' }
    ]}
  },
  { name: 'UtmSource',   type: 'singleLineText' },
  { name: 'UtmMedium',   type: 'singleLineText' },
  { name: 'UtmCampaign', type: 'singleLineText' },
  { name: 'UtmContent',  type: 'singleLineText' },
  { name: 'UtmTerm',     type: 'singleLineText' },
  { name: 'ClickId',     type: 'singleLineText' },  // gclid oder fbclid
  { name: 'Referrer',    type: 'multilineText' }    // erste Referrer-URL, kann lang sein
];

// Sessions-spezifische Felder (Bookings betrifft das nicht, weil nur erfolgreiche
// Buchungen dort landen — abgebrochene haben keine Booking-Row).
const SESSION_ONLY_FIELDS = [
  { name: 'AbortReason', type: 'singleSelect', options: { choices: [
      { name: 'outside_area',    color: 'redLight2' },
      { name: 'geocode_failed',  color: 'orangeLight2' },
      { name: 'payment_failed',  color: 'yellowLight2' },
      { name: 'user_cancelled',  color: 'grayLight2' }
    ]}
  },
  { name: 'AbortedAddress', type: 'singleLineText' }
];

async function processTable(tableId, label, fieldSet) {
  if (!tableId) { console.warn(`→ ${label}: keine TABLE-ID in .env — übersprungen`); return; }
  console.log(`\n── ${label} (${tableId}) ──`);

  const meta = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const table = meta.tables.find(t => t.id === tableId);
  if (!table) { console.warn(`  ✗ Tabelle nicht gefunden`); return; }

  const existingNames = new Set(table.fields.map(f => f.name));
  const missing = fieldSet.filter(f => !existingNames.has(f.name));
  if (missing.length === 0) {
    console.log(`  ✓ alle ${fieldSet.length} Felder bereits vorhanden`);
    return;
  }
  console.log(`  → ${missing.length} neue Felder anlegen…`);
  for (const f of missing) {
    try {
      await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${tableId}/fields`, f);
      console.log(`    + ${f.name} (${f.type})`);
    } catch (err) {
      console.error(`    ✗ ${f.name}: ${err.message}`);
    }
  }
}

(async () => {
  console.log(`setup-source-fields — Sessions + Bookings\n`);
  await processTable(TABLE_SESSIONS, 'Sessions', [...FIELDS, ...SESSION_ONLY_FIELDS]);
  await processTable(TABLE_BOOKINGS, 'Bookings', FIELDS);
  console.log('\n✓ Done.');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
