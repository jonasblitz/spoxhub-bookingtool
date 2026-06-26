/**
 * Auto-Pause Sync — schreibt die geplante Mittagspause als „auto-pause"-
 * Termin in eTermin und hält sie bei Veränderungen aktuell.
 *
 * Erkennungsmerkmal: Notes enthält den Marker AUTO_PAUSE_MARKER.
 *
 * Trigger:
 *   - Nach jeder erfolgreichen Buchung im Booking-Tool (siehe routes/api-booking.js)
 *   - Täglich per Cron für die nächsten N Tage (scripts/sync-auto-pauses.js)
 */

const etermin = require('./etermin');
const calendars = require('./calendars');
const { parseHM, formatHM } = require('./slots');

const AUTO_PAUSE_MARKER = '[auto-pause-v1]';

// ─────────────────────────────────────────────────────────────────────────────
// Pause-Berechnung (gleiche Regeln wie in slots.js, aber als reine Berechnung)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liefert die geplante Pause für einen Tag, gegeben die echten Termine
 * (ohne Auto-Pause-Marker) im Pause-Fenster.
 *
 * Sucht die früheste freie Lücke im Pause-Fenster, in die die Pause ganz
 * hineinpasst:
 *   1. zwischen Fenster-Start und erstem Termin
 *   2. zwischen zwei aufeinanderfolgenden Terminen
 *   3. zwischen letztem Termin und Fenster-Ende
 *
 * Beispiel pauseLen=45, Fenster 12:00–14:00, Kundentermin 12:45–14:05:
 *   früher: Pause "nach letztem Termin" → 14:05–14:50 → passt nicht → null
 *   jetzt:  Lücke 12:00–12:45 (45 Min) → Pause 12:00–12:45 ✓
 *
 * @returns { startMin, endMin } oder null wenn keine Pause nötig/möglich.
 */
function computePlannedPause(realAptsInWindow, calendar) {
  const pauseWinStart = parseHM(calendar.pausenFenstrStart) ?? 12 * 60;
  const pauseWinEnd   = parseHM(calendar.pausenFenstrEnde)  ?? 14 * 60;
  const pauseLen      = Number(calendar.pausenLaenge) || 0;
  if (!pauseLen) return null;

  const inWindow = realAptsInWindow
    .filter(a => a.endMin > pauseWinStart && a.startMin < pauseWinEnd)
    .sort((a, b) => a.startMin - b.startMin);

  let cursor = pauseWinStart;
  for (const apt of inWindow) {
    if (apt.startMin - cursor >= pauseLen) {
      return { startMin: cursor, endMin: cursor + pauseLen };
    }
    cursor = Math.max(cursor, apt.endMin);
  }
  if (pauseWinEnd - cursor >= pauseLen) {
    return { startMin: cursor, endMin: cursor + pauseLen };
  }
  return null; // keine Lücke
}

/**
 * Werktags-Check: Sonntag immer geschlossen, Samstag nur wenn samstagsAktiv.
 */
