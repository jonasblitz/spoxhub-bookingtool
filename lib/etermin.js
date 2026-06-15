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
// Travel buffer in minutes between mobile appointments (driving time) — Fallback
// wenn weder pro Kalender noch in Tabelle Konfiguration gesetzt.
const TRAVEL_BUFFER_FALLBACK_MINUTES = 25;

const calendars = require('./calendars');
const { generateSlots: generateSlotsLocal } = require('./slots');
const config = require('./config');
const reservations = require('./reservations');

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
      const defaultTravelBuffer = await config.get('TravelBufferMinutesDefault', TRAVEL_BUFFER_FALLBACK_MINUTES);
      // Memory-Reservierungen für diesen Tag mit einrechnen — blockieren genauso wie echte Termine.
      const extraBlockedRanges = reservations.activeRangesForDay(calendarId, date);
      return generateSlotsLocal(date, local, durationMinutes, apts, { defaultTravelBuffer, extraBlockedRanges });
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
      const defaultTravelBuffer = await config.get('TravelBufferMinutesDefault', TRAVEL_BUFFER_FALLBACK_MINUTES);

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
        const extraBlockedRanges = reservations.activeRangesForDay(calendarId, dateStr);

        const slots = generateSlotsLocal(dateStr, local, durationMinutes, dayApts, { defaultTravelBuffer, extraBlockedRanges });
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
        // eTermin PUT requires the data in the body and re-sends of start/end/calendarid.
        await updateAppointment(apptId, {
          calendarid: calendarId,
          start, end,
          appattrib: paidAttrib
        });
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

  // Buffer-Auflösung: pro Kalender > Tabelle Konfiguration > Code-Fallback.
  const cal = await getLocalCalendar(calendarId);
  const perCalendar = Number(cal?.travelBufferMin);
  const TRAVEL_BUFFER_MINUTES = Number.isFinite(perCalendar) && perCalendar > 0
    ? perCalendar
    : await config.get('TravelBufferMinutesDefault', TRAVEL_BUFFER_FALLBACK_MINUTES);

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
  // WICHTIG: bei DELETE muss `externalid=<UUID>` statt `id=...` verwendet
  // werden — nur dann greift das `sync=1`-Flag und der Delete wird in den
  // verbundenen externen Kalender (CalDav) propagiert. Mit `id=` bleiben
  // gelöschte Termine als Karteileichen im iCal stehen.
  // Quelle: eTermin-Support, 2026-05-21.
  const result = await eterminFetch(`/appointment?externalid=${appointmentId}&sync=1`, { method: 'DELETE' });
  return result;
}

// ─── Hold / Reservierungs-API ──────────────────────────────────────────────
// Hold-Marker: erkennbar an einer Magic-String-Zeile in den Notes.
// Cleanup-Cron findet den Marker und löscht abgelaufene Reservierungen.
const HOLD_MARKER = '[hold-v1]';

/**
 * Reserve a slot in eTermin without notifying the customer or syncing to
 * external calendars. The appointment exists (so the slot is blocked for
 * other users) but is invisible to the workshop's external view.
 *
 * @returns {{ reservationId, expiresAt }}
 */
async function reserveSlot({
  calendarId,
  start,            // "yyyy-mm-dd HH:MM"
  end,              // "yyyy-mm-dd HH:MM"
  services,         // array of eTermin service IDs
  ttlMinutes = 30   // how long the hold is valid (cleanup-cron enforces)
}) {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const params = new URLSearchParams({
    calendarid: calendarId,
    start,
    end,
    firstname:  'Reservierung',
    lastname:   '— bitte nicht buchen',
    email:      'reservierung@spoxhub.io',
    phone:      '',
    notes:      `${HOLD_MARKER} expires=${expiresAt}\nReservierung über Booking-Tool — wartet auf Anzahlung.`,
    sendemail:  '0',           // Kunde bekommt KEINE Mail
    manualconfirmed: '0',
    sync:       '1',           // SOFORT in externen Kalender (Reservierung erkennbar)
    appattrib:  '0',           // KEINE Anzahlung markiert — Cron-Sicherheitsnetz nutzt das
    canceldeadline: '1440'
  });
  if (services) {
    const s = Array.isArray(services) ? services.join(',') : services;
    if (s) params.set('services', s);
  }

  const url = `/appointment?${params.toString()}`;
  console.log('[etermin] reserveSlot →', url);
  const result = await eterminFetch(url, { method: 'POST' });

  // eTermin returns two IDs:
  //   - `ID`  = UUID/ExternalID, the value PUT/DELETE expect as `id` param
  //   - `IID` = internal numeric ID, used only in the listing endpoint
  // Confirmed empirically: PUT with the numeric IID returns 404
  // ("ID does not exist!"), PUT with the UUID returns 200.
  const reservationId = result?.ID || result?.ExternalID;
  if (!reservationId) {
    throw new Error('eTermin POST returned no ID: ' + JSON.stringify(result));
  }
  return { reservationId, expiresAt };
}

