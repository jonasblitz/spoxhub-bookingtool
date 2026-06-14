/**
 * Wiederherstellung der 5 Buchungen, die wegen des PUT/UUID-Bugs verloren
 * gingen (Cleanup-Cron hat die Reservierungen gelöscht, weil das
 * `confirmReservation` PUT silent fehlgeschlagen ist).
 *
 * Liest aus Airtable Bookings + verknüpfte Customer + Bike Records, baut den
 * State neu zusammen und ruft etermin.createAppointment() auf — diesmal als
 * "echte" Buchung mit appattrib=1/sync=1 von Anfang an.
 *
 * Anschließend wird in Airtable die EterminBookingID aktualisiert und ein
 * Recovery-Vermerk im Notes-Feld hinzugefügt.
 *
 * Usage:
 *   node scripts/recover-lost-bookings.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const etermin = require('../lib/etermin');
const calendars = require('../lib/calendars');

const DRY_RUN = process.argv.includes('--dry-run');

const LOST_RESERVATION_IDS = [
  '3c681c70-fcdb-4f6c-82e1-9147324b5a1f',
  '3efcbcb4-f342-4e28-850a-6aa162af1403',
  'e5f694aa-32cb-4a85-aa67-ce5e40610b14',
  'd23f1176-9110-400a-9676-fe8b13c1b1dd',
  '654e38ea-05e0-40df-b56d-661fee294036'
];

const TOKEN  = process.env.AIRTABLE_TOKEN;
const BASE   = process.env.AIRTABLE_BASE_ID;
const T_BOOK = process.env.AIRTABLE_BOOKINGS_TABLE;
const T_CUST = process.env.AIRTABLE_CUSTOMERS_TABLE;
const T_BIKE = process.env.AIRTABLE_BIKES_TABLE;
const T_CATALOG = 'tblxfZMerv61U0hjb';  // catalog table; Service-Record holds EterminID

async function atGet(table, recordId) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${table}/${recordId}`, {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  if (!r.ok) throw new Error(`Airtable GET ${table}/${recordId}: ${r.status}`);
  return r.json();
}

async function atPatch(table, recordId, fields) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${table}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`Airtable PATCH ${table}/${recordId}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Map our internal Kalender entry to an eTermin calendar ID for a given
// booking. Mobile = Blitz 1; Werkstatt = least-busy active workshop.
async function pickCalendarFor(locationType, slotDate) {
  if (locationType === 'mobil' || locationType === 'anderer_ort') {
    const mob = await calendars.getActiveMobileCalendars();
    return mob[0]?.id;
  }
  const ws = await calendars.getActiveWorkshopCalendars();
  return ws[0]?.id;
}

function fmtDt(isoLike) {
  // "2026-05-13T10:00:00.000Z" → "2026-05-13 10:00" (eTermin format)
  const d = new Date(isoLike);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function addMinutes(isoLike, mins) {
  const d = new Date(isoLike);
  return new Date(d.getTime() + mins * 60_000).toISOString();
}

async function reconstructOne(reservationId) {
  // 1. Find booking by EterminBookingID
  const formula = `FIND('${reservationId}', {EterminBookingID})`;
  const url = `https://api.airtable.com/v0/${BASE}/${T_BOOK}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN }});
  const data = await r.json();
  const booking = data.records?.[0];
  if (!booking) {
    console.log(`  ✗ Booking ${reservationId} not found in Airtable`);
    return null;
  }

  const f = booking.fields;
  console.log(`  → ${f.BookingRef} (slot ${f.SelectedSlot})`);

  // 2. Resolve linked Customer + Bike
  const custId = f.Customer?.[0];
  const bikeId = f.Bike?.[0];
  const customer = custId ? (await atGet(T_CUST, custId)).fields : {};
  const bike     = bikeId ? (await atGet(T_BIKE, bikeId)).fields : {};

  // 3. Build state-like object for createAppointment
  const start = fmtDt(f.SelectedSlot);
  // Use estimated duration if available; else 60 min default.
  const durMin = 60;
  const end = fmtDt(addMinutes(f.SelectedSlot, durMin));

  // f.ServiceIDs are catalog *record* IDs (rec...) — we need to map them to
  // the EterminID stored on each catalog record.
  const catalogRecIds = String(f.ServiceIDs || '').split(',').filter(Boolean);
  const eterminServiceIds = [];
  for (const recId of catalogRecIds) {
    try {
      const catRec = await atGet(T_CATALOG, recId);
      const eid = catRec.fields?.EterminID;
      if (eid) eterminServiceIds.push(String(eid));
    } catch (e) {
      console.log(`    ⚠ couldn't resolve catalog rec ${recId}: ${e.message}`);
    }
  }

  const calendarId = await pickCalendarFor(f.LocationType, f.SelectedSlot);
  if (!calendarId) {
    console.log(`  ✗ no calendar resolved for locationType=${f.LocationType}`);
    return null;
  }

  const cMapped = {
    vorname:  customer.Vorname,
    name:     customer.Nachname,
    email:    customer.Email,
    mobil:    customer.Mobil,
    strasse:  customer.Strasse,
    plz:      customer.PLZ,
    ort:      customer.Ort,
    rechnungFirma:    customer.RechnungFirma,
    rechnungStrasse:  customer.RechnungStrasse,
    rechnungPlz:      customer.RechnungPlz,
    rechnungOrt:      customer.RechnungOrt
  };
  const bMapped = {
    marke: bike.Marke, modell: bike.Modell, rahmennummer: bike.Rahmennummer,
    leasing: bike.LeasingAnbieter, leasingNr: bike.LeasingVertragsnr,
    versicherung: bike.Versicherung, versicherungNr: bike.VersicherungVertragsnr
  };

  const notes = [
    '── WIEDERHERGESTELLT (Recovery 2026-05-13) ──',
    `Original-Buchung: ${f.BookingRef}`,
    '',
    '══ LEISTUNGEN ══',
    `- ${f.Services || '(keine Angabe)'}`,
    '',
    '══ FAHRZEUG ══',
    `${bMapped.marke || '—'}${bMapped.modell ? ' ' + bMapped.modell : ''}`,
    bMapped.rahmennummer ? `Rahmennummer: ${bMapped.rahmennummer}` : null,
    bMapped.leasing ? `Leasing: ${bMapped.leasing}${bMapped.leasingNr ? ' (Nr ' + bMapped.leasingNr + ')' : ''}` : null,
    '',
    '══ KUNDE ══',
    `${cMapped.vorname || ''} ${cMapped.name || ''}`.trim(),
    `${cMapped.email || ''} · ${cMapped.mobil || ''}`,
    `${cMapped.strasse || ''}, ${cMapped.plz || ''} ${cMapped.ort || ''}`,
    f.ProblemDescription ? '\n══ PROBLEM ══\n' + f.ProblemDescription : null,
    '',
    '══ PREIS & ZAHLUNG ══',
    `Anzahlung (PayPal): 20,00 €`,
    f.PayPalOrderID ? `PayPal Order-ID: ${f.PayPalOrderID}` : null
  ].filter(Boolean).join('\n');

  let appointmentLocation = '';
  if (f.LocationType !== 'werkstatt') {
    appointmentLocation = f.Address || '';
  }

  if (DRY_RUN) {
    console.log(`  DRY-RUN would create:`);
    console.log(`    cal=${calendarId}  start=${start}  end=${end}`);
    console.log(`    customer=${cMapped.vorname} ${cMapped.name} <${cMapped.email}>`);
    console.log(`    services=${eterminServiceIds.join(',')}`);
    return null;
  }

  const result = await etermin.createAppointment({
    calendarId,
    start, end,
    customer: cMapped,
    services: eterminServiceIds,
    notes,
    agbAccepted:        !!f.AGBAccepted,
    privacyAccepted:    !!f.PrivacyAccepted,
    newsletter:         !!f.NewsletterOptIn,
    feedbackPermission: true,
    bike: bMapped,
    payment: { orderId: f.PayPalOrderID, captureId: '', amount: f.DepositAmount, status: 'completed' },
    location: appointmentLocation
  });

  const newId = result.ID || result.IID || result.AppointmentID;
  console.log(`    ✓ created new appointment id=${newId}`);

  // Update booking record
  await atPatch(T_BOOK, booking.id, {
    EterminBookingID: newId,
    Status: 'confirmed'
  });
  console.log(`    ✓ booking record updated`);

  return { oldId: reservationId, newId, ref: f.BookingRef };
}

(async () => {
  console.log(`Recovery: ${LOST_RESERVATION_IDS.length} bookings  (DRY_RUN=${DRY_RUN})\n`);
  const summary = [];
  for (const oldId of LOST_RESERVATION_IDS) {
    console.log(`▸ ${oldId}`);
    try {
      const r = await reconstructOne(oldId);
      if (r) summary.push(r);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
    console.log('');
  }
  console.log('────────────────');
  console.log('Summary:');
  summary.forEach(s => console.log(`  ${s.ref}: ${s.oldId} → ${s.newId}`));
})().catch(err => { console.error('FATAL', err); process.exit(1); });
