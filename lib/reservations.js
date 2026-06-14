/**
 * Slot-Reservierungs-Store (In-Memory).
 *
 * Hält Reservierungen für ~20 Minuten in einer Map<reservationId, Reservation>.
 * Wird beim Slot-Picker (lib/etermin.js → getAvailableSlots, getMonthAvailability)
 * konsultiert, damit eine laufende Reservierung den Slot für andere User blockiert.
 *
 * Ersetzt das alte „Hold-Termin in eTermin"-Pattern. Keine eTermin-Calls mehr für
 * Reservierungen — eTermin sieht nur noch bestätigte, bezahlte Buchungen.
 *
 * Lifecycle:
 *   - reserve()   bei /api/booking/reserve-slot
 *   - release()   bei /api/booking/release-slot oder nach erfolgreichem /confirm
 *   - sweep()     alle 60s automatisch (interner setInterval)
 *
 * Restart-Verhalten: Map ist nach pm2-Restart leer. User mid-flow bekommen beim
 * /confirm eine kontrollierte Fehlermeldung. Bezahlte Buchungen sind ohnehin
 * schon in eTermin und nicht betroffen.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MINUTES = 20;
const SWEEP_INTERVAL_MS = 60 * 1000;
const WARN_THRESHOLD = 100;

/** @type {Map<string, Reservation>} */
const _store = new Map();

let _hasWarnedSize = false;

/**
 * Reservation shape:
 *   {
 *     id:               string,    // UUID
 *     sessionId:        string|null,
 *     calendarId:       number,
 *     date:             'YYYY-MM-DD',
 *     startMin:         number,    // minutes since 00:00
 *     endMin:           number,
 *     durationMinutes:  number,    // inkl. Auftrags-Puffer
 *     serviceIds:       number[],  // für Confirm-Replay
 *     createdAt:        number,    // epoch ms
 *     expiresAt:        number     // epoch ms
 *   }
 */