/**
 * Update an existing appointment via PUT. Used to turn a reservation into
 * a confirmed booking (sync=1, appattrib=1, real customer data).
 *
 * The set of fields eTermin's PUT accepts is empirically the same query-string
 * format as POST. Pass only the fields you actually want to change.
 */
async function updateAppointment(appointmentId, fields = {}) {
  // eTermin's PUT requires:
  //   - id  = the UUID/ExternalID (numeric IID returns 404!)
  //   - all data in form-urlencoded BODY, not query string
  //   - start / end / calendarid must be re-sent each time (otherwise the
  //     API errors with "String '' was not recognized as a valid DateTime")
  const body = new URLSearchParams({ id: String(appointmentId) });
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    body.set(k, String(v));
  }
  console.log('[etermin] updateAppointment id=' + appointmentId + ' fields=' + Object.keys(fields).join(','));
  return await eterminFetch('/appointment', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
}

/**
 * Convert a reservation into a confirmed booking — fills in customer data,
 * sets sync=1 and appattrib=<paid value>, and overwrites the notes.
 *
 * Built on top of updateAppointment but with the same parameter shape as
 * createAppointment, so the api-booking handler can swap between the two
 * paths transparently.
 */
async function confirmReservation(reservationId, {
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
  const paidAttrib = process.env.ETERMIN_PAID_APPATTRIB || '1';
  const fields = {
    start, end,
    firstname: customer?.vorname || '',
    lastname:  customer?.name    || '',
    email:     customer?.email   || '',
    phone:     customer?.mobil   || '',
    street:    customer?.strasse || '',
    zip:       customer?.plz     || '',
    city:      customer?.ort     || '',
    notes:     notes || '',
    sendemail:        '1',
    manualconfirmed:  '1',
    sync:             '1',
    appattrib:        paidAttrib,
    canceldeadline:   '1440'
  };
  if (location) fields.location = location;
  if (services) {
    const s = Array.isArray(services) ? services.join(',') : services;
    if (s) fields.services = s;
  }
  if (agbAccepted)        fields.agbaccepted = '1';
  if (privacyAccepted)    fields.dataprivacyaccepted = '1';
  if (newsletter)         fields.newsletter = '1';
  if (feedbackPermission) fields.feedbackpermissionaccepted = '1';

  if (bike?.marke)        fields.additional1 = bike.marke;
  if (bike?.modell)       fields.additional2 = bike.modell;
  if (bike?.rahmennummer) fields.additional3 = bike.rahmennummer;
  if (bike?.leasing)      fields.additional4 = bike.leasing;
  if (bike?.leasingNr)    fields.additional5 = bike.leasingNr;

  const hasAltBilling = !!(customer?.rechnungStrasse || customer?.rechnungFirma);
  const billing = hasAltBilling
    ? [customer.rechnungFirma, customer.rechnungStrasse,
       `${customer.rechnungPlz || ''} ${customer.rechnungOrt || ''}`.trim()].filter(Boolean).join(', ')
    : [customer?.strasse,
       `${customer?.plz || ''} ${customer?.ort || ''}`.trim()].filter(Boolean).join(', ');
  if (billing) fields.additional8 = billing;

  if (payment?.orderId)     fields.additional9  = payment.orderId;
  if (bike?.versicherung)   fields.additional16 = bike.versicherung;
  if (bike?.versicherungNr) fields.additional17 = bike.versicherungNr;

  // Always include calendarid in PUT — empirically eTermin's PUT is happier
  // with it and Verify-Read needs it anyway.
  if (calendarId) fields.calendarid = String(calendarId);

  const result = await updateAppointment(reservationId, fields);

  // Verify-Read: empirically we have seen cases where the PUT returns
  // "1 records updated!" but the notes still carry the hold-marker. Re-read
  // the appointment, and retry once if necessary.
  if (calendarId) {
    try {
      const slotDate = String(start).slice(0, 10);
      const apts = await getAppointments(calendarId, slotDate, slotDate);
      const ours = (apts || []).find(a => a.ExternalID === reservationId);
      if (ours && String(ours.Notes || '').includes(HOLD_MARKER)) {
        console.warn(`[etermin] confirmReservation: hold-marker still in notes for ${reservationId} — retrying PUT`);
        await updateAppointment(reservationId, fields);
        const apts2 = await getAppointments(calendarId, slotDate, slotDate).catch(() => []);
        const ours2 = (apts2 || []).find(a => a.ExternalID === reservationId);
        if (ours2 && String(ours2.Notes || '').includes(HOLD_MARKER)) {
          console.error(`[etermin] confirmReservation: hold-marker STILL present after retry for ${reservationId} — manual cleanup needed`);
        } else {
          console.log(`[etermin] confirmReservation: retry succeeded for ${reservationId}`);
        }
      }
    } catch (err) {
      console.warn(`[etermin] confirmReservation verify-read failed (${err.message}) — booking still confirmed`);
    }
  }

  return result;
}

/**
 * Find stale reservations across all active workshop calendars and the date
 * range [today, today + days]. Returns array of { calendarId, id, expiresAt }.
 *
 * Used by scripts/cleanup-stale-reservations.js.
 */
async function findStaleReservations({ calendars, days = 90, now = Date.now() } = {}) {
  if (!Array.isArray(calendars) || calendars.length === 0) return [];

  const fromDate = new Date(now).toISOString().slice(0, 10);
  const toDate   = new Date(now + days * 86_400_000).toISOString().slice(0, 10);

  const stale = [];
  for (const cal of calendars) {
    const apts = await getAppointments(cal, fromDate, toDate).catch(() => []);
    for (const a of (apts || [])) {
      // Vier-fach-Sicherheitsnetz: NUR löschen wenn ALLE Kriterien zutreffen.
      // Manuelle Werkstatt-Einträge oder echte Buchungen erfüllen niemals alle vier.
      const notes = String(a.Notes || a.notes || '');
      if (!notes.includes(HOLD_MARKER)) continue;                  // (1) Tool-Marker
      if (Number(a.appattrib ?? 0) !== 0) continue;                // (2) keine Anzahlung
      if ((a.FirstName || '') !== 'Reservierung') continue;        // (3) Reservierungs-Name
      // Nur ISO-Datum-Zeichen matchen — eTermin speichert die Notes teils mit
      // literalen "\n" (Backslash+n), ein [^\s]+ würde über den Timestamp
      // hinaus matchen und Date.parse zu NaN machen.
      const match = notes.match(/expires=([0-9T:.Z+-]+)/);
      const expiresAt = match ? Date.parse(match[1]) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;// (4) abgelaufen
      stale.push({
        calendarId: cal,
        // ExternalID (UUID) ist nötig für PUT/DELETE — die numerische ID
        // funktioniert beim DELETE-Endpunkt nicht zuverlässig.
        id: a.ExternalID || a.ID || a.IID || a.AppointmentID,
        expiresAt: match?.[1]
      });
    }
  }
  return stale;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS — eTermin-Kundendatenbank (/contact)
//
// eTermin filtert serverseitig nach `email` (exakt) und `cid`. Andere Filter
// (phone/name) werden ignoriert → dafür holen wir die Vollliste (gecacht) und
// filtern im Speicher.
// ─────────────────────────────────────────────────────────────────────────────

let _contactsCache = null;
let _contactsCacheTime = 0;
const CONTACTS_CACHE_TTL = 5 * 60 * 1000; // 5 Min

/**
 * Roh-Kontakte aus eTermin laden. `query` = Querystring ohne führendes '?'.
 * Liefert immer ein Array.
 */
async function getContacts(query = '') {
  const qs = query ? `?${query.replace(/^\?/, '')}` : '';
  const data = await eterminFetch(`/contact${qs}`);
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

/**
 * Einzelnen Kontakt per E-Mail (exakt, case-insensitive) finden.
 * Nutzt den serverseitigen Filter; gibt null zurück, wenn nichts passt.
 */
async function findContactByEmail(email) {
  if (!email) return null;
  const list = await getContacts(`email=${encodeURIComponent(email)}`);
  const lc = String(email).trim().toLowerCase();
  return list.find(c => String(c.Email || '').trim().toLowerCase() === lc) || null;
}

/** Vollständige Kontaktliste, 5 Min gecacht (für Name-Teilsuche). */
async function getAllContactsCached() {
  if (_contactsCache && Date.now() - _contactsCacheTime < CONTACTS_CACHE_TTL) {
    return _contactsCache;
  }
  const list = await getContacts();
  _contactsCache = list;
  _contactsCacheTime = Date.now();
  return list;
}

/**
 * Kontakte per Namens-Teilstring (Vor-/Nachname, beide Reihenfolgen) suchen.
 * @returns {Promise<object[]>} bis zu `limit` Treffer
 */
async function searchContactsByName(name, limit = 25) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return [];
  const list = await getAllContactsCached();
  const matches = list.filter(c => {
    const fwd = `${c.FirstName || ''} ${c.LastName || ''}`.toLowerCase();
    const rev = `${c.LastName || ''} ${c.FirstName || ''}`.toLowerCase();
    return fwd.includes(q) || rev.includes(q);
  });
  return matches.slice(0, limit);
}

module.exports = {
  deleteAppointment,
  listCalendars,
  getAvailableSlots,
  getMonthAvailability,
  createAppointment,
  reserveSlot,
  confirmReservation,
  updateAppointment,
  findStaleReservations,
  getWorkingTimes,
  getNonWorkingTimes,
  getAppointments,
  getContacts,
  findContactByEmail,
  searchContactsByName,
  HOLD_MARKER
};
