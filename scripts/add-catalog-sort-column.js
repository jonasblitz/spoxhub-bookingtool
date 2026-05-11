/**
 * Adds a KategorieSortOrder (number) column to the catalog table
 * (tblxfZMerv61U0hjb).
 *
 * Per row: enter the desired sort position of that row's Kategorie.
 * The backend uses the MIN value across all rows of a Kategorie to
 * determine the group order — so you only need to make sure that all
 * rows of the same Kategorie have the same value (or at least the
 * lowest you want to use).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TBL = 'tblxfZMerv61U0hjb';
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;

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
  if (!t) { console.error('Table not found'); process.exit(1); }
  console.log(`Table: ${t.name}`);
  if (t.fields.some(f => f.name === 'KategorieSortOrder')) {
    console.log('  ✓ KategorieSortOrder (exists)');
    return;
  }
  await api('POST', `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${TBL}/fields`, {
    name: 'KategorieSortOrder',
    type: 'number',
    options: { precision: 0 },
    description: 'Reihenfolge der Kategorie (kleiner = weiter oben). Pro Zeile dieselbe Zahl für jede Kategorie eingeben.'
  });
  console.log('  ✨ KategorieSortOrder added');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
