/**
 * Repariert die Foto-URLs in den eTermin-Notes für alle Termine ab 2026-05-15.
 *
 * Vor dem PUBLIC_BASE_URL-Fix lief der Booking-Confirm-Code mit
 * `http://spoxhub.io/uploads/<file>` — das ist ein toter Pfad (Nginx routet
 * /uploads/ nur unter /booking/uploads/). Dieses Skript ersetzt das Muster
 * per PUT in jedem betroffenen Termin durch `https://spoxhub.io/booking/uploads/<file>`.
 *
 * - PUT mit ALLEN existierenden Customer-/Additional-Feldern, damit eTermin
 *   sie nicht auf default zurücksetzt.
 * - sendemail=0 → keine Mail an Kunden.
 * - sync=1 → externer Kalender bekommt das Update.
 *
 * Usage:
 *   node scripts/fix-photo-urls.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const etermin = require('../lib/etermin');

const DRY_RUN = process.argv.includes('--dry-run');
const SINCE_DATE = '2026-05-15';
const CAL_IDS = [211614, 216919, 219019, 225270];

const fmtDt = iso => iso.replace('T', ' ').slice(0, 16);
const BROKEN_PATTERN = /http:\/\/spoxhub\.io\/uploads\//g;
const CORRECT_PREFIX = 'https://spoxhub.io/booking/uploads/';

(async () => {
  console.log(`fix-photo-urls  (DRY_RUN=${DRY_RUN})\n`);

  const targets = [];
  for (const cal of CAL_IDS) {
    const apts = await etermin.getAppointments(cal, SINCE_DATE, '2026-12-31').catch(() => []);
    for (const a of (apts || [])) {
      if (BROKEN_PATTERN.test(String(a.Notes || ''))) {
        BROKEN_PATTERN.lastIndex = 0;
        targets.push({ cal, apt: a });
      }
    }
  }
  console.log(`Found ${targets.length} appointments with broken photo URLs.\n`);

  let ok = 0, fail = 0, skip = 0;
  for (const { cal, apt } of targets) {
    const newNotes = String(apt.Notes || '').replace(BROKEN_PATTERN, CORRECT_PREFIX);
    if (newNotes === apt.Notes) { skip++; console.log(`  · skip ${apt.ExternalID}`); continue; }

    const mc = apt.ManualConfirmed === 1 ? '1' : '0';
    const fields = {
      calendarid: String(cal),
      start: fmtDt(apt.StartDateTime),
      end:   fmtDt(apt.EndDateTime),
      firstname: apt.FirstName || '',
      lastname:  apt.LastName  || '',
      email:     apt.Email     || '',
      phone:     apt.Phone     || '',
      street:    apt.Street    || '',
      zip:       apt.ZIP       || '',
      city:      apt.Town      || '',
      notes:     newNotes,
      sync:      '1',
      sendemail: '0',
      manualconfirmed: mc,
      appattrib: String(apt.appattrib ?? 0),
      canceldeadline: '1440'
    };
    for (let i = 1; i <= 17; i++) {
      const v = apt['Additional' + i];
      if (v != null && v !== '') fields['additional' + i] = String(v);
    }
    if (apt.Location) fields.location = apt.Location;

    if (DRY_RUN) {
      console.log(`  [dry] would patch ${apt.StartDateTime.slice(0, 16)}  ${(apt.FirstName || '').trim()} ${(apt.LastName || '').trim()}`);
      continue;
    }

    try {
      await etermin.updateAppointment(apt.ExternalID, fields);
      ok++;
      console.log(`  ✓ ${apt.StartDateTime.slice(0, 16)}  ${(apt.FirstName || '').trim()} ${(apt.LastName || '').trim()}`);
    } catch (err) {
      fail++;
      console.log(`  ✗ ${apt.ExternalID}: ${err.message.slice(0, 80)}`);
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} fail, ${skip} skipped`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
