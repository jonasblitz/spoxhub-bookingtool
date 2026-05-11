/**
 * Slot Generator — Cluster-Greedy.
 *
 * Generates available slot start times for a single calendar on a single day,
 * given the calendar's working hours, lunch-break window, travel buffer and
 * existing appointments.
 *
 * Rules (per user spec):
 *   1. Sundays are closed; Saturdays only when calendar.samstagsAktiv.
 *   2. The first slot of the day starts exactly at workingStart (no rounding).
 *   3. Subsequent slot candidates are placed on a 15-minute grid.
 *   4. Cluster-Greedy: only ONE candidate per "gap" — the earliest that fits.
 *   5. Lunch break: dynamic within [pausenFenstrStart, pausenFenstrEnde]:
 *        - if any appointment overlaps the window, pause locks right after the
 *          latest such appointment (must still fit before pausenFenstrEnde)
 *        - else pause defaults to pausenFenstrStart
 *   6. A new candidate that would push the pause past pausenFenstrEnde is
 *      rejected — i.e. its end time + pausenLaenge <= pausenFenstrEnde when it
 *      reaches into the window.
 *   7. Working day end: candidate.end <= workingEnd.
 *   8. Travel buffer (mobile only) inserted between the candidate and the next
 *      gap start.
 *   9. Travel from depot to first appointment is already baked into workingStart.
 */

// ─── Time helpers (HH:MM ↔ minutes since midnight) ──────────────────────────

