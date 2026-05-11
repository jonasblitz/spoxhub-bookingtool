/**
 * Sync eTermin-Termine (mobile Kalender, letzte 12 Monate) → Airtable
 * (tbl3IDm2tNEUipn4B) mit einmaligem Geocoding pro Datensatz.
 *
 * Idempotent. Erneute Läufe geocoden nur die neuen/geänderten Adressen.
 *
 * Usage:
 *   node scripts/sync-etermin-locations.js
 *   node scripts/sync-etermin-locations.js --days=180   # nur letzte 6 Monate
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { syncFromEtermin } = require('../lib/locations');

const arg = (name, fallback) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!m) return fallback;
  const v = m.split('=')[1];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

(async () => {
  const days = arg('days', 365);
  console.log(`→ Sync mobile eTermin-Termine der letzten ${days} Tage…\n`);
  const stats = await syncFromEtermin({ days, log: msg => console.log(msg) });
  console.log(`\n────────────────────────────────────────────────`);
  console.log(`Termine geholt:        ${stats.fetched}`);
  console.log(`Gefiltert (skip):      ${stats.skipped}`);
  console.log(`Neu angelegt:          ${stats.created}`);
  console.log(`Aktualisiert:          ${stats.updated}`);
  console.log(`Aufgeräumt (delete):   ${stats.deleted}`);
  console.log(`Geocoded:              ${stats.geocoded}`);
  console.log(`Geocoding fehlgeschl.: ${stats.geocodeFailed}`);
  console.log(`────────────────────────────────────────────────`);
})().catch(err => { console.error('❌', err); process.exit(1); });
