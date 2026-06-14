const express = require('express');
const router = express.Router();
const { geocodeAddress, checkReachabilityFrom } = require('../lib/traveltime');
const { getActiveMobileCalendars } = require('../lib/calendars');
const config = require('../lib/config');

// Fallback wenn Airtable-Config nicht erreichbar — Live-Wert kommt aus Tabelle Konfiguration.
const TRAVEL_FEE_FALLBACK_EUR = 20;

router.post('/check', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Keine Adresse angegeben' });

  // Travel-Fee jetzt zentral aus Konfiguration (mit Fallback).
  const TRAVEL_FEE_EUR = await config.get('TravelFeeEUR', TRAVEL_FEE_FALLBACK_EUR);

  // Mock fallback if TravelTime keys missing (dev only)
  if (!process.env.TRAVELTIME_APP_ID || !process.env.TRAVELTIME_API_KEY) {
    console.warn('[geo] TravelTime not configured — mock response');
    const mobileCals = await getActiveMobileCalendars();
    return res.json({
      reachable: true,
      travelTimeMinutes: 12,
      travelFee: TRAVEL_FEE_EUR,
      calendarId: mobileCals[0]?.id || 211614,
      address
    });
  }

  // 1. Geocode address → lat/lng
  let coords;
  try {
    coords = await geocodeAddress(address);
  } catch (err) {
    console.error('[geo] geocode error:', err.message);
    return res.status(500).json({ error: 'Fehler bei der Adressprüfung. Bitte versuche es erneut.' });
  }
  if (!coords) {
    return res.json({ reachable: false, error: 'Adresse konnte nicht gefunden werden.' });
  }

  // 2. For each active mobile calendar, check reachability in parallel
  const mobileCals = await getActiveMobileCalendars();
  if (mobileCals.length === 0) {
    return res.json({
      reachable: false,
      error: 'Aktuell sind keine mobilen Termine verfügbar.',
      address: coords.label
    });
  }

  const checks = await Promise.all(mobileCals.map(async cal => {
    try {
      const r = await checkReachabilityFrom(coords.lat, coords.lng,
        { lat: cal.lat, lng: cal.lng }, cal.maxMin);
      console.log(`[geo] check ${cal.name} (limit=${cal.maxMin} min): reachable=${r.reachable}, travel=${r.travelTimeMinutes ?? '–'} min`);
      return { ...r, calendarId: cal.id, calendarName: cal.name, prio: cal.prio };
    } catch (err) {
      console.error(`[geo] reachability error for cal ${cal.id}:`, err.message);
      return null;
    }
  }));

  // 3. Pick the best eligible calendar: shortest travel time, tie-broken by priority
  const eligible = checks
    .filter(c => c && c.reachable)
    .sort((a, b) => (a.travelTimeMinutes - b.travelTimeMinutes) || (a.prio - b.prio));

  if (eligible.length === 0) {
    return res.json({
      reachable: false,
      error: 'Diese Adresse liegt leider außerhalb unseres Einsatzgebiets.',
      address: coords.label,
      coords
    });
  }

  const best = eligible[0];
  console.log(`[geo] picked calendar ${best.calendarName} (${best.calendarId}) — ${best.travelTimeMinutes} min`);

  res.json({
    reachable: true,
    travelTimeMinutes: best.travelTimeMinutes,
    travelFee: TRAVEL_FEE_EUR,
    calendarId: best.calendarId,
    calendarName: best.calendarName,
    address: coords.label,
    coords,
    // Optionally: full breakdown of all eligible calendars
    eligible: eligible.map(e => ({
      calendarId: e.calendarId, name: e.calendarName, travelTimeMinutes: e.travelTimeMinutes
    }))
  });
});

module.exports = router;
