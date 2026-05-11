/**
 * SpoxHub — Airtable Schema Setup
 *
 * Creates 4 tables for Sessions/Bookings/Customers/Bikes and links them.
 * Idempotent: existing tables are preserved, missing fields are added.
 *
 * Requires env vars:
 *   AIRTABLE_TOKEN      — PAT with scopes: schema.bases:write, data.records:write
 *   AIRTABLE_BASE_ID    — target base id (appXXXXXX)
 *
 * Usage:
 *   node scripts/setup-airtable.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const META = 'https://api.airtable.com/v0/meta';

if (!TOKEN || !BASE_ID) {
  console.error('❌ Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in .env');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${url} → ${res.status}: ${msg}`);
  }
  return data;
}

const listTables = () => api('GET', `${META}/bases/${BASE_ID}/tables`);
const createTable = (body) => api('POST', `${META}/bases/${BASE_ID}/tables`, body);
const addField = (tableId, body) => api('POST', `${META}/bases/${BASE_ID}/tables/${tableId}/fields`, body);

// ─────────────────────────────────────────────────────────────────────────────
// Field type shorthands
// ─────────────────────────────────────────────────────────────────────────────

const txt        = (name)        => ({ name, type: 'singleLineText' });
const longText   = (name)        => ({ name, type: 'multilineText' });
const email      = (name)        => ({ name, type: 'email' });
const phone      = (name)        => ({ name, type: 'phoneNumber' });
const url        = (name)        => ({ name, type: 'url' });
const number     = (name, precision = 0) => ({ name, type: 'number', options: { precision } });
const currency   = (name)        => ({ name, type: 'currency', options: { precision: 2, symbol: '€' } });
const checkbox   = (name)        => ({ name, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } });
const attach     = (name)        => ({ name, type: 'multipleAttachments' });
const select     = (name, opts)  => ({
  name, type: 'singleSelect',
  options: { choices: opts.map(o => ({ name: o })) }
});
const dateTime   = (name)        => ({
  name, type: 'dateTime',
  options: {
    dateFormat: { name: 'european' },
    timeFormat: { name: '24hour' },
    timeZone: 'Europe/Berlin'
  }
});
const createdTime = (name)       => ({
  name, type: 'createdTime',
  options: {
    result: {
      type: 'dateTime',
      options: {
        dateFormat: { name: 'european' },
        timeFormat: { name: '24hour' },
        timeZone: 'Europe/Berlin'
      }
    }
  }
});
const link = (name, linkedTableId) => ({
  name, type: 'multipleRecordLinks',
  options: { linkedTableId }
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = {
  Customers: {
    description: 'SpoxHub Kunden-Stammdaten (Login-Referenz via Email)',
    fields: [
      email('Email'), // primary
      select('Anrede', ['Herr', 'Frau', 'Divers']),
      txt('Vorname'),
      txt('Nachname'),
      phone('Mobil'),
      txt('Strasse'),
      txt('PLZ'),
      txt('Ort'),
      txt('RechnungFirma'),
      txt('RechnungStrasse'),
      txt('RechnungPlz'),
      txt('RechnungOrt'),
      dateTime('CreatedAt')
    ]
  },

  Bikes: {
    description: 'Fahrräder pro Kunde (für spätere Mehrfach-Auswahl)',
    fields: [
      txt('Label'), // primary — "Marke Modell" oder ähnlich
      select('VehicleType', ['ebike', 'cargobike']),
      number('BidexKlasse'),
      txt('Marke'),
      txt('Modell'),
      txt('Farbe'),
      txt('Rahmennummer'),
      checkbox('IstLeasing'),
      txt('LeasingAnbieter'),
      txt('LeasingVertragsnr'),
      checkbox('IstVersichert'),
      txt('Versicherung'),
      txt('VersicherungVertragsnr'),
      attach('BikePhoto'),
      dateTime('CreatedAt')
    ]
  },

  Bookings: {
    description: 'Buchungen (erfolgreich abgeschlossene Sessions)',
    fields: [
      txt('BookingRef'), // primary — z.B. BK-YYMMDD-abc
      select('ServiceType', ['inspektion', 'reparatur']),
      longText('Services'),
      longText('ServiceIDs'),
      longText('ProblemDescription'),
      attach('ProblemMedia'),
      select('LocationType', ['mobil', 'anderer_ort', 'werkstatt']),
      txt('Address'),
      currency('EstimatedPrice'),
      currency('TravelFee'),
      currency('DepositAmount'),
      checkbox('DepositPaid'),
      dateTime('SelectedSlot'),
      txt('EterminBookingID'),
      txt('PayPalOrderID'),
      select('Status', ['pending', 'confirmed', 'cancelled']),
      checkbox('AGBAccepted'),
      checkbox('PrivacyAccepted'),
      checkbox('NewsletterOptIn'),
      dateTime('CreatedAt')
    ]
  },

  Sessions: {
    description: 'Analytics: jeder Besucher → eine Session (inkl. Abbrüche)',
    fields: [
      txt('SessionID'), // primary
      dateTime('StartedAt'),
      dateTime('LastUpdatedAt'),
      txt('LastScreen'),
      longText('ScreenHistory'),
      checkbox('Completed'),
      txt('UserAgent'),
      url('Referrer')
    ]
  }
};

// Link fields — added in pass 2 after all tables exist
const LINKS = [
  // tableName, linkFieldName, targetTableName
  ['Bikes',    'Customer', 'Customers'],
  ['Bookings', 'Customer', 'Customers'],
  ['Bookings', 'Bike',     'Bikes'],
  ['Sessions', 'Customer', 'Customers'],
  ['Sessions', 'Booking',  'Bookings']
];

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n🔧 Airtable setup — base ${BASE_ID}\n`);

  // 1. Inventory existing tables
  const { tables: existing } = await listTables();
  const byName = new Map(existing.map(t => [t.name, t]));
  console.log(`Found ${existing.length} existing table(s).`);

  const tableIds = {}; // name → id

  // 2. Create missing tables (pass 1: non-link fields only)
  for (const [name, def] of Object.entries(SCHEMA)) {
    if (byName.has(name)) {
      const t = byName.get(name);
      tableIds[name] = t.id;
      console.log(`  ✓ ${name} (exists) → ${t.id}`);
      // Add any missing fields
      const existingFieldNames = new Set(t.fields.map(f => f.name));
      for (const field of def.fields) {
        if (!existingFieldNames.has(field.name)) {
          try {
            await addField(t.id, field);
            console.log(`     + added field: ${field.name}`);
          } catch (e) {
            console.warn(`     ! field ${field.name}: ${e.message}`);
          }
        }
      }
    } else {
      const created = await createTable({
        name,
        description: def.description,
        fields: def.fields
      });
      tableIds[name] = created.id;
      console.log(`  ✨ ${name} (created) → ${created.id}`);
    }
  }

  // 3. Re-read tables to get up-to-date field lists
  const { tables: refreshed } = await listTables();
  const byNameRefreshed = new Map(refreshed.map(t => [t.name, t]));

  // 4. Add link fields (pass 2)
  console.log('\nAdding link fields...');
  for (const [tableName, fieldName, targetName] of LINKS) {
    const table = byNameRefreshed.get(tableName);
    const targetId = tableIds[targetName];
    if (!table || !targetId) {
      console.warn(`  ! skip ${tableName}.${fieldName} (table or target missing)`);
      continue;
    }
    const hasField = table.fields.some(f => f.name === fieldName);
    if (hasField) {
      console.log(`  ✓ ${tableName}.${fieldName} (exists)`);
      continue;
    }
    try {
      await addField(table.id, link(fieldName, targetId));
      console.log(`  ✨ ${tableName}.${fieldName} → ${targetName}`);
    } catch (e) {
      console.warn(`  ! ${tableName}.${fieldName}: ${e.message}`);
    }
  }

  // 5. Output env vars
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Add these to your .env:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`AIRTABLE_CUSTOMERS_TABLE=${tableIds.Customers}`);
  console.log(`AIRTABLE_BIKES_TABLE=${tableIds.Bikes}`);
  console.log(`AIRTABLE_BOOKINGS_TABLE=${tableIds.Bookings}`);
  console.log(`AIRTABLE_SESSIONS_TABLE=${tableIds.Sessions}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('Done. ✅\n');
})().catch(err => {
  console.error('\n❌ Setup failed:', err.message, '\n');
  process.exit(1);
});
