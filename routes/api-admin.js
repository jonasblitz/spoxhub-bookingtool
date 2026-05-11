const express = require('express');
const router = express.Router();
const { loadCalendars, updateCalendarFields, invalidateCache } = require('../lib/calendars');
const { getIsochrone } = require('../lib/timemap');
const { listGeocoded, syncFromEtermin } = require('../lib/locations');

router.get('/calendars', async (req, res) => {
  try {
    invalidateCache();
    const cals = await loadCalendars();
    res.json({ calendars: cals });
  } catch (err) {
    console.error('[admin] calendars error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/calendars/:recordId', async (req, res) => {
  const { recordId } = req.params;
  const {
    startLat, startLng, maxMin, aktiv,
    arbeitszeitStart, arbeitszeitEnde,
    pausenLaenge, pausenFenstrStart, pausenFenstrEnde,
    samstagsAktiv, travelBufferMin
  } = req.body || {};
  const fields = {};
  if (startLat !== undefined && startLat !== null && !Number.isNaN(Number(startLat))) fields.StartLat = Number(startLat);
  if (startLng !== undefined && startLng !== null && !Number.isNaN(Number(startLng))) fields.StartLng = Number(startLng);
  if (maxMin   !== undefined && maxMin   !== null && !Number.isNaN(Number(maxMin)))   fields.MaxFahrzeitMin = Number(maxMin);
  if (aktiv    !== undefined) fields.Aktiv = !!aktiv;
  if (arbeitszeitStart !== undefined) fields.ArbeitszeitStart = String(arbeitszeitStart || '');
  if (arbeitszeitEnde  !== undefined) fields.ArbeitszeitEnde  = String(arbeitszeitEnde  || '');
  if (pausenLaenge !== undefined && pausenLaenge !== null && !Number.isNaN(Number(pausenLaenge))) fields.PausenLaenge = Number(pausenLaenge);
  if (pausenFenstrStart !== undefined) fields.PausenFenstrStart = String(pausenFenstrStart || '');
  if (pausenFenstrEnde  !== undefined) fields.PausenFenstrEnde  = String(pausenFenstrEnde  || '');
  if (samstagsAktiv !== undefined) fields.SamstagsAktiv = !!samstagsAktiv;
  if (travelBufferMin !== undefined && travelBufferMin !== null && !Number.isNaN(Number(travelBufferMin))) fields.TravelBufferMin = Number(travelBufferMin);
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'Keine Felder zum Update' });
  }
  try {
    const result = await updateCalendarFields(recordId, fields);
    res.json({ ok: true, record: result });
  } catch (err) {
    console.error('[admin] update error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/isochrone/:recordId', async (req, res) => {
  const { recordId } = req.params;
  try {
    const cals = await loadCalendars();
    const cal = cals.find(c => c.recordId === recordId);
    if (!cal) return res.status(404).json({ error: 'Kalender nicht gefunden' });
    if (!Number.isFinite(cal.lat) || !Number.isFinite(cal.lng) || !(cal.maxMin > 0)) {
      return res.status(400).json({ error: 'StartLat/StartLng/MaxFahrzeitMin fehlt' });
    }
    const shapes = await getIsochrone({
      lat: cal.lat, lng: cal.lng, maxMinutes: cal.maxMin
    });
    res.json({ shapes, calendar: cal });
  } catch (err) {
    console.error('[admin] isochrone error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/locations', async (req, res) => {
  try {
    const locations = await listGeocoded();
    res.json({ locations });
  } catch (err) {
    console.error('[admin] locations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/locations/sync', async (req, res) => {
  const days = Number(req.body?.days) || 365;
  try {
    const messages = [];
    const stats = await syncFromEtermin({ days, log: msg => messages.push(msg) });
    res.json({ ok: true, stats, log: messages });
  } catch (err) {
    console.error('[admin] locations sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
