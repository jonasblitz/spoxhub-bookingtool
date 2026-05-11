/**
 * Adds operational columns to the calendar table (tbluykbJ3BpZS2wE5)
 * so we can route bookings to the right eTermin calendar:
 *   - Typ          (mobil / werkstatt)
 *   - Aktiv        (toggle)
 *   - StartLat     (mobile only — geocoded start point of service area)
 *   - StartLng
 *   - MaxFahrzeitMin (radius in minutes, mobile only)
 *   - Priorität    (tie-breaker for selection)
 *   - Beschreibung (internal note)
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
    {
      name: 'Typ',
      type: 'singleSelect',
      options: { choices: [{ name: 'mobil' }, { name: 'werkstatt' }] },
      description: 'Mobiler Service oder Werkstatt-Platz'
    },
    {
      name: 'Aktiv',
      type: 'checkbox',
      options: { icon: 'check', color: 'greenBright' },
      description: 'Wenn aus, wird der Kalender bei Buchungen ignoriert.'
    },
    {
      name: 'StartLat',
      type: 'number',
      options: { precision: 6 },
      description: 'Startpunkt für Fahrzeit-Check (nur mobil).'
    },
    {
      name: 'StartLng',
      type: 'number',
      options: { precision: 6 },
      description: 'Startpunkt für Fahrzeit-Check (nur mobil).'
    },
    {
      name: 'MaxFahrzeitMin',
      type: 'number',
      options: { precision: 0 },
      description: 'Maximaler Fahrzeit-Radius in Minuten (nur mobil).'
    },
    {
      name: 'Priorität',
      type: 'number',
      options: { precision: 0 },
      description: 'Tie-Breaker bei Mobile-Auswahl (kleinere Zahl bevorzugt).'
    },
    {
      name: 'Beschreibung',
      type: 'multilineText',
      description: 'Interne Notiz / Adresse / Hinweise.'
    }
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
  console.log('Bitte fülle für die 4 bestehenden Zeilen aus:');
  console.log('');
  console.log('  Blitz 1            : Typ=mobil,    Aktiv=✓, StartLat=53.5623, StartLng=9.9526, MaxFahrzeitMin=15, Priorität=1');
  console.log('  Blitz 2            : Typ=mobil,    Aktiv=✓, StartLat=…,       StartLng=…,      MaxFahrzeitMin=…,  Priorität=2');
  console.log('  Werkstattplatz 1   : Typ=werkstatt, Aktiv=✓, Priorität=1');
  console.log('  Werkstattplatz 2   : Typ=werkstatt, Aktiv=✓, Priorität=2');
})().catch(err => { console.error('\n❌', err.message); process.exit(1); });
