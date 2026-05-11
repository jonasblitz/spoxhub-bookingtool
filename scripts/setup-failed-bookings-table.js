/**
 * Creates the "FailedBookings" table in Airtable so we can log every
 * booking that fails AFTER PayPal capture (so customer data + refund
 * status are recoverable even if auto-refund itself fails).
 *
 * Run once:
 *   node scripts/setup-failed-bookings-table.js
 *
 * Then put the printed table-ID into .env as:
 *   AIRTABLE_FAILED_BOOKINGS_TABLE=tbl...
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = 'FailedBookings';

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

const FIELDS = [
  { name: 'CreatedAt',         type: 'dateTime', options: { timeZone: 'Europe/Berlin', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } } },
  { name: 'CustomerName',      type: 'singleLineText' },
  { name: 'CustomerEmail',     type: 'email' },
  { name: 'CustomerPhone',     type: 'phoneNumber' },
  { name: 'Bike',              type: 'singleLineText' },
  { name: 'Services',          type: 'multilineText' },
  { name: 'SelectedSlot',      type: 'dateTime', options: { timeZone: 'Europe/Berlin', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } } },
  { name: 'LocationType',      type: 'singleLineText' },
  { name: 'Address',           type: 'singleLineText' },
  { name: 'EstimatedPrice',    type: 'currency', options: { symbol: '€', precision: 2 } },
  { name: 'DepositAmount',     type: 'currency', options: { symbol: '€', precision: 2 } },
  { name: 'PayPalOrderID',     type: 'singleLineText' },
  { name: 'PayPalCaptureID',   type: 'singleLineText' },
  { name: 'ErrorMessage',      type: 'multilineText' },
  { name: 'RefundStatus',      type: 'singleSelect', options: { choices: [
      { name: 'refunded', color: 'greenLight2' },
      { name: 'failed',   color: 'redLight2' },
      { name: 'skipped',  color: 'grayLight2' }
    ] } },
  { name: 'RefundID',          type: 'singleLineText' },
  { name: 'RefundError',       type: 'multilineText' },
  { name: 'Status',            type: 'singleSelect', options: { choices: [
      { name: 'open',         color: 'redLight2' },
      { name: 'refunded',     color: 'yellowLight2' },
      { name: 'rebooked',     color: 'greenLight2' },
      { name: 'closed',       color: 'grayLight2' }
    ] } },
  { name: 'Notes',             type: 'multilineText' }
];

(async () => {
  console.log(`→ Checking base ${BASE} for existing "${TABLE_NAME}" table...`);
  const meta = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  let table = meta.tables.find(t => t.name === TABLE_NAME);

  if (table) {
    console.log(`✓ Table "${TABLE_NAME}" already exists (${table.id})`);
    const existingNames = new Set(table.fields.map(f => f.name));
    const missing = FIELDS.filter(f => !existingNames.has(f.name));
    if (missing.length === 0) {
      console.log('✓ All fields present — nothing to do.');
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
      description: 'Booking attempts that failed after PayPal capture. Auto-populated by booking flow when eTermin call fails.',
      fields: FIELDS
    });
    table = created;
    console.log(`✓ Created (${table.id})`);
  }

  console.log('\n────────────────────────────────────────────────');
  console.log(`Add this to .env:`);
  console.log(`AIRTABLE_FAILED_BOOKINGS_TABLE=${table.id}`);
  console.log('────────────────────────────────────────────────');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
