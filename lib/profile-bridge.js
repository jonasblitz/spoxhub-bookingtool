/**
 * Profile-Bridge — überträgt Bestandskunden-Daten in die Spoxhub-
 * Supabase (`public.customers`, `bicycles`, `addresses`, `contact_details`),
 * sobald ein Kunde sich erstmals einloggt.
 *
 * Quellen pro Email (Reihenfolge der Bevorzugung):
 *   1. Airtable Customers (strukturierter, vom Booking-Tool gepflegt)
 *   2. eTermin /contact (älter, 983 Bestandskontakte)
 * + Airtable Bikes (letzter Eintrag pro Customer) für Fahrrad-Stammdaten.
 *
 * Idempotent: prüft erst, ob bereits ein public.customers-Row mit
 * dem gegebenen user_id existiert. Wenn ja, wird nur ein Stub-Profile
 * zurückgegeben, keine Daten überschrieben.
 *
 * Wird typischerweise vom ersten /api/account/profile-Aufruf getriggert.
 */

const etermin = require('./etermin');
const supabase = require('./supabase');

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

function envTables() {
  return {
    customers: process.env.AIRTABLE_CUSTOMERS_TABLE,
    bikes:     process.env.AIRTABLE_BIKES_TABLE,
    bookings:  process.env.AIRTABLE_BOOKINGS_TABLE
  };
}

async function airtableGet(table, params = '') {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId || !table) return null;
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${table}${params}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    console.warn(`[bridge] Airtable GET ${url.split('?')[0]} → ${r.status}`);
    return null;
  }
  return r.json();
}

function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}

