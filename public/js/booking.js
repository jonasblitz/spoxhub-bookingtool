/**
 * Booking — Monatskalender + Slot-Picker + Bestätigung
 */

let currentMonth = null; // { year, month } (month 0-indexed)
let selectedDate = null;
let monthAvailability = {}; // { 'YYYY-MM-DD': { available, slotCount } }

/**
 * Returns the LIST of calendar IDs the user is eligible to book in.
 *   - Mobile: alle erreichbaren Kalender aus dem Geo-Check (geoResult.eligible).
 *     Server bildet daraus die Union der freien Slots.
 *   - Werkstatt: leeres Array → Server nutzt alle aktiven Werkstatt-Kalender.
 */
function getCalendarIds() {
  const locationType = BookingState.get('locationType');
  if (locationType === 'mobil' || locationType === 'anderer_ort') {
    const eligible = BookingState.get('geoResult')?.eligible;
    if (Array.isArray(eligible) && eligible.length > 0) {
      return eligible.map(e => Number(e.calendarId)).filter(Boolean);
    }
    // Fallback: Single-Cal-Pick (alte Geo-Antwort)
    const single = BookingState.get('geoResult')?.calendarId;
    return single ? [Number(single)] : [];
  }
  return []; // werkstatt — server picks all active workshops
}

async function initBookingStep() {
  const today = new Date();
  currentMonth = { year: today.getFullYear(), month: today.getMonth() };
  selectedDate = null;
  monthAvailability = {};
  renderSlotsPlaceholder();
  updateLocationConfirm();
  updatePriceSummary();
  await loadMonthAvailabilityAndAutoSelect();
}

// ═══════════════════════════════════════════
// LOCATION CONFIRM
// ═══════════════════════════════════════════

function updateLocationConfirm() {
  const el = document.getElementById('location-confirm-text');
  if (!el) return;

  const loc = BookingState.get('locationType');
  const address = BookingState.get('address');

  if (loc === 'werkstatt') {
    el.textContent = 'Service in der Werkstatt – Keine Anfahrtskosten';
  } else if (address) {
    el.textContent = `Mobiler Service – ${address}`;
  } else {
    el.textContent = 'Standort wird bestätigt...';
  }
}

// ═══════════════════════════════════════════
// PRICE SUMMARY
// ═══════════════════════════════════════════

function updatePriceSummary() {
  const pricing = BookingState.get('pricing');
  const linesEl = document.getElementById('price-summary-lines');
  const totalEl = document.getElementById('price-summary-total');

  if (!pricing || !linesEl) return;

  let html = pricing.lineItems.map(item => {
    const qty = item.quantity || 1;
    const label = qty > 1 ? `${qty} × ${item.name}` : item.name;
    const badge = item.includedInInspektion
      ? `<span class="text-xs text-neon-lime block">inkl. Inspektion</span>`
      : '';
    return `<div class="price-line">
      <span class="price-line__label">${label}${badge}</span>
      <span class="price-line__value">${formatPrice(item.price)}</span>
    </div>`;
  }).join('');

  if (pricing.inspektionOverage && pricing.inspektionOverage.cost > 0) {
    const o = pricing.inspektionOverage;
    html += `<div class="price-line">
      <span class="price-line__label">Zusätzliche Arbeitszeit (${o.minutes} Min × ${o.rate} €/Min)</span>
      <span class="price-line__value">${formatPrice(o.cost)}</span>
    </div>`;
  }

  if (pricing.travelFee > 0) {
    html += `<div class="price-line">
      <span class="price-line__label">Anfahrtskosten</span>
      <span class="price-line__value">${formatPrice(pricing.travelFee)}</span>
    </div>`;
  }

  linesEl.innerHTML = html;
  if (totalEl) totalEl.textContent = formatPrice(pricing.total);
}

// ═══════════════════════════════════════════
// MONTH CALENDAR
// ═══════════════════════════════════════════

