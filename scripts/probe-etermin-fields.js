/**
 * Schnell-Probe: zeigt die echten Feldnamen aus einer eTermin /appointment Antwort.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const calendars = require('../lib/calendars');
const etermin = require('../lib/etermin');

(async () => {
  const cals = await calendars.getActiveMobileCalendars();
  if (!cals.length) { console.log('Keine mobilen Kalender.'); return; }
  const cal = cals[0];
  const today = new Date();
  const start = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().substring(0, 10);
  const apts = await etermin.getAppointments(cal.id, fmt(start), fmt(today));
  if (!Array.isArray(apts) || !apts.length) { console.log('Keine Termine.'); return; }
  console.log(`Kalender: ${cal.name} (#${cal.id})`);
  console.log(`Anzahl: ${apts.length}`);
  console.log(`\nKeys eines Beispieltermins:`);
  console.log(Object.keys(apts[0]).sort().join('\n'));
  console.log(`\nLocation/Street/ZIP/Town von 8 Beispielen:`);
  for (const a of apts.slice(0, 8)) {
    console.log({
      ID: a.ID,
      FirstName: a.FirstName,
      LastName: a.LastName,
      Street: a.Street,
      ZIP: a.ZIP,
      Town: a.Town,
      Location: a.Location
    });
  }
})().catch(e => { console.error('❌', e); process.exit(1); });
