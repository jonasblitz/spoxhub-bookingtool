/**
 * Cleanup-Cron: deletes stale eTermin reservations.
 *
 * A "reservation" is an appointment created via etermin.reserveSlot() with
 * the magic marker "[hold-v1]" in its notes. The notes also carry
 * `expires=<ISO>`. If that timestamp is in the past, the slot is no longer
 * considered held — we delete it so it becomes bookable again.
 *
 * Run via crontab every 10 minutes:
 *   ASTERISK/10 * * * * cd /opt/spoxhub/bookingTool && node scripts/cleanup-stale-reservations.js
 *   (replace "ASTERISK" with a real asterisk character)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const etermin = require('../lib/etermin');
const calendars = require('../lib/calendars');

(async () => {
  try {
    // ALL active calendars (mobile + workshop) — Tool-Reservierungen können
    // auf jedem Kalender liegen, je nachdem was der Kunde gewählt hat.
    const all = await calendars.loadCalendars();
    const calendarIds = (all || []).filter(c => c.aktiv).map(c => c.id).filter(Boolean);
    if (calendarIds.length === 0) {
      console.log('[cleanup] no active calendars — nothing to scan');
      return;
    }

    const stale = await etermin.findStaleReservations({ calendars: calendarIds, days: 90 });
    if (stale.length === 0) {
      console.log('[cleanup] no stale reservations');
      return;
    }

    console.log(`[cleanup] deleting ${stale.length} stale reservation(s)…`);
    let ok = 0, fail = 0;
    for (const r of stale) {
      try {
        await etermin.deleteAppointment(r.id);
        ok++;
        console.log(`  ✓ deleted ${r.id} (cal ${r.calendarId}, expired ${r.expiresAt})`);
      } catch (err) {
        fail++;
        console.error(`  ✗ ${r.id}: ${err.message}`);
      }
    }
    console.log(`[cleanup] done: ${ok} ok, ${fail} failed`);
  } catch (err) {
    console.error('[cleanup] FATAL:', err.message);
    process.exit(1);
  }
})();
