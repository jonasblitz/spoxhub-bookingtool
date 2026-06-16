/**
 * Backfill: legt fehlende eTermin-Kontakte für alle Booking-Tool-Termine
 * vor dem Phase-2-Refactor (14.06.2026 17:38 Uhr) nach.
 *
 * Hintergrund: Die alte Reserve→Confirm-Pipeline arbeitete mit einem Hold-
 * Termin und einem PUT zur Bestätigung. eTermin's PUT updated den Termin,
 * legt aber KEINEN Eintrag in der Kontaktdatenbank (/contact) an. Die neue
 * Pipeline (Phase 2, ab 14.06.2026 17:38) macht direkt POST und löst die
 * Contact-Anlage aus.
 *
 * Dieses Skript ist die Aufholbewegung — idempotent: prüft pro Email, ob
 * der Kontakt schon existiert, und legt ihn nur an wenn er fehlt.
 *
 * - POST /contact mit firstname/lastname/email/phone (+ Adresse, falls da)
 * - dedup pro Email (mehrere Termine derselben Person → ein POST)
 * - skipt Hold-Reste (firstname='Reservierung') und Auto-Pausen
 * - kennzeichnet betroffene Termine NICHT (kein Risiko für Live-Daten)
 *
 * Usage:
 *   node scripts/backfill-contacts.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const etermin = require('../lib/etermin');

const DRY_RUN = process.argv.includes('--dry-run');
const SINCE_DATE = '2026-03-01';
const TO_DATE    = '2026-12-31';
const PHASE2_DEPLOY = '2026-06-14T17:38:00';
const CAL_IDS = [211614, 216919, 219019, 225270];

function authHdrs() {
  const pk = process.env.ETERMIN_PUBLIC_KEY;
  const priv = process.env.ETERMIN_PRIVATE_KEY;
  if (!pk || !priv) throw new Error('ETERMIN_PUBLIC_KEY / ETERMIN_PRIVATE_KEY missing');
  const salt = crypto.randomUUID();
  const sig = crypto.createHmac('sha256', priv).update(salt).digest('base64');
  return { publickey: pk, salt, signature: sig };
}

async function createContact({ firstname, lastname, email, phone, street, zip, city }) {
  const params = new URLSearchParams();
  if (firstname) params.set('firstname', firstname);
  if (lastname)  params.set('lastname',  lastname);
  if (email)     params.set('email',     email);
  if (phone)     params.set('phone',     phone);
  if (street)    params.set('street',    street);
  if (zip)       params.set('zip',       zip);
  if (city)      params.set('city',      city);

  const r = await fetch(`https://www.etermin.net/api/contact?${params}`, {
    method: 'POST',
    headers: authHdrs()
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`POST /contact → ${r.status} ${txt.slice(0, 200)}`);
  // eTermin antwortet mit XML <response><id>...</id></response>
  const m = txt.match(/<id>(\d+)<\/id>/);
  return m ? m[1] : null;
}

(async () => {
  console.log(`backfill-contacts  (DRY_RUN=${DRY_RUN})\n`);

  // 1. Sammeln: alle Booking-Tool-Termine mit Email aus dem Zeitfenster
  const all = [];
  for (const cal of CAL_IDS) {
    const apts = await etermin.getAppointments(cal, SINCE_DATE, TO_DATE).catch(() => []);
    for (const a of apts) {
      if (!a.Email) continue;
      if (!(a.Notes || '').includes('══')) continue; // nicht unser Booking-Tool
      if (a.FirstName === 'Reservierung') continue;
      if (a.FirstName === 'Auto' && a.LastName === 'Mittagspause') continue;
      if (!a.CreationDate || a.CreationDate >= PHASE2_DEPLOY) continue; // nur die alte Pipeline
      all.push(a);
    }
  }
  console.log(`Booking-Tool-Termine vor Phase 2 (mit Email): ${all.length}`);

  // 2. Dedup pro Email (lowercased) — den jüngsten Termin pro Person nehmen
  // (damit wir die aktuellsten Stammdaten verwenden falls es Updates gab)
  const byEmail = new Map();
  for (const a of all) {
    const key = String(a.Email).trim().toLowerCase();
    const prev = byEmail.get(key);
    if (!prev || (a.CreationDate || '') > (prev.CreationDate || '')) byEmail.set(key, a);
  }
  console.log(`Unique Emails: ${byEmail.size}`);

  // 3. Für jeden Eintrag: schon in /contact? Wenn nein, anlegen.
  let created = 0, exists = 0, failed = 0;
  const failures = [];
  for (const [emailLC, apt] of byEmail) {
    try {
      const existing = await etermin.findContactByEmail(emailLC);
      if (existing) { exists++; continue; }

      const payload = {
        firstname: (apt.FirstName || '').trim(),
        lastname:  (apt.LastName  || '').trim(),
        email:     emailLC,
        phone:     (apt.Phone || '').trim(),
        street:    (apt.Street || '').trim(),
        zip:       (apt.ZIP || '').trim(),
        city:      (apt.Town || '').trim()
      };

      if (DRY_RUN) {
        console.log(`  [dry] would create  ${(payload.firstname + ' ' + payload.lastname).padEnd(35).slice(0,35)} | ${emailLC}`);
        created++;
      } else {
        const id = await createContact(payload);
        created++;
        console.log(`  ✓ cid=${id}  ${(payload.firstname + ' ' + payload.lastname).padEnd(35).slice(0,35)} | ${emailLC}`);
      }
    } catch (err) {
      failed++;
      failures.push({ email: emailLC, error: err.message });
      console.log(`  ✗ ${emailLC}: ${err.message.slice(0, 100)}`);
    }
  }

  console.log(`\nBilanz: ${created} created, ${exists} already existed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFehler-Details:');
    failures.forEach(f => console.log(`  - ${f.email}: ${f.error}`));
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