function getEterminServiceIds() {
  const services = BookingState.get('selectedServices') || [];
  let ids = services.map(s => s.eterminId).filter(Boolean);

  // Fallback: if eterminIds missing, try to enrich from catalogData
  if (ids.length === 0 && services.length > 0 && typeof catalogData !== 'undefined' && catalogData) {
    const enriched = services.map(s => {
      if (s.eterminId) return s;
      for (const b of catalogData.bereiche) {
        const match = b.leistungen.find(l => l.id === s.id);
        if (match?.eterminId) {
          s.eterminId = match.eterminId;
          break;
        }
      }
      return s;
    });
    BookingState.set('selectedServices', enriched);
    ids = enriched.map(s => s.eterminId).filter(Boolean);
  }

  return ids;
}

async function loadMonthAvailability() {
  const { year, month } = currentMonth;
  const m = month + 1;
  const calIds = getCalendarIds();
  // Slot-Engine plant mit der GEPUFFERTEN Dauer (Service + 15 Min), damit zwei
  // aufeinanderfolgende Termine im Kalender nicht überlappen.
  const pricing = BookingState.get('pricing');
  const duration = pricing?.appointmentDurationMinutes
                || pricing?.estimatedDurationMinutes
                || 60;
  const serviceIds = getEterminServiceIds();

  const grid = document.getElementById('month-grid');
  if (grid) grid.style.opacity = '0.5';

  try {
    let url = `${API_BASE}/api/etermin/availability?year=${year}&month=${m}&duration=${duration}`;
    if (calIds.length > 0)      url += `&eligibleCalendarIds=${calIds.join(',')}`;
    if (serviceIds.length > 0)  url += `&serviceIds=${serviceIds.join(',')}`;
    const res = await fetch(url);
    const data = await res.json();

    monthAvailability = {};
    if (Array.isArray(data)) {
      data.forEach(d => { monthAvailability[d.date] = d; });
    }
  } catch (err) {
    console.error('Availability load error:', err);
    monthAvailability = {};
  }

  if (grid) grid.style.opacity = '1';
  renderMonthCalendar();
}

/**
 * Load availability and auto-select the first available day.
 * If no available day in current month, search up to 3 months ahead.
 */
async function loadMonthAvailabilityAndAutoSelect(maxMonthsAhead = 3) {
  for (let attempt = 0; attempt <= maxMonthsAhead; attempt++) {
    await loadMonthAvailability();

    // Find first available day in this month
    const firstAvailable = Object.entries(monthAvailability)
      .sort(([a], [b]) => a.localeCompare(b))
      .find(([_, info]) => info.available);

    if (firstAvailable) {
      await selectCalDay(firstAvailable[0]);
      return;
    }

    // No available day — advance to next month
    if (attempt < maxMonthsAhead) {
      currentMonth.month++;
      if (currentMonth.month > 11) {
        currentMonth.month = 0;
        currentMonth.year++;
      }
      renderMonthCalendar();
      renderSlotsPlaceholder();
    }
  }
}

function renderMonthCalendar() {
  const grid = document.getElementById('month-grid');
  const label = document.getElementById('month-label');
  if (!grid) return;

  const { year, month } = currentMonth;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthNames = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
  ];

  if (label) label.textContent = `${monthNames[month]} ${year}`;

  // First day of month and total days
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const totalDays = lastDay.getDate();

  // Day of week for first day (0=Sun, convert to Mon=0)
  let startDow = firstDay.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1; // Mon=0, Tue=1 ... Sun=6

  let html = '';

  // Empty cells before first day
  for (let i = 0; i < startDow; i++) {
    html += '<span class="cal-day cal-day--empty"></span>';
  }

  // Day cells
  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(year, month, d);
    const dateStr = formatDateStr(date);
    const isPast = date < today;
    const isToday = date.getTime() === today.getTime();
    const isSelected = selectedDate && dateStr === formatDateStr(selectedDate);
    const avail = monthAvailability[dateStr];
    const hasSlots = avail ? avail.available : !isPast;
    const isDisabled = isPast || !hasSlots;

    let cls = 'cal-day';
    if (isSelected) {
      cls += ' cal-day--selected';
    } else if (isPast || !hasSlots) {
      cls += ' cal-day--past';
    } else if (isToday) {
      cls += ' cal-day--today cal-day--available';
    } else {
      cls += ' cal-day--available';
    }

    const clickAttr = isDisabled ? '' : `onclick="selectCalDay('${dateStr}')"`;

    html += `<button type="button" class="${cls}" data-date="${dateStr}" ${clickAttr}
                     ${isDisabled ? 'disabled' : ''} aria-label="${d}. ${monthNames[month]}${hasSlots ? '' : ' – nicht verfügbar'}">${d}</button>`;
  }

  grid.innerHTML = html;
}

