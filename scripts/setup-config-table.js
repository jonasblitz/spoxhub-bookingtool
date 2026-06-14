/**
 * Creates / migrates the "Konfiguration" table in Airtable.
 *
 * KV-Style Single-Row-Tabelle für globale Pricing- und Buffer-Konstanten,
 * die heute noch im Code stehen. lib/config.js liest daraus.
 *
 * Felder = Phase 1 des Visuellen Logik-Editors (siehe
 * /Users/jonpro/.claude/plans/tranquil-crunching-trinket.md).
 *
 * Run once:
 *   node scripts/setup-config-table.js
 *
 * Idempotent: legt die Tabelle nur an wenn sie fehlt, ergänzt fehlende Felder,
 * lässt vorhandene Daten unberührt. Beim allerersten Lauf wird genau ein
 * Datensatz mit den aktuellen Code-Defaults angelegt.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = 'Konfiguration';

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

// Field definitions — exact current code defaults as initial values.
const FIELDS = [
  { name: 'Label',                      type: 'singleLineText',
    description: 'Datensatzname (z.B. "global" oder Mandant). lib/config.js nimmt den ersten Record.' },

  { name: 'TravelFeeEUR',               type: 'number', options: { precision: 2 },
    description: 'Anfahrts-Pauschale für mobilen Service (€). Heute: routes/api-geo.js TRAVEL_FEE_EUR = 20.' },

  { name: 'DepositAmountEUR',           type: 'number', options: { precision: 2 },
    description: 'PayPal-Anzahlung pro Buchung (€). Heute: routes/api-paypal.js DEPOSIT_AMOUNT = 20.00.' },

  { name: 'InspektionFreeMinutes',      type: 'number', options: { precision: 0 },
    description: 'Bonus-Arbeitsminuten frei wenn Inspektion im Warenkorb. Heute: lib/pricing.js INSPEKTION_FREE_MINUTES = 60.' },

  { name: 'RatePerMinuteEUR',           type: 'number', options: { precision: 2 },
    description: 'Standard-Arbeits-Minutensatz (€/min) für Überlauf-Pricing. Heute: lib/pricing.js RATE_PER_MINUTE = 2.' },

  { name: 'AppointmentBufferMinutes',   type: 'number', options: { precision: 0 },
    description: 'Einmaliger Puffer pro Auftrag (Aufräumen/Übergeben). Heute: lib/pricing.js APPOINTMENT_BUFFER_MINUTES = 15.' },

  { name: 'TravelBufferMinutesDefault', type: 'number', options: { precision: 0 },
    description: 'Fallback-Travel-Buffer zwischen mobilen Terminen, wenn pro Kalender nicht gesetzt. Heute hartkodiert 25 in lib/slots.js und lib/etermin.js.' },

  { name: 'UpdatedAt',                  type: 'dateTime',
    options: { timeZone: 'Europe/Berlin', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
    description: 'Wird vom Portal beim Save gesetzt. Audit-Hinweis.' }
];

// Code-Defaults — werden beim allerersten Anlegen als Initial-Record geschrieben.
const INITIAL_RECORD_FIELDS = {
  Label: 'global',
  TravelFeeEUR: 20,
  DepositAmountEUR: 20,
  InspektionFreeMinutes: 60,
  RatePerMinuteEUR: 2,
  AppointmentBufferMinutes: 15,
  TravelBufferMinutesDefault: 25,
  UpdatedAt: new Date().toISOString()
};

(async () => {
  console.log(`→ Checking base ${BASE} for existing "${TABLE_NAME}" table...`);
  const meta = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  let table = meta.tables.find(t => t.name === TABLE_NAME);

  if (table) {
    console.log(`✓ Table "${TABLE_NAME}" already exists (${table.id})`);
    const existingNames = new Set(table.fields.map(f => f.name));
    const missing = FIELDS.filter(f => !existingNames.has(f.name));
    if (missing.length === 0) {
      console.log('✓ All fields present — nothing to add.');
    } else {
      console.log(`→ Adding ${missing.length} missing fields...`);
      for (const f of missing) {
        try {
          await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${table.id}/fields`, f);
          console.log(`  + ${f.name} (${f.type})`);
        } catch (err) {
          console.error(`  ✗ ${f.name}: ${err.message}`);
        }
      }
    }
  } else {
    console.log(`→ Creating table "${TABLE_NAME}"...`);
    const created = await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
      name: TABLE_NAME,
      description: 'Globale Konfiguration für das Booking-Tool. Single-Row (Label="global"). Edit aus dem Spoxhub-Portal.',
      fields: FIELDS
    });
    table = created;
    console.log(`✓ Created (${table.id})`);
  }

  // Initial-Record nur anlegen, wenn die Tabelle leer ist.
  const records = await api('GET', `https://api.airtable.com/v0/${BASE}/${table.id}?pageSize=1`);
  if ((records.records || []).length === 0) {
    console.log('→ Empty table — inserting initial "global" record with current code defaults...');
    const ins = await api('POST', `https://api.airtable.com/v0/${BASE}/${table.id}`, {
      records: [{ fields: INITIAL_RECORD_FIELDS }],
      typecast: true
    });
    console.log(`✓ Inserted record ${ins.records?.[0]?.id}`);
  } else {
    console.log(`✓ Table already has ${records.records.length}+ record(s) — keeping data as-is.`);
  }

  console.log('\n────────────────────────────────────────────────');
  console.log(`Optional .env line (lib/config.js findet die Tabelle auch ohne — über den Namen "${TABLE_NAME}"):`);
  console.log(`AIRTABLE_CONFIG_TABLE=${table.id}`);
  console.log('────────────────────────────────────────────────');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
