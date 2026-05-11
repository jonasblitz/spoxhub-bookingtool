const crypto = require('crypto');

const ETERMIN_BASE = 'https://www.etermin.net/api';

/**
 * Generate eTermin auth headers (publickey, salt, signature)
 */
function getAuthHeaders() {
  const publicKey = process.env.ETERMIN_PUBLIC_KEY;
  const privateKey = process.env.ETERMIN_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    throw new Error('eTermin API keys not configured');
  }

  const salt = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', privateKey)
    .update(salt)
    .digest('base64');

  return {
    'publickey': publicKey,
    'salt': salt,
    'signature': signature,
    'Content-Type': 'application/json'
  };
}

/**
 * Make authenticated request to eTermin API
 */
async function eterminFetch(path, options = {}) {
  const url = `${ETERMIN_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eTermin API error (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type');
  if (contentType?.includes('application/json') || contentType?.includes('text/json')) {
    return res.json();
  }
  return res.text();
}

/**
 * List all calendars
 */
async function listCalendars() {
  const data = await eterminFetch('/calendar');
  if (!Array.isArray(data)) return [data].filter(Boolean);
  return data;
}

/**
 * Get working times for a calendar
 */
async function getWorkingTimes(calendarId) {
  return eterminFetch(`/workingtimes?calendarid=${calendarId}`);
}

/**
 * Get non-working times (absences) for a calendar
 */
async function getNonWorkingTimes(calendarId) {
  return eterminFetch(`/calendarsnonworkingtimes?calendarid=${calendarId}`);
}

/**
 * Get existing appointments for a calendar on a date range
 */
async function getAppointments(calendarId, startDate, endDate) {
  // eTermin end date is exclusive — add one day to include appointments on endDate
  const [y, m, d] = endDate.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const endStr = end.toISOString().substring(0, 10);
  return eterminFetch(`/appointment?calendarid=${calendarId}&start=${startDate}&end=${endStr}`);
}

/**
 * Get available time slots for a specific date
 * Algorithm: working times - non-working times - booked appointments = available slots
 */
// Travel buffer in minutes between mobile appointments (driving time) — fallback only
const TRAVEL_BUFFER_MINUTES = 25;

const calendars = require('./calendars');
const { generateSlots: generateSlotsLocal } = require('./slots');

/**
 * Look up our local Kalender entry for a given eTermin calendar ID.
 */
async function getLocalCalendar(calendarId) {
  const all = await calendars.loadCalendars();
  return all.find(c => c.id === Number(calendarId));
}

async function getAvailableSlots(calendarId, date, durationMinutes = 60, serviceIds = []) {
  const dayOfWeek = new Date(date + 'T00:00:00').getDay(); // 0=Sun, 1=Mon...
  const isMobile = await calendars.isMobileCalendarId(calendarId);

  // ─── Path A: Local slot engine (cluster-greedy) ──────────────────────────
  // Active when our Kalender table has working hours configured.
  const local = await getLocalCalendar(calendarId);
  if (local && local.arbeitszeitStart && local.arbeitszeitEnde) {
    try {
      const apts = await getAppointments(calendarId, date, date).catch(() => []);
      return generateSlotsLocal(date, local, durationMinutes, apts);
    } catch (err) {
      console.warn(`[slots] local engine failed for cal ${calendarId}, falling back:`, err.message);
    }
  }

  // ─── Path B: legacy — eTermin native /timeslots ─────────────────────────
  if (serviceIds.length > 0) {
    try {
      let nativeSlots = await getTimeslotsFromEtermin(calendarId, date, serviceIds, durationMinutes);
      if (nativeSlots !== null) {
        if (isMobile && nativeSlots.length > 0) {
          nativeSlots = await applyTravelBuffer(calendarId, date, nativeSlots, durationMinutes);
        }
        return nativeSlots;
      }
    } catch (err) {
      console.warn('eTermin native timeslots failed, falling back to manual calculation:', err.message);
    }
  }

  // Fetch data in parallel
  const [workingTimes, nonWorkingTimes, appointments] = await Promise.all([
    getWorkingTimes(calendarId),
    getNonWorkingTimes(calendarId).catch(() => []),
    getAppointments(calendarId, date, date).catch(() => [])
  ]);

  // Parse working times for this weekday
  // eTermin weekday index: 0=Monday, 1=Tuesday... 6=Sunday
  const eterminDayIdx = dayOfWeek + 1; // eTermin: 1=Sun, 2=Mon, 3=Tue... 7=Sat

  const todayWorkingSlots = [];
  if (Array.isArray(workingTimes)) {
    for (const wt of workingTimes) {
      if (wt.WeekDayIdx === eterminDayIdx || wt.Weekdayidx === eterminDayIdx) {
        todayWorkingSlots.push({
          start: parseTime(wt.StartTime || wt.Starttime),
          end: parseTime(wt.EndTime || wt.Endtime)
        });
      }
    }
  }

  if (todayWorkingSlots.length === 0) return [];

  // Parse non-working times that overlap with our date
  const blockedSlots = [];
  if (Array.isArray(nonWorkingTimes)) {
    for (const nwt of nonWorkingTimes) {
      const nwtStart = nwt.StartDate || nwt.Startdate;
      const nwtEnd = nwt.EndDate || nwt.Enddate;
      if (nwtStart && nwtEnd) {
        const startD = nwtStart.substring(0, 10);
        const endD = nwtEnd.substring(0, 10);
        if (date >= startD && date <= endD) {
          blockedSlots.push({
            start: parseTime(nwtStart.substring(11, 16) || '00:00'),
            end: parseTime(nwtEnd.substring(11, 16) || '23:59')
          });
        }
      }
    }
  }

  // Parse existing appointments
  const bookedSlots = [];
  if (Array.isArray(appointments)) {
    for (const app of appointments) {
      const appStart = app.StartDateTime || app.Startdatetime || app.Start;
      const appEnd = app.EndDateTime || app.Enddatetime || app.End;
      if (appStart && appEnd) {
        bookedSlots.push({
          start: parseTime(appStart.substring(11, 16)),
          end: parseTime(appEnd.substring(11, 16))
        });
      }
    }
  }

  // Generate available slots
  const available = [];
  for (const wt of todayWorkingSlots) {
    let slotStart = wt.start;
    while (slotStart + durationMinutes <= wt.end) {
      const slotEnd = slotStart + durationMinutes;

      // Check if slot overlaps with any blocked or booked time
      const isBlocked = blockedSlots.some(b => slotStart < b.end && slotEnd > b.start);
      const isBooked = bookedSlots.some(b => slotStart < b.end && slotEnd > b.start);

      if (!isBlocked && !isBooked) {
        available.push({
          start: formatTime(slotStart),
          end: formatTime(slotEnd),
          label: `${formatTime(slotStart)} Uhr`
        });
      }

      // Advance by 30-minute intervals
      slotStart += 30;
    }
  }

  return available;
}

/**
 * Get availability for an entire month
 * Returns array of { date, available: bool, slotCount: number }
 */
async function getMonthAvailability(calendarId, year, month, durationMinutes = 60, serviceIds = []) {
  const lastDay = new Date(year, month, 0);
  const totalDays = lastDay.getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isMobile = await calendars.isMobileCalendarId(calendarId);

  const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
  const endDate = `${year}-${month.toString().padStart(2, '0')}-${totalDays.toString().padStart(2, '0')}`;

  // ─── Path A: Local slot engine (cluster-greedy) ──────────────────────────
  const local = await getLocalCalendar(calendarId);
  if (local && local.arbeitszeitStart && local.arbeitszeitEnde) {
    try {
      const allApts = await getAppointments(calendarId, startDate, endDate).catch(() => []);

      const result = [];
      for (let d = 1; d <= totalDays; d++) {
        const date = new Date(year, month - 1, d);
        const dateStr = `${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;

        if (date < today) {
          result.push({ date: dateStr, available: false, slotCount: 0 });
          continue;
        }

        // Filter appointments for this specific day
        const dayApts = allApts.filter(a => {
          const s = a.StartDateTime || a.Startdatetime || a.Start || a.start || '';
          return s.substring(0, 10) === dateStr;
        });

        const slots = generateSlotsLocal(dateStr, local, durationMinutes, dayApts);
        result.push({ date: dateStr, available: slots.length > 0, slotCount: slots.length });
      }
      return result;
    } catch (err) {
      console.warn(`[slots] local month engine failed for cal ${calendarId}, falling back:`, err.message);
    }
  }

  // ─── Path B: legacy — eTermin native /timeslots ─────────────────────────
  if (serviceIds.length > 0) {
    try {
      const result = [];
      // Collect future dates to query
      const futureDates = [];
      for (let d = 1; d <= totalDays; d++) {
        const date = new Date(year, month - 1, d);
        const dateStr = `${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
        if (date < today) {
          result.push({ date: dateStr, available: false, slotCount: 0 });
        } else {
          futureDates.push({ d, dateStr });
        }
      }

      // Query in parallel (batch of 5 to avoid rate limits)
      const batchSize = 5;
      for (let i = 0; i < futureDates.length; i += batchSize) {
        const batch = futureDates.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async ({ dateStr }) => {
            try {
              let slots = await getTimeslotsFromEtermin(calendarId, dateStr, serviceIds, durationMinutes);
              // Apply travel buffer for mobile calendars
              if (isMobile && slots.length > 0) {
                slots = await applyTravelBuffer(calendarId, dateStr, slots, durationMinutes);
              }
              return { dateStr, slotCount: slots.length };
            } catch {
              return { dateStr, slotCount: 0 };
            }
          })
        );
        batchResults.forEach(({ dateStr, slotCount }) => {
          result.push({ date: dateStr, available: slotCount > 0, slotCount });
        });
      }

      // Sort by date
      result.sort((a, b) => a.date.localeCompare(b.date));
      return result;
    } catch (err) {
      console.warn('eTermin native month timeslots failed, falling back:', err.message);
    }
  }

  // Fallback: manual calculation
  const [workingTimes, nonWorkingTimes, appointments] = await Promise.all([
    getWorkingTimes(calendarId),
    getNonWorkingTimes(calendarId).catch(() => []),
    getAppointments(calendarId, startDate, endDate).catch(() => [])
  ]);

  const result = [];

  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(year, month - 1, d);
    const dateStr = `${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;

    // Past dates are unavailable
    if (date < today) {
      result.push({ date: dateStr, available: false, slotCount: 0 });
      continue;
    }

    // Check working times for this weekday
    const dayOfWeek = date.getDay();
    const eterminDayIdx = dayOfWeek + 1; // eTermin: 1=Sun, 2=Mon, 3=Tue... 7=Sat

    const todayWorkingSlots = [];
    if (Array.isArray(workingTimes)) {
      for (const wt of workingTimes) {
        if (wt.WeekDayIdx === eterminDayIdx || wt.Weekdayidx === eterminDayIdx) {
          todayWorkingSlots.push({
            start: parseTime(wt.StartTime || wt.Starttime),
            end: parseTime(wt.EndTime || wt.Endtime)
          });
        }
      }
    }

    if (todayWorkingSlots.length === 0) {
      result.push({ date: dateStr, available: false, slotCount: 0 });
      continue;
    }

    // Check non-working times for this date
    const blockedSlots = [];
    if (Array.isArray(nonWorkingTimes)) {
      for (const nwt of nonWorkingTimes) {
        const nwtStart = nwt.StartDate || nwt.Startdate;
        const nwtEnd = nwt.EndDate || nwt.Enddate;
        if (nwtStart && nwtEnd) {
          const startD = nwtStart.substring(0, 10);
          const endD = nwtEnd.substring(0, 10);
          if (dateStr >= startD && dateStr <= endD) {
            blockedSlots.push({
              start: parseTime(nwtStart.substring(11, 16) || '00:00'),
              end: parseTime(nwtEnd.substring(11, 16) || '23:59')
            });
          }
        }
      }
    }

    // Check booked appointments for this date
    const bookedSlots = [];
    if (Array.isArray(appointments)) {
      for (const app of appointments) {
        const appStart = app.StartDateTime || app.Startdatetime || app.Start;
        if (appStart && appStart.substring(0, 10) === dateStr) {
          const appEnd = app.EndDateTime || app.Enddatetime || app.End;
          bookedSlots.push({
            start: parseTime(appStart.substring(11, 16)),
            end: parseTime(appEnd.substring(11, 16))
          });
        }
      }
    }

    // Count available slots
    let slotCount = 0;
    for (const wt of todayWorkingSlots) {
      let slotStart = wt.start;
      while (slotStart + durationMinutes <= wt.end) {
        const slotEnd = slotStart + durationMinutes;
        const isBlocked = blockedSlots.some(b => slotStart < b.end && slotEnd > b.start);
        const isBooked = bookedSlots.some(b => slotStart < b.end && slotEnd > b.start);
        if (!isBlocked && !isBooked) slotCount++;
        slotStart += 30;
      }
    }

    result.push({ date: dateStr, available: slotCount > 0, slotCount });
  }

  return result;
}

/**
 * Create an appointment
 */
async function createAppointment({
  calendarId,
  start,
  end,
  customer,
  services,
  notes,
  agbAccepted,
  privacyAccepted,
  newsletter,
  feedbackPermission,
  bike,
  payment,
  location
}) {
  const params = new URLSearchParams({
    calendarid: calendarId,
    start: start, // format: yyyy-mm-dd HH:MM
    end: end,
    firstname: customer.vorname || '',
    lastname: customer.name || '',
    email: customer.email || '',
    phone: customer.mobil || '',
    street: customer.strasse || '',
    zip: customer.plz || '',
    city: customer.ort || '',
    notes: notes || '',
    sendemail: '1',
    manualconfirmed: '1',
    sync: '1',
    canceldeadline: '1440'
  });

  // Location = where the service actually happens (customer address for mobile, workshop for werkstatt)
  if (location) params.set('location', location);

  // Services (comma-separated eTermin IDs)
  if (services) {
    const serviceStr = Array.isArray(services) ? services.join(',') : services;
    if (serviceStr) params.set('services', serviceStr);
  }

  // Consent flags
  if (agbAccepted)        params.set('agbaccepted', '1');
  if (privacyAccepted)    params.set('dataprivacyaccepted', '1');
  if (newsletter)         params.set('newsletter', '1');
  if (feedbackPermission) params.set('feedbackpermissionaccepted', '1');

  // Additional custom fields — labels in the eTermin dashboard:
  //   additional1  = Hersteller
  //   additional2  = Modell
  //   additional3  = Rahmennummer
  //   additional4  = Leasinggeber
  //   additional5  = Leasing-Vertragsnummer
  //   additional8  = Rechnungsadresse
  //   additional9  = PayPal-Order-ID
  //   additional16 = Versicherung
  //   additional17 = Versicherungs-Vertragsnummer
  if (bike?.marke)        params.set('additional1', bike.marke);
  if (bike?.modell)       params.set('additional2', bike.modell);
  if (bike?.rahmennummer) params.set('additional3', bike.rahmennummer);
  if (bike?.leasing)      params.set('additional4', bike.leasing);
  if (bike?.leasingNr)    params.set('additional5', bike.leasingNr);

  // Billing address — prefer abweichende Rechnungsadresse, fallback to main address
  const hasAltBilling = !!(customer.rechnungStrasse || customer.rechnungFirma);
  const billing = hasAltBilling
    ? [
        customer.rechnungFirma,
        customer.rechnungStrasse,
        `${customer.rechnungPlz || ''} ${customer.rechnungOrt || ''}`.trim()
      ].filter(Boolean).join(', ')
    : [
        customer.strasse,
        `${customer.plz || ''} ${customer.ort || ''}`.trim()
      ].filter(Boolean).join(', ');
  if (billing) params.set('additional8', billing);

  if (payment?.orderId)     params.set('additional9',  payment.orderId);
  if (bike?.versicherung)   params.set('additional16', bike.versicherung);
  if (bike?.versicherungNr) params.set('additional17', bike.versicherungNr);

  // appattrib = bitmask of eTermin appointment attributes.
  //   ETERMIN_PAID_APPATTRIB env (e.g. "1") → set when deposit was captured.
  //   Multiple attributes can be combined by adding values (1 + 4 = 5).
  const paidAttrib = process.env.ETERMIN_PAID_APPATTRIB;
  const isPaid = !!(payment && (payment.captureId || payment.status === 'completed' || payment.amount));
  if (paidAttrib && isPaid) {
    params.set('appattrib', String(paidAttrib));
  }

  const url = `/appointment?${params.toString()}`;
  console.log('[etermin] createAppointment →', url);
  const result = await eterminFetch(url, { method: 'POST' });

  // If POST didn't accept appattrib (older eTermin behaviour), fall back to a
  // follow-up PUT once we know the new appointment ID. This is best-effort —
  // we don't fail the booking if the marker can't be set.
  if (paidAttrib && isPaid) {
    const apptId = result?.ID || result?.IID || result?.AppointmentID;
    const wasSet = result && (
      String(result.AppAttrib ?? result.appattrib ?? '') === String(paidAttrib)
    );
    if (apptId && !wasSet) {
      try {
        const putParams = new URLSearchParams({
          id: String(apptId),
          appattrib: String(paidAttrib)
        });
        await eterminFetch(`/appointment?${putParams.toString()}`, { method: 'PUT' });
        console.log(`[etermin] appattrib=${paidAttrib} set via PUT for appt ${apptId}`);
      } catch (err) {
        console.warn(`[etermin] could not set appattrib via PUT (${err.message}) — booking still confirmed`);
      }
    }
  }

  return result;
}

/**
 * Get timeslots from eTermin's native endpoint with service filtering.
 * Uses `date=` (not startdate/enddate) and passes duration for accurate results.
 * Returns array of { start, end, label } or null if endpoint fails.
 */
async function getTimeslotsFromEtermin(calendarId, date, serviceIds, durationMinutes) {
  const serviceParam = serviceIds.join(',');
  let url = `/timeslots?calendarid=${calendarId}&date=${date}&serviceid=${serviceParam}`;
  if (durationMinutes) url += `&duration=${durationMinutes}`;
  const data = await eterminFetch(url);

  if (!data || !Array.isArray(data) || data.length === 0) return [];

  const slots = [];
  for (const slot of data) {
    const start = slot.start || slot.Start || slot.StartTime || slot.Starttime;
    const end = slot.end || slot.End || slot.EndTime || slot.Endtime;
    if (start && end) {
      const startTime = start.includes('T') ? start.substring(11, 16) : start.substring(0, 5);
      const endTime = end.includes('T') ? end.substring(11, 16) : end.substring(0, 5);
      slots.push({
        start: startTime,
        end: endTime,
        label: `${startTime} Uhr`
      });
    }
  }

  return slots;
}

/**
 * Filter out slots that conflict with existing appointments + travel buffer.
 * For mobile service, the technician needs TRAVEL_BUFFER_MINUTES between appointments.
 */
async function applyTravelBuffer(calendarId, date, slots, durationMinutes) {
  const appointments = await getAppointments(calendarId, date, date).catch(() => []);
  if (!Array.isArray(appointments) || appointments.length === 0) return slots;

  // Parse existing appointment times
  const booked = [];
  for (const app of appointments) {
    const appStart = app.StartDateTime || app.Startdatetime || app.Start;
    const appEnd = app.EndDateTime || app.Enddatetime || app.End;
    if (appStart && appEnd) {
      booked.push({
        start: parseTime(appStart.substring(11, 16)),
        end: parseTime(appEnd.substring(11, 16))
      });
    }
  }

  if (booked.length === 0) return slots;

  return slots.filter(slot => {
    const slotStart = parseTime(slot.start);
    const slotEnd = parseTime(slot.end);

    for (const app of booked) {
      // Slot must not start before existing appointment ends + travel buffer
      // Slot must not end after existing appointment starts - travel buffer
      if (slotStart < app.end + TRAVEL_BUFFER_MINUTES && slotEnd > app.start - TRAVEL_BUFFER_MINUTES) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Parse time string "HH:MM" to minutes since midnight
 */
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/**
 * Format minutes since midnight to "HH:MM"
 */
function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Delete an existing eTermin appointment by ID.
 */
async function deleteAppointment(appointmentId) {
  const result = await eterminFetch(`/appointment?id=${appointmentId}`, { method: 'DELETE' });
  return result;
}

module.exports = {
  deleteAppointment,
  listCalendars,
  getAvailableSlots,
  getMonthAvailability,
  createAppointment,
  getWorkingTimes,
  getNonWorkingTimes,
  getAppointments
};