function parseHM(hm) {
  if (!hm || typeof hm !== 'string') return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ceil15(minutes) {
  return Math.ceil(minutes / 15) * 15;
}

// ─── Day-of-week check ──────────────────────────────────────────────────────

function isDayOpen(date, calendar) {
  // date format: 'YYYY-MM-DD'
  const dow = new Date(date + 'T00:00:00').getDay(); // 0=Sun, 6=Sat
  if (dow === 0) return false;                            // Sunday closed
  if (dow === 6 && !calendar.samstagsAktiv) return false; // Saturday gated
  return true;
}

// ─── Pause computation ──────────────────────────────────────────────────────

/**
 * Determine the locked pause time for a day, based on existing appointments.
 *   If any existing appointment overlaps the pause window, the pause locks
 *   right after the latest such appointment.
 *   Otherwise pause defaults to pausenFenstrStart.
 *
 * @returns { start, end } in minutes, or null if pause would not fit.
 */
function computePauseTime(appointmentsMin, pauseStartWindow, pauseEndWindow, pauseLength) {
  if (!pauseLength) return null;

  // Appointments that intersect the pause window
  const inWindow = appointmentsMin.filter(a =>
    a.end > pauseStartWindow && a.start < pauseEndWindow
  );

  let pauseStart;
  if (inWindow.length > 0) {
    pauseStart = Math.max(...inWindow.map(a => a.end));
  } else {
    pauseStart = pauseStartWindow;
  }

  const pauseEnd = pauseStart + pauseLength;
  if (pauseEnd > pauseEndWindow) {
    // Pause would not fit — should be prevented by booking validation.
    // Return the pause anyway so generator can surface the broken state.
    return { start: pauseStart, end: pauseEnd, broken: true };
  }
  return { start: pauseStart, end: pauseEnd, broken: false };
}

// ─── Main slot generator ────────────────────────────────────────────────────

/**
 * Generate slot candidates for a day.
 *
 * @param {string} date       — 'YYYY-MM-DD'
 * @param {object} calendar   — entry from lib/calendars.js
 * @param {number} duration   — service duration in minutes (>=1)
 * @param {Array<{start:string,end:string}>} existingAppointments — existing appointments,
 *           start/end in 'YYYY-MM-DD HH:MM' or just 'HH:MM' (assumed same date).
 * @returns {Array<{start:string,end:string}>}  candidate slots (HH:MM strings)
 */
function generateSlots(date, calendar, duration, existingAppointments = []) {
  if (!isDayOpen(date, calendar)) return [];

  // Frühestens für den Folgetag buchbar — heute und Vergangenheit sperren.
  // Berlin-Zeit, weil der Server in UTC laufen kann.
  const todayBerlin = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  if (date <= todayBerlin) return [];

  const workingStart = parseHM(calendar.arbeitszeitStart);
  const workingEnd   = parseHM(calendar.arbeitszeitEnde);
  if (workingStart == null || workingEnd == null) return [];

  const pauseWinStart = parseHM(calendar.pausenFenstrStart) ?? 12 * 60;
  const pauseWinEnd   = parseHM(calendar.pausenFenstrEnde)  ?? 14 * 60;
  const pauseLength   = Number(calendar.pausenLaenge) || 0;
  const travelBuffer  = (calendar.typ === 'mobil')
    ? (Number(calendar.travelBufferMin) || 25)
    : 0;

  // Convert appointments to minute ranges, including the BlockedApp flag.
  // Filter out anything entirely outside working hours (Starttermin, Feierabend, …).
  // Also detect our own auto-pause marker — those count as blocked.
  const aptsRaw = (existingAppointments || [])
    .map(a => {
      const norm = normalizeAppointment(a, date);
      if (!norm) return null;
      const isAutoPause = (a.Notes || '').includes('[auto-pause-v1]');
      return { ...norm, blocked: !!a.BlockedApp || isAutoPause };
    })
    .filter(Boolean)
    .filter(a => a.end > workingStart && a.start < workingEnd)
    .sort((x, y) => x.start - y.start);

  const realApts    = aptsRaw.filter(a => !a.blocked);
  const blockedApts = aptsRaw.filter(a =>  a.blocked);

  // Auto-pause logic:
  //   - If a manually-placed "Blocked" appointment overlaps the pause window
  //     (e.g. a "Mittagspause" entry), it serves as the pause — no extra pause.
  //   - Otherwise compute one based on real appointments in the window.
  const blockedInWindow = blockedApts.filter(a =>
    a.end > pauseWinStart && a.start < pauseWinEnd
  );
  let pause = null;
  if (blockedInWindow.length === 0) {
    pause = computePauseTime(realApts, pauseWinStart, pauseWinEnd, pauseLength);
  }

  // Build the blocked list:
  //   - real apts get the travel buffer on BOTH sides:
  //       end + buffer  → next slot must wait for the tech to arrive at next address
  //       start - buffer → previous slot must end early enough to leave for this one
  //     Clamped to workingStart so the first apt's pre-buffer doesn't push us
  //     before the working day. (Depot-to-first-apt travel time is already
  //     baked into workingStart, but a NEW slot booked before the first apt
  //     still needs the travel buffer to the existing first apt.)
  //   - blocked apts (manual eTermin Sperren) get no buffer.
  //   - auto-computed pause (if any) gets no buffer.
  const blocked = [];
  realApts.forEach(a => {
    blocked.push({
      start: Math.max(workingStart, a.start - travelBuffer),
      end:   a.end + travelBuffer,
      kind:  'apt'
    });
  });
  blockedApts.forEach(a => {
    blocked.push({ start: a.start, end: a.end, kind: 'blocked' });
  });
  if (pause && !pause.broken) {
    blocked.push({ start: pause.start, end: pause.end, kind: 'pause' });
  }
  blocked.sort((a, b) => a.start - b.start);

  // Cluster-Greedy with anchor pairs: per gap, try to place TWO candidates —
  // an "early" one at the gap start and a "late" one at the gap end. If the
  // gap is too small for two non-overlapping slots, only the early one is
  // placed. On an empty day this gives 4 anchors (morning, pre-lunch,
  // post-lunch, end-of-day) instead of just 2.
  const candidates = [];
  let pointer = workingStart;
  let isFirstGap = true;

  for (let i = 0; i <= blocked.length; i++) {
    const blocker = blocked[i];                // undefined for the trailing gap
    let   gapEnd  = blocker ? blocker.start : workingEnd;

    if (pointer < gapEnd) {
      // ─── EARLY candidate (gap start) ───────────────────────────────────────
      let earlyStart = isFirstGap ? workingStart : ceil15(pointer);
      let earlyEnd   = earlyStart + duration;
      let earlyPlaced = false;

      if (earlyEnd <= workingEnd) {
        let earlyValid = (earlyStart < gapEnd) && (earlyEnd <= gapEnd);

        // Pause-Push: if the gap ends at the pause AND the candidate would push
        // the pause to a still-fitting position, slide the pause forward.
        if (!earlyValid && blocker && blocker.kind === 'pause' && earlyStart < pauseWinEnd) {
          const newPauseStart = earlyEnd;
          const newPauseEnd   = newPauseStart + pauseLength;
          const fitsWindow    = newPauseEnd <= pauseWinEnd;
          const noAptConflict = !realApts.some(a =>
            earlyStart < a.end + travelBuffer && earlyEnd > a.start - travelBuffer
          );
          if (fitsWindow && noAptConflict) {
            blocker.start = newPauseStart;
            blocker.end   = newPauseEnd;
            gapEnd        = newPauseStart;       // also shrink for the late check below
            earlyValid    = true;
          }
        }

        if (earlyValid) {
          candidates.push({
            start: formatHM(earlyStart),
            end:   formatHM(earlyEnd),
            label: `${formatHM(earlyStart)} Uhr`
          });
          earlyPlaced = true;
        }
      }

      // ─── LATE candidate (gap end) — only if room for a second non-overlap ──
      if (earlyPlaced) {
        let lateStart = Math.floor((gapEnd - duration) / 15) * 15;
        let lateEnd   = lateStart + duration;
        const fitsGap     = (lateStart >= pointer) && (lateEnd <= gapEnd) && (lateEnd <= workingEnd);
        const distinct    = lateStart > earlyStart;
        const noOverlap   = lateStart >= earlyEnd;
        if (fitsGap && distinct && noOverlap) {
          candidates.push({
            start: formatHM(lateStart),
            end:   formatHM(lateEnd),
            label: `${formatHM(lateStart)} Uhr`
          });
        }
      }
    }

    // Always advance past the current blocker (whether candidate was placed or not)
    if (blocker) pointer = Math.max(pointer, blocker.end);
    isFirstGap = false;
  }

  return candidates;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an appointment object to { start, end } in minutes-since-midnight.
 * Accepts:
 *   - { start: 'YYYY-MM-DD HH:MM', end: '...' }
 *   - { start: 'YYYY-MM-DDTHH:MM:SS', end: '...' }
 *   - { Start, End } (eTermin shape)
 *   - { start: 'HH:MM', end: '...' }
 * Returns null if the appointment is on a different date or unparseable.
 */
function normalizeAppointment(apt, date) {
  const s = apt.start || apt.Start || apt.startTime || apt.StartTime
         || apt.StartDateTime || apt.Startdatetime;
  const e = apt.end   || apt.End   || apt.endTime   || apt.EndTime
         || apt.EndDateTime || apt.Enddatetime;
  if (!s || !e) return null;

  const sParsed = extractTime(s, date);
  const eParsed = extractTime(e, date);
  if (sParsed == null || eParsed == null) return null;

  return { start: sParsed, end: eParsed };
}

function extractTime(str, date) {
  if (typeof str !== 'string') return null;
  // YYYY-MM-DD HH:MM[:SS] or YYYY-MM-DDTHH:MM[:SS]
  const dt = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (dt) {
    if (date && dt[1] !== date) return null; // wrong date
    return parseInt(dt[2], 10) * 60 + parseInt(dt[3], 10);
  }
  // Plain HH:MM
  const t = str.match(/^(\d{1,2}):(\d{2})/);
  if (t) return parseInt(t[1], 10) * 60 + parseInt(t[2], 10);
  return null;
}

module.exports = {
  generateSlots,
  // Helpers exposed for testing / re-use
  parseHM,
  formatHM,
  ceil15,
  isDayOpen,
  computePauseTime
};