async function changeMonth(offset) {
  currentMonth.month += offset;
  if (currentMonth.month < 0) {
    currentMonth.month = 11;
    currentMonth.year--;
  } else if (currentMonth.month > 11) {
    currentMonth.month = 0;
    currentMonth.year++;
  }

  // Don't allow navigating to past months
  const today = new Date();
  if (currentMonth.year < today.getFullYear() ||
      (currentMonth.year === today.getFullYear() && currentMonth.month < today.getMonth())) {
    currentMonth.year = today.getFullYear();
    currentMonth.month = today.getMonth();
  }

  selectedDate = null;
  monthAvailability = {};
  renderMonthCalendar();
  renderSlotsPlaceholder();
  await loadMonthAvailability();

  // Auto-select first available day in new month
  const firstAvailable = Object.entries(monthAvailability)
    .sort(([a], [b]) => a.localeCompare(b))
    .find(([_, info]) => info.available);
  if (firstAvailable) {
    await selectCalDay(firstAvailable[0]);
  }
}

async function selectCalDay(dateStr) {
  selectedDate = new Date(dateStr + 'T00:00:00');
  renderMonthCalendar();

  // Update date label
  const dateLabel = document.getElementById('slots-date-label');
  if (dateLabel) {
    dateLabel.textContent = selectedDate.toLocaleDateString('de-DE', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }

  await loadSlots(dateStr);
}

function formatDateStr(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Addiere Minuten zu einer "HH:MM"-Uhrzeit und gib das Ergebnis wieder
 * als "HH:MM" zurück (Stundenüberlauf wird korrekt behandelt).
 */
function addMinutesToHM(hm, minutes) {
  const [h, m] = (hm || '00:00').split(':').map(Number);
  const total = h * 60 + m + (Number(minutes) || 0);
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════
// SLOTS
// ═══════════════════════════════════════════

function renderSlotsPlaceholder() {
  const placeholder = document.getElementById('slots-placeholder');
  const slotsGrid = document.getElementById('slots-grid');
  const noSlots = document.getElementById('no-slots');
  const dateLabel = document.getElementById('slots-date-label');

  if (placeholder) placeholder.classList.remove('hidden');
  if (slotsGrid) slotsGrid.innerHTML = '';
  if (noSlots) noSlots.classList.add('hidden');
  if (dateLabel) dateLabel.textContent = 'Datum wählen';
}

async function loadSlots(dateStr) {
  const slotsGrid = document.getElementById('slots-grid');
  const loading = document.getElementById('slots-loading');
  const noSlots = document.getElementById('no-slots');
  const placeholder = document.getElementById('slots-placeholder');

  if (placeholder) placeholder.classList.add('hidden');
  if (loading) loading.classList.remove('hidden');
  if (slotsGrid) slotsGrid.innerHTML = '';
  if (noSlots) noSlots.classList.add('hidden');

  try {
    const pricing = BookingState.get('pricing');
    // Slot-Engine bekommt die GEPUFFERTE Dauer (Service + 15 Min Puffer).
    const duration = pricing?.appointmentDurationMinutes
                  || pricing?.estimatedDurationMinutes
                  || 60;
    // Kunde sieht in den Slot-Buttons aber die reine Service-End-Zeit.
    const serviceMin = pricing?.estimatedDurationMinutes || duration;
    const calIds = getCalendarIds();
    const serviceIds = getEterminServiceIds();
    let slotUrl = `${API_BASE}/api/etermin/slots?date=${dateStr}&duration=${duration}`;
    if (calIds.length > 0)      slotUrl += `&eligibleCalendarIds=${calIds.join(',')}`;
    if (serviceIds.length > 0)  slotUrl += `&serviceIds=${serviceIds.join(',')}`;
    const res = await fetch(slotUrl);
    const slots = await res.json();

    if (loading) loading.classList.add('hidden');

    if (!slots || slots.length === 0) {
      if (noSlots) noSlots.classList.remove('hidden');
      return;
    }

    // Pro Slot die `eligibleCalendarIds` als data-Attribut speichern, damit
    // selectSlot() sie in den BookingState übernehmen kann (Server pickt
    // beim Reservieren den least-busy aus diesem Set).
    // Im Button-Label zeigen wir die Service-End-Zeit (ohne Puffer),
    // im data-slot-end aber das gepufferte Ende (das eTermin reserviert).
    slotsGrid.innerHTML = slots.map(slot => {
      const cals = (slot.eligibleCalendarIds || []).join(',');
      const displayEnd = addMinutesToHM(slot.start, serviceMin);
      return `<button type="button" class="slot-btn" data-slot-start="${slot.start}" data-slot-end="${slot.end}"
               data-eligible-cals="${cals}"
               onclick="selectSlot(this, '${slot.start}', '${slot.end}')">
        ${slot.start} – ${displayEnd}
      </button>`;
    }).join('');
  } catch (err) {
    console.error('Slots error:', err);
    if (loading) loading.classList.add('hidden');
    if (noSlots) {
      noSlots.textContent = 'Fehler beim Laden der Termine.';
      noSlots.classList.remove('hidden');
    }
  }
}

/**
 * Reserve the chosen slot in eTermin (appattrib=0, sync=0) and advance.
 * If we already hold a reservation for a *different* slot, release it first.
 * If the same slot is already reserved, skip and advance.
 */
async function confirmSlotAndAdvance() {
  const slot = BookingState.get('selectedSlot');
  if (!slot) {
    if (typeof flowFlashError === 'function') flowFlashError('Bitte wähle einen Termin.');
    return;
  }

  const existing = BookingState.get('reservation');
  // sameSlot: gleicher Slot, Reservation noch gültig. calendarId der Reservation
  // muss in den jetzigen eligibleCalendarIds enthalten sein (sonst hat sich
  // die Eligible-Liste geändert, z.B. weil zwischenzeitlich ein Cal deaktiviert
  // wurde — dann lieber neu reservieren).
  const eligible = slot.eligibleCalendarIds || [];
  const sameSlot = existing?.slot
    && existing.slot.date === slot.date
    && existing.slot.start === slot.start
    && eligible.includes(Number(existing.slot.calendarId))
    && new Date(existing.expiresAt) > new Date();

  if (sameSlot) {
    flowNext();
    return;
  }

  const btn = document.getElementById('btn-slot-next');
  const originalLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Reserviere…'; }

  // Release stale reservation in the background — failure is non-fatal.
  if (existing?.id) {
    fetch(API_BASE + '/api/booking/release-slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationId: existing.id })
    }).catch(() => {});
    BookingState.set('reservation', null);
  }

  try {
    const services = BookingState.get('selectedServices') || [];
    const serviceIds = [...new Set(services.map(s => s.eterminId).filter(Boolean))];
    // Geo-Eligible mit Fahrtzeiten mitschicken — Server nutzt das als Tie-Breaker.
    const geoEligible = BookingState.get('geoResult')?.eligible || null;
    const res = await fetch(API_BASE + '/api/booking/reserve-slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot,
        serviceIds,
        locationType: BookingState.get('locationType'),
        address: BookingState.get('address'),
        geoEligible
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Reservierung fehlgeschlagen.');
    }
    // Server-pickter Kalender in den BookingState übernehmen.
    BookingState.set('reservation', {
      id: data.reservationId,
      expiresAt: data.expiresAt,
      slot: { ...slot, calendarId: data.calendarId }
    });
    flowNext();
  } catch (err) {
    console.error('reserve-slot error:', err);
    if (typeof flowFlashError === 'function') {
      flowFlashError(err.message || 'Termin konnte nicht reserviert werden.');
    }
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || 'Weiter'; }
  }
}
window.confirmSlotAndAdvance = confirmSlotAndAdvance;

function selectSlot(el, start, end) {
  document.querySelectorAll('.slot-btn').forEach(btn => btn.classList.remove('selected'));
  el.classList.add('selected');

  const label = `${selectedDate.toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
  })} um ${start} Uhr`;

  // Eligible-Cal-IDs aus dem data-Attribut (vom Server pro Slot mitgegeben).
  // Fallback auf getCalendarIds() falls Attribut fehlt (z.B. Mock-Pfad).
  const elig = (el?.dataset?.eligibleCals || '')
    .split(',').map(s => Number(s.trim())).filter(Boolean);
  const eligibleCalendarIds = elig.length > 0 ? elig : getCalendarIds();

  BookingState.set('selectedSlot', {
    start, end,
    date: formatDateStr(selectedDate),
    label,
    eligibleCalendarIds
  });

  // Enable slot-next button
  const btn = document.getElementById('btn-slot-next');
  if (btn) {
    btn.disabled = false;
    btn.classList.add('pulse');
  }
}

// ═══════════════════════════════════════════
// BOOKING CONFIRM
// ═══════════════════════════════════════════

/**
 * Send the booking to the server (eTermin + Airtable).
 * Called from payment.js immediately after a successful PayPal capture.
 *   - On success: snapshots booking details into state, advances flow to the
 *     confirmation screen and resets the booking state.
 *   - On failure: throws so the caller can show a retry button.
 */
async function confirmBooking() {
  const state = BookingState.toJSON();
  if (typeof window.getAnalyticsSessionId === 'function') {
    state.sessionId = window.getAnalyticsSessionId();
  }

  const res = await fetch(API_BASE + '/api/booking/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  });
  const result = await res.json();

  if (!result.success) {
    throw new Error(result.error || 'Buchung fehlgeschlagen.');
  }

  // Snapshot the booking details (still useful for analytics or fallback screen).
  const slot = BookingState.get('selectedSlot');
  BookingState.set('bookingResult', {
    bookingId:    result.bookingId,
    slotLabel:    slot?.label || '',
    totalPrice:   BookingState.get('pricing')?.total,
    customerEmail: BookingState.get('customer')?.email
  });

  // Redirect to the dedicated "Danke"-page instead of the in-app confirmation
  // screen. When embedded in an iframe, ask the parent to navigate the top
  // window via the iframe-bridge — otherwise the redirect would only affect
  // the iframe itself.
  const THANKYOU_URL = 'https://radblitz.de/danke/';
  const inIframe = window.parent !== window;
  if (inIframe) {
    try {
      window.parent.postMessage(
        { source: 'spoxhub-booking', type: 'redirect-top', url: THANKYOU_URL },
        '*'
      );
    } catch (_) { /* ignore */ }
    // Safety net: if the parent doesn't navigate within 1s, try to redirect
    // the top window directly (works for same-origin iframes).
    setTimeout(() => {
      try { window.top.location.href = THANKYOU_URL; } catch (_) { /* cross-origin: parent should have handled it */ }
    }, 1000);
  } else {
    window.location.href = THANKYOU_URL;
  }

  return result;
}
window.confirmBooking = confirmBooking;

// Exposed for flow.js onEnter hooks
async function onEnterSlotSelect() {
  await initBookingStep();
}

function onEnterConfirmation() {
  renderConfirmationSummary();
  // Now that everything is rendered, clear the in-memory booking state.
  setTimeout(() => BookingState.reset(), 200);
}

function renderConfirmationSummary() {
  const loc = BookingState.get('locationType');
  const address = BookingState.get('address');
  const slot = BookingState.get('selectedSlot');
  const result = BookingState.get('bookingResult') || {};
  const customer = BookingState.get('customer') || {};

  // Slot
  const slotEl = document.getElementById('summary-slot-text');
  if (slotEl) slotEl.textContent = result.slotLabel || slot?.label || '–';

  // Location
  const locEl = document.getElementById('summary-location-text');
  if (locEl) {
    if (loc === 'werkstatt') {
      locEl.textContent = 'In unserer Werkstatt (Lerchenstraße 16, 22767 Hamburg)';
    } else if (address) {
      locEl.textContent = `Mobiler Service — ${address}`;
    } else {
      locEl.textContent = '–';
    }
  }

  // Booking-ID
  const idEl = document.getElementById('summary-bookingid-text');
  const idRow = document.getElementById('summary-bookingid-row');
  if (result.bookingId) {
    if (idEl) idEl.textContent = result.bookingId;
  } else if (idRow) {
    idRow.classList.add('hidden');
  }

  // Email confirmation hint
  const emailEl = document.getElementById('confirmation-email-text');
  const email = result.customerEmail || customer.email;
  if (emailEl && email) {
    emailEl.innerHTML = `Wir haben dir eine Bestätigung an <strong>${email}</strong> geschickt.`;
  }
}