async function findAirtableCustomerByEmail(email) {
  const { customers } = envTables();
  if (!customers) return null;
  const filter = `LOWER({Email})='${escapeFormulaString(String(email).toLowerCase())}'`;
  const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=1`;
  const data = await airtableGet(customers, params);
  return data?.records?.[0] || null;
}

async function findLatestAirtableBikeForCustomer(customerRecId) {
  const { bikes } = envTables();
  if (!bikes || !customerRecId) return null;
  // Customer ist als linked-record gespeichert — wir filtern per FIND
  const filter = `FIND('${escapeFormulaString(customerRecId)}', ARRAYJOIN({Customer}))`;
  const sort = '&sort%5B0%5D%5Bfield%5D=CreatedAt&sort%5B0%5D%5Bdirection%5D=desc';
  const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=5${sort}`;
  const data = await airtableGet(bikes, params);
  return data?.records?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge-Helper: pickt das erste truthy aus mehreren Quellen.
// ─────────────────────────────────────────────────────────────────────────────
function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stellt sicher, dass für die gegebene auth-User eine public.customers-Row
 * existiert. Beim ersten Aufruf werden Bestandsdaten aus Airtable/eTermin
 * übernommen. Folgeaufrufe sind no-ops (gibt die bereits angelegte Row
 * zurück).
 *
 * @param {{ id: string, email: string }} authUser
 * @returns {Promise<{ customer, bicycles }>} Profil-Snapshot aus Supabase.
 */
async function ensureProfile(authUser) {
  if (!authUser?.id) throw new Error('ensureProfile: authUser.id missing');
  const admin = supabase.getAdminClient();

  // 1. Existiert schon?
  const { data: existing, error: e1 } = await admin
    .from('customers').select('*')
    .eq('user_id', authUser.id).limit(1).maybeSingle();
  if (e1) throw new Error(`Supabase select customers: ${e1.message}`);

  let customer = existing;
  let isNew = false;

  if (!customer) {
    isNew = true;
    customer = await createProfileFromExternalData(authUser);
  }

  // 2. Bicycles laden
  const { data: bicycles, error: e2 } = await admin
    .from('bicycles').select('*')
    .eq('customer_id', customer.id).order('created_at', { ascending: false });
  if (e2) console.warn('[bridge] select bicycles:', e2.message);

  return { customer, bicycles: bicycles || [], isNew };
}

async function createProfileFromExternalData(authUser) {
  const email = String(authUser.email || '').trim();
  if (!email) throw new Error('createProfileFromExternalData: email missing on authUser');

  // 1. Lookup parallel
  const [atCustomer, etContact] = await Promise.all([
    findAirtableCustomerByEmail(email).catch(() => null),
    etermin.findContactByEmail(email).catch(() => null)
  ]);

  const a = atCustomer?.fields || {};
  const e = etContact || {};

  // 2. Stammdaten mergen (Airtable bevorzugt)
  const first_name = pickFirst(a.Vorname, e.FirstName);
  const last_name  = pickFirst(a.Nachname, e.LastName);

  const external_booking_id = atCustomer?.id
    ? `airtable:${atCustomer.id}`
    : etContact?.cid ? `etermin:${etContact.cid}` : null;

  const admin = supabase.getAdminClient();

  // 3. Customer-Row anlegen
  const { data: cust, error: ec } = await admin.from('customers').insert({
    user_id: authUser.id,
    first_name,
    last_name,
    external_booking_id,
    preferred_language: 'de'
  }).select('*').single();
  if (ec) throw new Error(`Supabase insert customers: ${ec.message}`);

  // 4. Adresse (home + optional billing) via EAV
  const homeAddr = {
    street: pickFirst(a.Strasse, e.Street),
    zip:    pickFirst(a.PLZ,     e.ZIP),
    city:   pickFirst(a.Ort,     e.City)
  };
  if (homeAddr.street || homeAddr.zip || homeAddr.city) {
    const { error } = await admin.from('addresses').insert({
      entity_type: 'customer', entity_id: cust.id,
      address_type: 'home', is_primary: true,
      street: homeAddr.street, zip: homeAddr.zip, city: homeAddr.city,
      country: 'DE'
    });
    if (error) console.warn('[bridge] insert home address:', error.message);
  }
  if (a.RechnungStrasse || a.RechnungFirma) {
    const { error } = await admin.from('addresses').insert({
      entity_type: 'customer', entity_id: cust.id,
      address_type: 'billing', is_primary: false,
      company: a.RechnungFirma || null,
      street:  a.RechnungStrasse || null,
      zip:     a.RechnungPlz || null,
      city:    a.RechnungOrt || null,
      country: 'DE'
    });
    if (error) console.warn('[bridge] insert billing address:', error.message);
  }

  // 5. Kontaktdaten (Email + Telefon)
  const detailRows = [];
  detailRows.push({
    entity_type: 'customer', entity_id: cust.id,
    detail_type: 'email', value: email, is_primary: true
  });
  const phone = pickFirst(a.Mobil, e.Phone);
  if (phone) {
    detailRows.push({
      entity_type: 'customer', entity_id: cust.id,
      detail_type: 'phone', value: phone, label: 'mobile', is_primary: true
    });
  }
  {
    const { error } = await admin.from('contact_details').insert(detailRows);
    if (error) console.warn('[bridge] insert contact_details:', error.message);
  }

  // 6. Letztes Fahrrad — Airtable Bikes (linked vom Customer) bevorzugt,
  //    eTermin /contact Additional als Fallback.
  let bikeData = null;
  if (atCustomer?.id) {
    const bike = await findLatestAirtableBikeForCustomer(atCustomer.id).catch(() => null);
    if (bike?.fields) {
      const f = bike.fields;
      bikeData = {
        make:                       f.Marke || null,
        model:                      f.Modell || null,
        color:                      f.Farbe || null,
        frame_number:               f.Rahmennummer || null,
        leasing_provider:           f.LeasingAnbieter || null,
        leasing_contract_number:    f.LeasingVertragsnr || null,
        insurer_name:               f.Versicherung || null,
        insurance_number:           f.VersicherungVertragsnr || null,
        bidex_class:                f.BidexKlasse != null ? String(f.BidexKlasse) : null,
        external_ref:               `airtable:${bike.id}`
      };
    }
  }
  if (!bikeData && (e.Additional1 || e.Additional2)) {
    bikeData = {
      make:                    e.Additional1 || null,
      model:                   e.Additional2 || null,
      frame_number:            e.Additional3 || null,
      leasing_provider:        e.Additional4 || null,
      leasing_contract_number: e.Additional5 || null,
      insurer_name:            e.Additional16 || null,
      insurance_number:        e.Additional17 || null,
      external_ref:            `etermin:${e.cid || ''}`
    };
  }
  if (bikeData) {
    bikeData.customer_id = cust.id;
    const { error } = await admin.from('bicycles').insert(bikeData);
    if (error) console.warn('[bridge] insert bicycle:', error.message);
  }

  console.log(`[bridge] new profile for user ${authUser.id} (email=${email}) — ext=${external_booking_id || 'none'}, bike=${bikeData ? 'yes' : 'no'}`);
  return cust;
}

module.exports = { ensureProfile };
