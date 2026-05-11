const express = require('express');
const router = express.Router();
const etermin = require('../lib/etermin');
const { getActiveWorkshopCalendars } = require('../lib/calendars');

/**
 * Resolve a calendar ID for a query.
 *   - If frontend explicitly passed calendarId → use it (mobile case).
 *   - Otherwise pick the highest-priority active workshop calendar (werkstatt case).
 *     For slot display, both workshops have identical hours, so picking one is representative.
 */
async function resolveCalendarId(rawCalendarId) {
  if (rawCalendarId) return Number(rawCalendarId);
  const workshops = await getActiveWorkshopCalendars();
  if (workshops.length === 0) return null;
  workshops.sort((a, b) => (a.prio || 99) - (b.prio || 99));
  return workshops[0].id;
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
  const { year, month, duration, calendarId } = req.query;

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
    const calId = await resolveCalendarId(calendarId);
    if (!calId) return res.json([]);

    const serviceIdList = req.query.serviceIds ? req.query.serviceIds.split(',').map(Number).filter(Boolean) : [];
    const availability = await etermin.getMonthAvailability(calId, parseInt(year), parseInt(month), parseInt(duration) || 60, serviceIdList);
    res.json(availability);
  } catch (err) {
    console.error('eTermin availability error:', err.message);
    res.status(500).json({ error: 'Verfügbarkeit konnte nicht geladen werden.' });
  }
});

router.get('/slots', async (req, res) => {
  const { date, duration, calendarId } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Kein Datum angegeben' });
  }

  if (!process.env.ETERMIN_PUBLIC_KEY || !process.env.ETERMIN_PRIVATE_KEY) {
    console.warn('eTermin API keys not configured — using mock slots');
    return res.json(generateMockSlots(date, parseInt(duration) || 60));
  }

  try {
    const calId = await resolveCalendarId(calendarId);
    if (!calId) return res.json([]);

    const serviceIdList = req.query.serviceIds ? req.query.serviceIds.split(',').map(Number).filter(Boolean) : [];
    const slots = await etermin.getAvailableSlots(calId, date, parseInt(duration) || 60, serviceIdList);
    res.json(slots);
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
