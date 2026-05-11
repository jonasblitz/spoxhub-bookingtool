/**
 * Daily Auto-Pause Sync
 *
 * Iterates over all active calendars and the next N days, ensuring exactly
 * one auto-pause appointment exists per (calendar, day) at the optimal time.
 *
 * Suggested cron (auf dem Server):
 *   0 4 * * * cd /opt/spoxhub/bookingTool && /usr/bin/node scripts/sync-auto-pauses.js >> /var/log/spoxhub-pauses.log 2>&1
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { syncAllForNextDays } = require('../lib/auto-pause');

const DAYS_AHEAD = parseInt(process.env.AUTO_PAUSE_DAYS_AHEAD || '30', 10);

(async () => {
  console.log(`\n🌗 Auto-pause sync — next ${DAYS_AHEAD} days — ${new Date().toISOString()}\n`);
  const results = await syncAllForNextDays(DAYS_AHEAD);

  const counts = { noop: 0, skip: 0, created: 0, replaced: 0, deleted: 0, error: 0 };
  for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;

  console.log(`Processed ${results.length} (calendar, date) pairs.`);
  console.log(`  noop:     ${counts.noop}`);
  console.log(`  skip:     ${counts.skip}`);
  console.log(`  created:  ${counts.created}`);
  console.log(`  replaced: ${counts.replaced}`);
  console.log(`  deleted:  ${counts.deleted}`);
  console.log(`  error:    ${counts.error}`);

  // Show non-noop entries for visibility
  const interesting = results.filter(r => !['noop', 'skip'].includes(r.action));
  if (interesting.length > 0) {
    console.log('\nChanges:');
    interesting.forEach(r => {
      console.log(`  ${r.calendar} ${r.date} — ${r.action}${r.at ? ' @ ' + r.at : ''}${r.error ? ' (' + r.error + ')' : ''}`);
    });
  }
  console.log('\nDone. ✅\n');
})().catch(err => {
  console.error('\n❌ sync failed:', err.message, '\n');
  process.exit(1);
});
