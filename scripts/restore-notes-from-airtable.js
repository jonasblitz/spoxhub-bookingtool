/**
 * Wiederherstellung der Termin-Notes, die durch ein versehentliches PUT mit
 * minimalen Feldern auf das eTermin-Default-Template "tel:\n\nmail:..."
 * zurückgesetzt wurden.
 *
 * Strategie:
 *   - Lade alle eTermin-Apts seit "gestern" (CreationDate)
 *   - Filter: Notes match das beschädigte Template
 *   - Match an Airtable Bookings per (Email + Slot-Datum)
 *   - Bei 1 eindeutigem Match: PUT mit kompletten Daten (sendemail=0)
 *   - Andernfalls skip
 *
 * Usage:
 *   node scripts/restore-notes-from-airtable.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const etermin = require('../lib/etermin');

const DRY_RUN = process.argv.includes('--dry-run');

const T = process.env.AIRTABLE_TOKEN;
const B = process.env.AIRTABLE_BASE_ID;
const TB = process.env.AIRTABLE_BOOKINGS_TABLE;
const TC = process.env.AIRTABLE_CUSTOMERS_TABLE;
const TBK = process.env.AIRTABLE_BIKES_TABLE;

// eTermin speichert Notes mit LITERALEN \n (Backslash+n als Text). Das leere
// Customer-Template ist exakt diese 19-Zeichen-Sequenz. Manuelle Einträge
// haben zusätzlichen Text dahinter und werden so NICHT als "damaged" erkannt.
const DAMAGED_NOTES_EXACT = 'tel:\\n\\nmail:\\n\\n\\n';

function isDamagedNotes(notes) {
  if (!notes) return false;
  // Strip optional whitespace at edges
  return notes.trim() === DAMAGED_NOTES_EXACT;
}

async function atGet(table, id) {
  const r = await fetch(`https://api.airtable.com/v0/${B}/${table}/${id}`, {
    headers: { Authorization: 'Bearer ' + T }
  });
  if (!r.ok) throw new Error(`Airtable GET ${table}/${id}: ${r.status}`);
  return (await r.json()).fields;
}

async function fetchAll(table) {
  const out = [];
  let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${B}/${table}?pageSize=100${offset ? '&offset=' + offset : ''}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + T }});
    const d = await r.json();
    out.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return out;
}

let _bookings = null;
let _customers = null;
let _bikes = null;

async function loadAll() {
  if (_bookings) return;
  console.log('Loading Airtable data…');
  [_bookings, _customers, _bikes] = await Promise.all([
    fetchAll(TB), fetchAll(TC), fetchAll(TBK)
  ]);
  console.log(`  ${_bookings.length} bookings, ${_customers.length} customers, ${_bikes.length} bikes\n`);
}

function findCustomerByEmail(email) {
  if (!email) return null;
  const e = email.toLowerCase().trim();
  return _customers.find(c => String(c.fields.Email || '').toLowerCase().trim() === e) || null;
}

function findBookingsByCustomerAndDate(customerRecordId, dateStr) {
  return _bookings.filter(b => {
    const customerLinks = b.fields.Customer || [];
    if (!customerLinks.includes(customerRecordId)) return false;
    const s = b.fields.SelectedSlot || '';
    return s.startsWith(dateStr);
  });
}

function findBike(bikeId) {
  return _bikes.find(b => b.id === bikeId)?.fields || {};
}

function buildNotes({ booking, customer, bike }) {
  const f = booking.fields || booking;
  const fmtEur = n => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const sections = [];

  // Leistungen
  sections.push('══ LEISTUNGEN ══\n- ' + (f.Services || ''));

  // Problembeschreibung (nur wenn vorhanden)
  if (f.ProblemDescription) {
    sections.push('══ PROBLEMBESCHREIBUNG ══\n' + f.ProblemDescription.trim());
  }

  // Fahrzeug
  const vehLines = [
    [bike.Marke, bike.Modell].filter(Boolean).join(' ') || '—',
    bike.Rahmennummer ? 'Rahmennummer: ' + bike.Rahmennummer : null,
    bike.LeasingAnbieter ? 'Leasing: ' + bike.LeasingAnbieter + (bike.LeasingVertragsnr ? ' (Nr ' + bike.LeasingVertragsnr + ')' : '') : null,
    bike.Versicherung ? 'Versicherung: ' + bike.Versicherung + (bike.VersicherungVertragsnr ? ' (Nr ' + bike.VersicherungVertragsnr + ')' : '') : null
  ].filter(Boolean);
  sections.push('══ FAHRZEUG ══\n' + vehLines.join('\n'));

  // Kunde
  sections.push(
    '══ KUNDE ══\n' +
    (customer.Anrede ? customer.Anrede + ' ' : '') + customer.Vorname + ' ' + customer.Nachname + '\n' +
    customer.Email + ' · ' + customer.Mobil + '\n' +
    customer.Strasse + ', ' + customer.PLZ + ' ' + customer.Ort
  );

  // Service-Ort
  const loc = f.LocationType === 'werkstatt' ? 'Werkstatt' : 'Mobil';
  sections.push('══ SERVICE-ORT ══\n' + loc + (f.Address ? '\n' + f.Address : ''));

  // Preis & Zahlung
  const prc = [];
  if (f.EstimatedPrice != null) prc.push('Geschätzter Gesamtpreis: ' + fmtEur(f.EstimatedPrice));
  if (f.TravelFee > 0)         prc.push('   Anfahrtskosten:       ' + fmtEur(f.TravelFee));
  if (f.DepositAmount)         prc.push('Anzahlung (PayPal):       ' + fmtEur(f.DepositAmount));
  if (f.PayPalOrderID)         prc.push('PayPal Order-ID:          ' + f.PayPalOrderID);
  if (prc.length) sections.push('══ PREIS & ZAHLUNG ══\n' + prc.join('\n'));

  return sections.join('\n\n');
}

(async () => {
  console.log(`Restoration: DRY_RUN=${DRY_RUN}\n`);
  await loadAll();
  const cutoff = new Date('2026-05-12T00:00:00+02:00');
  const all = [];
  for (const cal of [211614, 216919, 219019, 225270]) {
    const apts = await etermin.getAppointments(cal, '2026-05-13', '2026-08-15').catch(() => []);
    for (const a of apts) {
      if (new Date(a.CreationDate) < cutoff) continue;
      if (!isDamagedNotes(a.Notes)) continue;  // not damaged
      all.push({ ...a, _calId: cal });
    }
  }

  console.log(`Found ${all.length} apt(s) with damaged notes.\n`);

  let restored = 0, skipped = 0;
  for (const a of all) {
    const ext = a.ExternalID;
    const email = a.Email;
    const dateStr = a.StartDateTime.slice(0, 10);
    const slot = a.StartDateTime.slice(11, 16);
    console.log(`▸ ${ext}  ${a.StartDateTime}  ${a.FirstName} ${a.LastName}  email=${email}`);

    if (!email) {
      console.log("    SKIP: no email — can't match to Airtable");
      skipped++; continue;
    }

    const cust = findCustomerByEmail(email);
    if (!cust) {
      console.log('    SKIP: no Airtable Customer for email');
      skipped++; continue;
    }

    const bookings = findBookingsByCustomerAndDate(cust.id, dateStr);
    if (bookings.length === 0) {
      console.log('    SKIP: no Booking for customer+date');
      skipped++; continue;
    }
    if (bookings.length > 1) {
      // Try to narrow by slot
      const exactSlot = bookings.filter(b => {
        const s = b.fields.SelectedSlot;
        return s && s.slice(11, 16) === slot;
      });
      if (exactSlot.length === 1) {
        bookings.splice(0, bookings.length, exactSlot[0]);
      } else {
        console.log(`    SKIP: ${bookings.length} bookings match (ambiguous)`);
        skipped++; continue;
      }
    }

    const booking = bookings[0];
    const customer = cust.fields;
    const bikeId = booking.fields.Bike?.[0];
    const bike = bikeId ? findBike(bikeId) : {};
    const notes = buildNotes({ booking, customer, bike });

    const fmt = iso => iso.replace('T', ' ').slice(0, 16);
    const fields = {
      calendarid: String(a._calId),
      start: fmt(a.StartDateTime),
      end:   fmt(a.EndDateTime),
      firstname: customer.Vorname || '',
      lastname:  customer.Nachname || '',
      email:     customer.Email || '',
      phone:     customer.Mobil || '',
      street:    customer.Strasse || '',
      zip:       customer.PLZ || '',
      city:      customer.Ort || '',
      notes,
      sync: '1',
      sendemail: '0',
      manualconfirmed: '1',
      appattrib: String(a.appattrib ?? 0),
      canceldeadline: '1440',
      location:  booking.fields.LocationType === 'werkstatt' ? '' : (booking.fields.Address || ''),
      additional1: bike.Marke || '',
      additional2: bike.Modell || '',
      additional3: bike.Rahmennummer || '',
      additional4: bike.LeasingAnbieter || '',
      additional5: bike.LeasingVertragsnr || '',
      additional9: booking.fields.PayPalOrderID || '',
      additional16: bike.Versicherung || '',
      additional17: bike.VersicherungVertragsnr || ''
    };

    console.log(`    → MATCH: Booking ${booking.fields.BookingRef}`);
    console.log(`      Will set name=${fields.firstname} ${fields.lastname}, email=${fields.email}`);
    console.log(`      Notes preview: ${notes.split('\\n').slice(0, 3).join(' | ')}`);

    if (DRY_RUN) { skipped++; continue; }

    try {
      await etermin.updateAppointment(ext, fields);
      console.log(`    ✓ restored`);
      restored++;
    } catch (err) {
      console.log(`    ✗ FAIL: ${err.message}`);
    }
    console.log('');
  }

  console.log(`────────────────`);
  console.log(`Done: ${restored} restored, ${skipped} skipped`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