function parseHMtoMin(hm) {
  if (typeof hm !== 'string') return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Versucht einen Slot zu reservieren. Wenn ein bereits aktiver Eintrag im selben
 * Kalender + Zeitfenster überlappt, gibt die Funktion null zurück (=> 409).
 *
 * @param {object} opts
 * @param {number} opts.calendarId
 * @param {string} opts.date           'YYYY-MM-DD'
 * @param {string|number} opts.start   'HH:MM' oder Minuten
 * @param {string|number} opts.end     'HH:MM' oder Minuten
 * @param {string|null}   [opts.sessionId]
 * @param {number[]}      [opts.serviceIds]
 * @param {number}        [opts.durationMinutes]
 * @param {number}        [opts.ttlMinutes]  // default 20
 * @returns {Reservation | null}  null bei Konflikt.
 */
function reserve(opts) {
  const calendarId = Number(opts.calendarId);
  const date       = String(opts.date);
  const startMin   = typeof opts.start === 'number' ? opts.start : parseHMtoMin(opts.start);
  const endMin     = typeof opts.end   === 'number' ? opts.end   : parseHMtoMin(opts.end);
  if (!Number.isFinite(calendarId) || !date || startMin == null || endMin == null) {
    throw new Error('reservations.reserve: ungültige Parameter');
  }
  if (endMin <= startMin) {
    throw new Error('reservations.reserve: endMin muss > startMin sein');
  }

  // Vor jedem Insert sweep-en, damit überlappende abgelaufene nicht blockieren.
  _sweepInline();

  const conflicts = _activeOverlappingInternal(calendarId, date, startMin, endMin, /*excludeId*/ null);
  if (conflicts.length > 0) return null;

  const ttlMinutes = Number(opts.ttlMinutes) > 0 ? Number(opts.ttlMinutes) : DEFAULT_TTL_MINUTES;
  const now = Date.now();
  const reservation = {
    id: crypto.randomUUID(),
    sessionId: opts.sessionId || null,
    calendarId,
    date,
    startMin,
    endMin,
    durationMinutes: Number(opts.durationMinutes) || (endMin - startMin),
    serviceIds: Array.isArray(opts.serviceIds) ? opts.serviceIds.filter(Boolean) : [],
    createdAt: now,
    expiresAt: now + ttlMinutes * 60_000
  };

  _store.set(reservation.id, reservation);

  if (_store.size === 1) {
    console.log('[reservations] first active entry — sweep loop is running');
  }
  if (_store.size > WARN_THRESHOLD && !_hasWarnedSize) {
    console.warn(`[reservations] store size > ${WARN_THRESHOLD} (=${_store.size}) — possible leak`);
    _hasWarnedSize = true;
  }
  console.log(`[reservations] +reserve ${reservation.id} cal=${calendarId} ${date} ${formatHM(startMin)}-${formatHM(endMin)} active=${_store.size}`);

  return reservation;
}

/**
 * Entfernt eine Reservierung. Idempotent — kein Fehler wenn schon weg.
 * @returns {boolean} true wenn etwas gelöscht wurde
 */
function release(reservationId) {
  if (!reservationId) return false;
  const had = _store.delete(reservationId);
  if (had) {
    console.log(`[reservations] -release ${reservationId} active=${_store.size}`);
  }
  return had;
}

/**
 * Verlängert die Lebenszeit einer Reservierung (z.B. wenn der User noch im
 * PayPal-Approve-Fenster ist).
 */
function extend(reservationId, ttlMinutes = DEFAULT_TTL_MINUTES) {
  const r = _store.get(reservationId);
  if (!r) return false;
  r.expiresAt = Date.now() + Number(ttlMinutes) * 60_000;
  return true;
}

/**
 * @returns {Reservation | null}  null wenn nicht (mehr) vorhanden oder abgelaufen
 */
function get(reservationId) {
  if (!reservationId) return null;
  const r = _store.get(reservationId);
  if (!r) return null;
  if (r.expiresAt <= Date.now()) {
    _store.delete(reservationId);
    return null;
  }
  return r;
}

function isExpired(reservationId) {
  const r = _store.get(reservationId);
  if (!r) return true;
  return r.expiresAt <= Date.now();
}

/**
 * Reservierungen, die mit dem gegebenen Zeitfenster überlappen.
 * Optional `excludeId` ausschließen (z.B. die eigene Reservierung beim Re-Check).
 *
 * @returns {Reservation[]}
 */
function activeOverlapping(calendarId, date, startMin, endMin, excludeId = null) {
  _sweepInline();
  return _activeOverlappingInternal(Number(calendarId), String(date), Number(startMin), Number(endMin), excludeId);
}

function _activeOverlappingInternal(calendarId, date, startMin, endMin, excludeId) {
  const now = Date.now();
  const out = [];
  for (const r of _store.values()) {
    if (r.expiresAt <= now) continue;
    if (excludeId && r.id === excludeId) continue;
    if (r.calendarId !== calendarId) continue;
    if (r.date !== date) continue;
    // overlap = startA < endB && endA > startB
    if (r.startMin < endMin && r.endMin > startMin) out.push(r);
  }
  return out;
}

/**
 * Alle aktiven Reservierungen für einen Kalender + Datum (z.B. für die Slot-Engine).
 * Liefert minimale {startMin, endMin}-Objekte.
 */
function activeRangesForDay(calendarId, date) {
  _sweepInline();
  const now = Date.now();
  const out = [];
  for (const r of _store.values()) {
    if (r.expiresAt <= now) continue;
    if (r.calendarId !== Number(calendarId)) continue;
    if (r.date !== String(date)) continue;
    out.push({ startMin: r.startMin, endMin: r.endMin });
  }
  return out;
}

/** Anzahl der aktuell gespeicherten (incl. abgelaufenen) Einträge. */
function count() {
  return _store.size;
}

/**
 * Listet alle aktiven Reservierungen (z.B. für Admin-Anzeige im Portal).
 */
function listAll() {
  _sweepInline();
  return Array.from(_store.values()).map(r => ({
    id: r.id,
    calendarId: r.calendarId,
    date: r.date,
    start: formatHM(r.startMin),
    end: formatHM(r.endMin),
    expiresAt: new Date(r.expiresAt).toISOString(),
    msRemaining: Math.max(0, r.expiresAt - Date.now())
  }));
}

/**
 * Synchroner Inline-Sweep — entfernt abgelaufene Einträge. Wird vor jedem Read/Write
 * kurz aufgerufen, damit niemals "expired but still in store" ausgeliefert wird.
 */
function _sweepInline() {
  const now = Date.now();
  for (const [id, r] of _store) {
    if (r.expiresAt <= now) _store.delete(id);
  }
}

/**
 * Periodischer Sweep — sorgt dafür, dass auch ohne API-Activity nichts ewig
 * im Memory hängt. Tagsüber harmlos, hilft hauptsächlich bei nächtlichem Idle.
 */
function sweep() {
  const before = _store.size;
  _sweepInline();
  if (_store.size < before) {
    console.log(`[reservations] sweep removed ${before - _store.size}, active=${_store.size}`);
    if (_store.size <= WARN_THRESHOLD) _hasWarnedSize = false;
  }
}

let _sweepTimer = null;
function startSweepLoop() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (_sweepTimer.unref) _sweepTimer.unref(); // blockiert keinen sauberen Shutdown
}

function stopSweepLoop() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

// Auto-start beim Require — wir wollen nicht, dass jemand vergisst.
startSweepLoop();

function formatHM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = {
  reserve,
  release,
  extend,
  get,
  isExpired,
  activeOverlapping,
  activeRangesForDay,
  count,
  listAll,
  sweep,
  startSweepLoop,
  stopSweepLoop,
  DEFAULT_TTL_MINUTES
};