function isDayOpen(date, calendar) {
  const dow = new Date(date + 'T00:00:00').getDay(); // 0=Sun, 6=Sat
  if (dow === 0) return false;
  if (dow === 6 && !calendar.samstagsAktiv) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — appointment date/time extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractAptInfo(apt, date) {
  const s = apt.StartDateTime || apt.Startdatetime || apt.Start;
  const e = apt.EndDateTime   || apt.Enddatetime   || apt.End;
  if (!s || !e) return null;
  if (s.substring(0, 10) !== date) return null;
  return {
    id: apt.ID || apt.IID,
    startMin: parseInt(s.substring(11, 13), 10) * 60 + parseInt(s.substring(14, 16), 10),
    endMin:   parseInt(e.substring(11, 13), 10) * 60 + parseInt(e.substring(14, 16), 10),
    notes: apt.Notes || '',
    blocked: !!apt.BlockedApp
  };
}

function isAutoPauseApt(apt) {
  // 1. Notes-Marker (sauberer, neuer Stand)
  if ((apt.Notes || '').includes(AUTO_PAUSE_MARKER)) return true;
  // 2. Fallback: firstname="Auto" + lastname="Mittagspause" — fängt Alt-
  //    Termine ohne Marker und CalDav-Sync-Echos ab, sodass die Sync-Logik
  //    sie als Auto-Pause erkennt und nicht versehentlich eine zweite
  //    Pause direkt daneben einplant.
  const fn = (apt.FirstName || '').trim();
  const ln = (apt.LastName  || '').trim();
  return fn === 'Auto' && ln === 'Mittagspause';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync logic — for one (calendar, date) pair
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync the auto-pause for a single day on a single calendar.
 *
 * @returns { action, before, after, error? } describing what was done.
 */
async function syncAutoPauseForDay(calendarId, date) {
  const cal = (await calendars.loadCalendars()).find(c => c.id === Number(calendarId));
  if (!cal) return { action: 'skip', reason: 'calendar not found' };
  if (!cal.aktiv)            return { action: 'skip', reason: 'calendar inactive' };
  if (!cal.pausenLaenge)     return { action: 'skip', reason: 'no pause configured' };
  if (!cal.arbeitszeitStart) return { action: 'skip', reason: 'no working hours' };

  // Wochenend-/Schließtags-Check: an geschlossenen Tagen darf keine Pause stehen.
  // Bereinigt nebenbei evtl. fehlerhaft angelegte Bestands-Pausen.
  if (!isDayOpen(date, cal)) {
    const all = await etermin.getAppointments(calendarId, date, date);
    const autoPauseApts = all.filter(isAutoPauseApt);
    if (autoPauseApts.length === 0) return { action: 'skip', reason: 'closed (weekend/sunday)' };
    for (const a of autoPauseApts) {
      try { await etermin.deleteAppointment(a.ExternalID || a.ID || a.IID); }
      catch (e) { console.warn(`[auto-pause] delete failed for apt ${a.ExternalID || a.ID}:`, e.message); }
    }
    return { action: 'deleted', count: autoPauseApts.length, reason: 'closed (weekend/sunday)' };
  }

  // 1. Get all appointments for the day
  const all = await etermin.getAppointments(calendarId, date, date);

  // 2. Split into auto-pause markers vs real appointments
  const autoPauseApts = all.filter(isAutoPauseApt);
  const realApts = all
    .filter(a => !isAutoPauseApt(a))
    .map(a => extractAptInfo(a, date))
    .filter(Boolean)
    // Skip manually-blocked appointments (e.g. user-set Mittagspause) — they
    // already serve as the pause; we won't duplicate.
    .filter(a => !a.blocked);

  // If there's a manually-blocked apt in the pause window, don't add an auto-pause
  const pauseWinStart = parseHM(cal.pausenFenstrStart) ?? 12 * 60;
  const pauseWinEnd   = parseHM(cal.pausenFenstrEnde)  ?? 14 * 60;
  const manuallyBlocked = all
    .map(a => extractAptInfo(a, date))
    .filter(Boolean)
    .some(a => a.blocked && !isAutoPauseApt({ Notes: a.notes })
            && a.endMin > pauseWinStart && a.startMin < pauseWinEnd);

  // 3. Compute the planned pause
  const planned = manuallyBlocked
    ? null
    : computePlannedPause(realApts, cal);

  // 4. Reconcile
  if (!planned) {
    // No planned pause — delete any existing auto-pause markers
    if (autoPauseApts.length === 0) return { action: 'noop', reason: 'no pause needed' };
    for (const a of autoPauseApts) {
      // WICHTIG: ExternalID (UUID) verwenden, sonst greift weder der DELETE
      // selbst noch der CalDav-Sync zum externen Kalender — sonst bleibt
      // die Pause als Karteileiche im iCal stehen.
      try { await etermin.deleteAppointment(a.ExternalID || a.ID || a.IID); }
      catch (e) { console.warn(`[auto-pause] delete failed for apt ${a.ExternalID || a.ID}:`, e.message); }
    }
    return { action: 'deleted', count: autoPauseApts.length };
  }

  // We need a pause at planned.startMin–planned.endMin
  const wantedStart = formatHM(planned.startMin);
  const wantedEnd   = formatHM(planned.endMin);

  // Check if any existing marker matches
  const existing = autoPauseApts.map(a => extractAptInfo(a, date)).filter(Boolean);
  const matching = existing.filter(a =>
    a.startMin === planned.startMin && a.endMin === planned.endMin
  );

  if (matching.length === 1 && existing.length === 1) {
    return { action: 'noop', reason: 'already correct', at: `${wantedStart}-${wantedEnd}` };
  }

  // Delete all existing auto-pause markers (drift, duplicates, wrong-time)
  // ExternalID (UUID) verwenden — sonst greift weder DELETE noch CalDav-Sync.
  for (const a of autoPauseApts) {
    try { await etermin.deleteAppointment(a.ExternalID || a.ID || a.IID); }
    catch (e) { console.warn(`[auto-pause] delete failed for apt ${a.ExternalID || a.ID}:`, e.message); }
  }

  // Create the correct one
  await createAutoPauseAppointment(cal, date, wantedStart, wantedEnd);

  return {
    action: existing.length > 0 ? 'replaced' : 'created',
    at: `${wantedStart}-${wantedEnd}`,
    deleted: existing.length
  };
}

/**
 * Create an auto-pause appointment in eTermin.
 */
async function createAutoPauseAppointment(calendar, date, startHM, endHM) {
  const startDateTime = `${date} ${startHM}`;
  const endDateTime   = `${date} ${endHM}`;
  return etermin.createAppointment({
    calendarId: calendar.id,
    start: startDateTime,
    end:   endDateTime,
    customer: { vorname: 'Auto', name: 'Mittagspause', email: '', mobil: '' },
    notes: `Mittagspause ${AUTO_PAUSE_MARKER}`
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync auto-pause for a specific calendar+date. Used after each booking.
 * Fail-soft: errors are logged but not thrown.
 */
async function syncAfterBooking(calendarId, date) {
  try {
    const result = await syncAutoPauseForDay(calendarId, date);
    if (result.action !== 'noop' && result.action !== 'skip') {
      console.log(`[auto-pause] cal ${calendarId} ${date}: ${result.action}`,
        result.at ? `→ ${result.at}` : '');
    }
    return result;
  } catch (err) {
    console.error(`[auto-pause] sync error for cal ${calendarId} ${date}:`, err.message);
    return { action: 'error', error: err.message };
  }
}

/**
 * Sync auto-pause for all active calendars across the next N days.
 * Used by daily cron.
 */
async function syncAllForNextDays(days = 30) {
  const cals = (await calendars.loadCalendars()).filter(c => c.aktiv && c.pausenLaenge);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results = [];
  for (const cal of cals) {
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().substring(0, 10);
      const r = await syncAutoPauseForDay(cal.id, date);
      results.push({ calendar: cal.name, date, ...r });
    }
  }
  return results;
}

module.exports = {
  AUTO_PAUSE_MARKER,
  syncAutoPauseForDay,
  syncAfterBooking,
  syncAllForNextDays
};
