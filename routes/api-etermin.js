const express = require('express');
const router = express.Router();
const etermin = require('../lib/etermin');
const { getActiveWorkshopCalendars, loadCalendars } = require('../lib/calendars');

/**
 * Resolve the SET of calendar IDs to query.
 *
 *   1. Frontend explicitly passes `eligibleCalendarIds` (kommagetrennt) →
 *      werden 1:1 genutzt (Mobil-Fall: alle erreichbaren Kalender).
 *   2. Frontend passes single `calendarId` → nur dieser eine (Legacy /
 *      Single-Cal Use Cases).
 *   3. Nothing passed → alle aktiven Werkstatt-Kalender (Werkstatt-Fall).
 *
 * Liefert ein Array von Number-IDs, sortiert nach `prio` aufsteigend.
 */
async function resolveCalendarIds(rawCalendarId, eligibleCsv) {
  const all = await loadCalendars();
  const activeById = new Map(all.filter(c => c.aktiv).map(c => [c.id, c]));

  // Helper: sortiere nach prio asc, fallback id
  const sortByPrio = ids => ids
    .map(id => activeById.get(Number(id)))
    .filter(Boolean)
    .sort((a, b) => (a.prio || 99) - (b.prio || 99))
    .map(c => c.id);

  if (eligibleCsv) {
    const ids = String(eligibleCsv).split(',').map(s => Number(s.trim())).filter(Boolean);
    return sortByPrio(ids);
  }
  if (rawCalendarId) {
    const id = Number(rawCalendarId);
    return activeById.has(id) ? [id] : [];
  }
  const workshops = await getActiveWorkshopCalendars();
  return workshops
    .sort((a, b) => (a.prio || 99) - (b.prio || 99))
    .map(w => w.id);
}

router.get('/calendars', async (req, res) => {
  try {
    const calendars = await etermin.listCalendars();
    res.json(calendars.map(c => ({
      id: c.CalendarID,
      name: c.CalendarName,
      slotMinutes: c.TimeSlotMinutes,
      enabled: c.Enabled
    })));
  } catch (err) {
    console.error('eTermin calendars error:', err.message);
    res.status(500).json({ error: 'Kalender konnten nicht geladen werden.' });
  }
});

router.get('/availability', async (req, res) => {
  const { year, month, duration, calendarId, eligibleCalendarIds } = req.query;

  if (!year || !month) {
    return res.status(400).json({ error: 'Jahr und Monat erforderlich' });
  }

  if (!process.env.ETERMIN_PUBLIC_KEY || !process.env.ETERMIN_PRIVATE_KEY) {
    // Mock: weekdays available, weekends not
    const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const result = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(parseInt(year), parseInt(month) - 1, d);
      const dateStr = `${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
      const dow = date.getDay();
      const isPast = date < today;
      const isWeekend = dow === 0;
      result.push({ date: dateStr, available: !isPast && !isWeekend, slotCount: isPast || isWeekend ? 0 : 8 });
    }
    return res.json(result);
  }

  try {
    const calIds = await resolveCalendarIds(calendarId, eligibleCalendarIds);
    if (calIds.length === 0) return res.json([]);

    const serviceIdList = req.query.serviceIds ? req.query.serviceIds.split(',').map(Number).filter(Boolean) : [];
    const dur = parseInt(duration) || 60;

    // Pro Kalender getMonthAvailability holen, dann pro Datum mergen:
    //   available = OR über alle Kalender
    //   slotCount = MAX über alle Kalender
    const perCal = await Promise.all(calIds.map(id =>
      etermin.getMonthAvailability(id, parseInt(year), parseInt(month), dur, serviceIdList).catch(() => [])
    ));

    const byDate = new Map();
    for (const arr of perCal) {
      for (const d of (arr || [])) {
        const prev = byDate.get(d.date);
        if (!prev) {
          byDate.set(d.date, { date: d.date, available: !!d.available, slotCount: d.slotCount || 0 });
        } else {
          prev.available = prev.available || !!d.available;
          prev.slotCount = Math.max(prev.slotCount, d.slotCount || 0);
        }
      }
    }
    const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    res.json(merged);
  } catch (err) {
    console.error('eTermin availability error:', err.message);
    res.status(500).json({ error: 'Verfügbarkeit konnte nicht geladen werden.' });
  }
});

router.get('/slots', async (req, res) => {
  const { date, duration, calendarId, eligibleCalendarIds } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Kein Datum angegeben' });
  }

  if (!process.env.ETERMIN_PUBLIC_KEY || !process.env.ETERMIN_PRIVATE_KEY) {
    console.warn('eTermin API keys not configured — using mock slots');
    return res.json(generateMockSlots(date, parseInt(duration) || 60));
  }

  try {
    const calIds = await resolveCalendarIds(calendarId, eligibleCalendarIds);
    if (calIds.length === 0) return res.json([]);

    const serviceIdList = req.query.serviceIds ? req.query.serviceIds.split(',').map(Number).filter(Boolean) : [];
    const dur = parseInt(duration) || 60;

    // Pro Kalender getAvailableSlots holen, dann pro {start-end} mergen.
    // Slots, die in mehreren Kalendern frei sind, sammeln alle eligiblen IDs.
    const perCal = await Promise.all(calIds.map(id =>
      etermin.getAvailableSlots(id, date, dur, serviceIdList)
        .then(slots => ({ id, slots: slots || [] }))
        .catch(err => {
          console.warn(`[slots] cal ${id} failed: ${err.message}`);
          return { id, slots: [] };
        })
    ));

    const slotMap = new Map(); // key: `${start}-${end}` → { start, end, label, eligibleCalendarIds: [] }
    for (const { id, slots } of perCal) {
      for (const s of slots) {
        const key = `${s.start}-${s.end}`;
        if (!slotMap.has(key)) {
          slotMap.set(key, { ...s, eligibleCalendarIds: [] });
        }
        slotMap.get(key).eligibleCalendarIds.push(id);
      }
    }

    const merged = [...slotMap.values()].sort((a, b) => a.start.localeCompare(b.start));
    res.json(merged);
  } catch (err) {
    console.error('eTermin slots error:', err.message);
    res.json(generateMockSlots(date, parseInt(duration) || 60));
  }
});

function generateMockSlots(date, duration) {
  const dayOfWeek = new Date(date + 'T00:00:00').getDay();
  if (dayOfWeek === 0) return [];

  const startHour = 9;
  const endHour = dayOfWeek === 6 ? 14 : 18;
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (const m of [0, 30]) {
      if (h === endHour - 1 && m === 30) continue;
      const start = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      const endMin = m + duration;
      const endH = h + Math.floor(endMin / 60);
      const endM = endMin % 60;
      const end = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
      if (Math.random() > 0.6) slots.push({ start, end, label: `${start} Uhr` });
    }
  }
  return slots;
}

// Debug endpoints (temporary)
router.get('/debug/workingtimes', async (req, res) => {
  try { res.json(await etermin.getWorkingTimes(req.query.calendarId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/debug/nonworking', async (req, res) => {
  try { res.json(await etermin.getNonWorkingTimes(req.query.calendarId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/debug/appointments', async (req, res) => {
  try { res.json(await etermin.getAppointments(req.query.calendarId, req.query.date, req.query.date)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
