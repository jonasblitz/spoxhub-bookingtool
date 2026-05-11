/**
 * DSGVO-Cleanup — löscht abgebrochene Sessions älter als 90 Tage
 * und verwaiste Customer/Bike-Records, die keine Buchung mehr haben.
 *
 * Geplant als täglicher Cron (z.B. 03:00 auf dem Produktionsserver):
 *   0 3 * * * cd /opt/spoxhub/bookingTool && /usr/bin/node scripts/cleanup-abandoned.js >> /var/log/spoxhub-cleanup.log 2>&1
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const RETENTION_DAYS = 90;

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const SESSIONS  = process.env.AIRTABLE_SESSIONS_TABLE;
const CUSTOMERS = process.env.AIRTABLE_CUSTOMERS_TABLE;
const BIKES     = process.env.AIRTABLE_BIKES_TABLE;

if (!TOKEN || !BASE_ID || !SESSIONS || !CUSTOMERS || !BIKES) {
  console.error('❌ Missing Airtable config — check .env for TOKEN, BASE_ID, SESSIONS/CUSTOMERS/BIKES table IDs');
  process.exit(1);
}

const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}`;

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
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${data?.error?.message || data?.error?.type || text}`);
  }
  return data;
}

async function listAllRecords(tableId, filterFormula) {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filterFormula) params.set('filterByFormula', filterFormula);
    if (offset) params.set('offset', offset);
    const data = await api('GET', `${BASE_URL}/${tableId}?${params.toString()}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function deleteRecords(tableId, recordIds) {
  // Airtable limit: 10 per DELETE call
  let deleted = 0;
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const params = new URLSearchParams();
    batch.forEach(id => params.append('records[]', id));
    const data = await api('DELETE', `${BASE_URL}/${tableId}?${params.toString()}`);
    deleted += (data.records || []).length;
  }
  return deleted;
}

(async () => {
  console.log(`\n🧹 DSGVO cleanup — retention ${RETENTION_DAYS} days — ${new Date().toISOString()}\n`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffISO = cutoff.toISOString();

  // 1. Find abandoned sessions older than cutoff
  // Abandoned = Completed is falsy AND LastUpdatedAt < cutoff
  const filter = `AND(NOT({Completed}), IS_BEFORE({LastUpdatedAt}, '${cutoffISO}'))`;
  const oldSessions = await listAllRecords(SESSIONS, filter);
  console.log(`Found ${oldSessions.length} abandoned session(s) older than ${RETENTION_DAYS} days.`);

  // Collect linked Customer IDs so we can clean up orphans next
  const touchedCustomerIds = new Set();
  for (const s of oldSessions) {
    (s.fields.Customer || []).forEach(id => touchedCustomerIds.add(id));
  }

  // 2. Delete old sessions
  if (oldSessions.length > 0) {
    const deletedSessions = await deleteRecords(SESSIONS, oldSessions.map(r => r.id));
    console.log(`✓ Deleted ${deletedSessions} session(s).`);
  }

  // 3. Orphan customers: no Bookings, no Sessions left
  let orphanCustomers = 0;
  let orphanBikes = 0;
  for (const customerId of touchedCustomerIds) {
    const cust = await api('GET', `${BASE_URL}/${CUSTOMERS}/${customerId}`).catch(() => null);
    if (!cust) continue;
    const bookings = cust.fields.Bookings || [];
    const sessions = cust.fields.Sessions || [];
    if (bookings.length === 0 && sessions.length === 0) {
      // Delete associated bikes that also have no bookings
      const bikeIds = cust.fields.Bikes || [];
      const orphanBikeIds = [];
      for (const bid of bikeIds) {
        const bike = await api('GET', `${BASE_URL}/${BIKES}/${bid}`).catch(() => null);
        if (bike && (bike.fields.Bookings || []).length === 0) {
          orphanBikeIds.push(bid);
        }
      }
      if (orphanBikeIds.length) {
        const n = await deleteRecords(BIKES, orphanBikeIds);
        orphanBikes += n;
      }
      // Delete the customer
      await deleteRecords(CUSTOMERS, [customerId]);
      orphanCustomers += 1;
    }
  }

  console.log(`✓ Deleted ${orphanCustomers} orphan customer(s).`);
  console.log(`✓ Deleted ${orphanBikes} orphan bike(s).`);
  console.log('\nDone. ✅\n');
})().catch(err => {
  console.error('\n❌ Cleanup failed:', err.message, '\n');
  process.exit(1);
});
