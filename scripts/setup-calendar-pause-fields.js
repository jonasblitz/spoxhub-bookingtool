/**
 * Adds the remaining operational columns to the Kalender table:
 *   - SamstagsAktiv      (checkbox, mobile + werkstatt)
 *   - PausenLaenge       (number, minutes)
 *   - PausenFenstrStart  (text HH:MM)
 *   - PausenFenstrEnde   (text HH:MM)
 *   - TravelBufferMin    (number, only relevant for mobile calendars)
 *
 * ArbeitszeitStart and ArbeitszeitEnde are already present (added separately).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TBL = 'tbluykbJ3BpZS2wE5';
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;

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

(async () => {
  const tables = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const t = tables.tables.find(x => x.id === TBL);
  if (!t) { console.error(`Table ${TBL} not found`); process.exit(1); }
  console.log(`Calendar table: ${t.name} (${t.id})`);
  const have = new Set(t.fields.map(f => f.name));

  const NEW_FIELDS = [
    { name: 'SamstagsAktiv',     type: 'checkbox', options: { icon: 'check', color: 'greenBright' },
      description: 'Wenn aktiv, sind Samstage buchbar.' },
    { name: 'PausenLaenge',      type: 'number',   options: { precision: 0 },
      description: 'Länge der Mittagspause in Minuten (z.B. 30, 45, 60).' },
    { name: 'PausenFenstrStart', type: 'singleLineText',
      description: 'Frühestmöglicher Pausenstart, Format HH:MM (Default 12:00).' },
    { name: 'PausenFenstrEnde',  type: 'singleLineText',
      description: 'Spätestmögliches Pausenende, Format HH:MM (Default 14:00).' },
    { name: 'TravelBufferMin',   type: 'number',   options: { precision: 0 },
      description: 'Fahrzeit zwischen mobilen Terminen in Minuten (Default 25).' }
  ];

  for (const f of NEW_FIELDS) {
    if (have.has(f.name)) {
      console.log(`  ✓ ${f.name} (exists)`);
      continue;
    }
    try {
      await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${TBL}/fields`, f);
      console.log(`  ✨ ${f.name} added`);
    } catch (e) {
      console.warn(`  ! ${f.name}: ${e.message}`);
    }
  }

  console.log('\nDone. ✅\n');
  console.log('Bitte für die 4 Kalender pflegen:');
  console.log('');
  console.log('  Blitz 1, Blitz 2 (mobil):');
  console.log('    ArbeitszeitStart, ArbeitszeitEnde, SamstagsAktiv,');
  console.log('    PausenLaenge, PausenFenstrStart, PausenFenstrEnde, TravelBufferMin');
  console.log('');
  console.log('  Werkstattplatz 1 + 2 (werkstatt):');
  console.log('    ArbeitszeitStart, ArbeitszeitEnde, SamstagsAktiv,');
  console.log('    PausenLaenge, PausenFenstrStart, PausenFenstrEnde');
  console.log('    (TravelBufferMin ist für Werkstatt irrelevant — leer lassen)');
})().catch(err => { console.error('\n❌', err.message); process.exit(1); });
