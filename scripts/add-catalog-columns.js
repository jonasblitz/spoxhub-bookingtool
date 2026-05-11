/**
 * Adds two columns (PreisZusatz, DauerZusatz) to the catalog table for
 * marginal pricing of multi-quantity services.
 *
 * Usage: node scripts/add-catalog-columns.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const CATALOG_TABLE = 'tblxfZMerv61U0hjb';

if (!TOKEN || !BASE_ID) {
  console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in .env');
  process.exit(1);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} → ${res.status}: ${data?.error?.message || data?.error?.type || text}`);
  }
  return data;
}

(async () => {
  // 1. Read existing fields
  const tables = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`);
  const catalog = tables.tables.find(t => t.id === CATALOG_TABLE);
  if (!catalog) {
    console.error(`Table ${CATALOG_TABLE} not found.`);
    process.exit(1);
  }
  console.log(`Catalog table: ${catalog.name} (${catalog.id})`);
  const existingFields = new Set(catalog.fields.map(f => f.name));

  const NEW_FIELDS = [
    {
      name: 'PreisZusatz',
      type: 'number',
      options: { precision: 2 },
      description: 'Arbeitspreis pro zusätzlicher Einheit (ab 2.). Leer = wie 1× × Anzahl.'
    },
    {
      name: 'DauerZusatz',
      type: 'number',
      options: { precision: 0 },
      description: 'Arbeitsdauer (Minuten) pro zusätzlicher Einheit (ab 2.). Leer = wie 1× × Anzahl.'
    }
  ];

  for (const f of NEW_FIELDS) {
    if (existingFields.has(f.name)) {
      console.log(`  ✓ ${f.name} (already exists)`);
      continue;
    }
    await api(
      'POST',
      `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${CATALOG_TABLE}/fields`,
      f
    );
    console.log(`  ✨ ${f.name} added`);
  }

  console.log('\nDone. ✅\n');
})().catch(err => {
  console.error('\n❌', err.message, '\n');
  process.exit(1);
});
