/**
 * Fügt der Bookings-Tabelle das Feld `AddressNotes` (multilineText) hinzu.
 * Wird auf dem Adress-Screen vom Kunden als „Hinweise zur Zufahrt"
 * (optional) befüllt und in den eTermin-Notes sowie im Airtable-Booking
 * persistiert.
 *
 * Einmaliges Ausführen:
 *   node scripts/add-address-notes-field.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.AIRTABLE_BOOKINGS_TABLE;

if (!TOKEN || !BASE || !TABLE) {
  console.error('Missing AIRTABLE_TOKEN, AIRTABLE_BASE_ID oder AIRTABLE_BOOKINGS_TABLE in .env');
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

(async () => {
  const tables = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const t = tables.tables.find(x => x.id === TABLE);
  if (!t) {
    console.error('Bookings-Tabelle nicht gefunden:', TABLE);
    process.exit(1);
  }
  console.log(`Tabelle: ${t.name}`);
  if (t.fields.some(f => f.name === 'AddressNotes')) {
    console.log('  ✓ AddressNotes existiert bereits');
    return;
  }
  await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${TABLE}/fields`, {
    name: 'AddressNotes',
    type: 'multilineText',
    description: 'Hinweise zur Zufahrt (vom Kunden im Booking-Tool eingegeben, optional)'
  });
  console.log('  ✨ AddressNotes hinzugefügt');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
