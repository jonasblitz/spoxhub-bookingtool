/**
 * Sidebar Updater — Reaktive Sidebar basierend auf BookingState
 */

function formatPrice(cents) {
  return (cents || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatDuration(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return `ca. ${minutes} Min.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `ca. ${h} Std. ${m} Min.` : `ca. ${h} Std.`;
}

function updateSidebar() {
  const state = BookingState.getAll();

  // Location
  const sbLoc = document.getElementById('sb-location');
  const sbLocText = document.getElementById('sb-location-text');
  if (sbLoc && sbLocText) {
    if (state.locationType) {
      sbLoc.classList.remove('hidden');
      const labels = { mobil: 'Mobil – Zu dir nach Hause', anderer_ort: 'Mobil – Andere Adresse', werkstatt: 'In der Werkstatt' };
      sbLocText.textContent = labels[state.locationType] || state.locationType;
      if (state.address && state.locationType !== 'werkstatt') {
        sbLocText.textContent += ` (${state.address})`;
      }
    } else {
      sbLoc.classList.add('hidden');
    }
  }

  // Vehicle
  const sbVeh = document.getElementById('sb-vehicle');
  const sbVehText = document.getElementById('sb-vehicle-text');
  if (sbVeh && sbVehText) {
    if (state.vehicleType) {
      sbVeh.classList.remove('hidden');
      sbVehText.textContent = state.vehicleType === 'ebike' ? 'E-Bike' : 'Cargobike';
    } else {
      sbVeh.classList.add('hidden');
    }
  }

  // Services
  const sbServices = document.getElementById('sb-services');
  if (sbServices) {
    if (state.selectedServices.length === 0) {
      sbServices.innerHTML = '<p class="text-text-muted text-sm italic">Noch keine Leistung gewählt</p>';
    } else {
      sbServices.innerHTML = state.selectedServices.map(s => {
        const qty = s.quantity || 1;
        const lineTotal = s.price || 0; // already line total
        const label = qty > 1 ? `${qty} × ${s.name}` : s.name;
        const inspBadge = s.includedInInspektion
          ? `<span class="text-xs text-neon-lime block ml-3.5">inkl. Inspektion</span>`
          : '';
        return `<div class="flex items-start justify-between text-sm group py-1">
          <span class="flex flex-col gap-0.5 text-white flex-1 min-w-0">
            <span class="flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full bg-neon-lime flex-shrink-0"></span>
              <span class="truncate">${label}</span>
            </span>
            ${inspBadge}
          </span>
          <span class="text-text-secondary whitespace-nowrap ml-2">${formatPrice(lineTotal)}</span>
          <button type="button" onclick="removeService('${s.id}')"
                  class="ml-2 text-purple-400 hover:text-state-danger transition-colors flex-shrink-0 opacity-60 hover:opacity-100"
                  aria-label="${s.name} entfernen" title="Entfernen">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
      }).join('');

      // Inspektion-Overage line
      const overage = state.pricing?.inspektionOverage;
      if (overage && overage.cost > 0) {
        sbServices.innerHTML += `<div class="flex items-start justify-between text-sm py-1 border-t border-purple-700/40 mt-2 pt-2">
          <span class="flex flex-col gap-0.5 text-white flex-1 min-w-0">
            <span class="flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full bg-neon-lime flex-shrink-0"></span>
              <span>Zusätzliche Arbeitszeit</span>
            </span>
            <span class="text-xs text-text-muted ml-3.5">${overage.minutes} Min × ${overage.rate} €/Min (über Inspektions-Bonus)</span>
          </span>
          <span class="text-text-secondary whitespace-nowrap ml-2">${formatPrice(overage.cost)}</span>
        </div>`;
      }
    }
  }

  // Duration
  const sbDur = document.getElementById('sb-duration');
  const sbDurText = document.getElementById('sb-duration-text');
  if (sbDur && sbDurText && state.pricing) {
    sbDur.classList.remove('hidden');
    sbDurText.textContent = formatDuration(state.pricing.estimatedDurationMinutes);
  }

  // Travel fee
  const sbTravel = document.getElementById('sb-travel');
  const sbTravelText = document.getElementById('sb-travel-text');
  if (sbTravel && sbTravelText) {
    if (state.locationType === 'werkstatt') {
      sbTravel.classList.remove('hidden');
      sbTravelText.textContent = 'Keine Anfahrt';
    } else if (state.geoResult && state.geoResult.reachable) {
      sbTravel.classList.remove('hidden');
      const fee = state.pricing?.travelFee ?? state.geoResult.travelFee ?? 0;
      sbTravelText.textContent = fee > 0 ? formatPrice(fee) : 'Kostenlos';
    } else {
      sbTravel.classList.add('hidden');
    }
  }

  // Effective travel fee (even before pricing is calculated)
  const effectiveTravelFee =
    state.locationType === 'werkstatt' ? 0 :
    (state.pricing?.travelFee ?? state.geoResult?.travelFee ?? 0);

  // Total — use pricing total if available, else subtotal (services) + travel fee
  const servicesSubtotal = (state.selectedServices || [])
    .reduce((sum, s) => sum + (s.price || 0), 0);
  const total = state.pricing?.total ?? (servicesSubtotal + effectiveTravelFee);

  const sbTotal = document.getElementById('sb-total');
  const sbTotalMobile = document.getElementById('sb-total-mobile');
  if (sbTotal) sbTotal.textContent = formatPrice(total);
  if (sbTotalMobile) sbTotalMobile.textContent = formatPrice(total);

  // Slot
  const sbSlot = document.getElementById('sb-slot');
  const sbSlotText = document.getElementById('sb-slot-text');
  if (sbSlot && sbSlotText) {
    if (state.selectedSlot) {
      sbSlot.classList.remove('hidden');
      sbSlotText.textContent = state.selectedSlot.label || state.selectedSlot.start;
    } else {
      sbSlot.classList.add('hidden');
    }
  }

  // Update mobile drawer content
  updateMobileDrawer(state);
}

function updateMobileDrawer(state) {
  const container = document.getElementById('sb-mobile-content');
  if (!container) return;

  let html = '';

  if (state.locationType) {
    const labels = { mobil: 'Mobil', anderer_ort: 'Andere Adresse', werkstatt: 'Werkstatt' };
    html += `<div class="flex justify-between text-sm"><span class="text-text-secondary">Standort</span><span class="text-white">${labels[state.locationType]}</span></div>`;
  }

  if (state.vehicleType) {
    html += `<div class="flex justify-between text-sm"><span class="text-text-secondary">Fahrzeug</span><span class="text-white">${state.vehicleType === 'ebike' ? 'E-Bike' : 'Cargobike'}</span></div>`;
  }

  if (state.selectedServices.length > 0) {
    html += '<div class="border-t border-purple-600 pt-3 mt-2 space-y-1">';
    state.selectedServices.forEach(s => {
      const qty = s.quantity || 1;
      const lineTotal = s.price || 0;
      const label = qty > 1 ? `${qty} × ${s.name}` : s.name;
      const inspBadge = s.includedInInspektion
        ? `<div class="text-xs text-neon-lime ml-3.5">inkl. Inspektion</div>`
        : '';
      html += `<div class="text-sm py-1">
        <div class="flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-neon-lime flex-shrink-0"></span>
          <span class="text-white flex-1 min-w-0 truncate">${label}</span>
          <span class="text-text-secondary whitespace-nowrap">${formatPrice(lineTotal)}</span>
          <button type="button" onclick="removeService('${s.id}')"
                  class="text-purple-400 hover:text-state-danger transition-colors flex-shrink-0 p-1 -m-1"
                  aria-label="${s.name} entfernen" title="Entfernen">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        ${inspBadge}
      </div>`;
    });
    // Inspektion-Overage in mobile drawer
    const overage = state.pricing?.inspektionOverage;
    if (overage && overage.cost > 0) {
      html += `<div class="text-sm py-1 border-t border-purple-700/40 mt-2 pt-2">
        <div class="flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-neon-lime flex-shrink-0"></span>
          <span class="text-white flex-1 min-w-0">Zusätzliche Arbeitszeit</span>
          <span class="text-text-secondary whitespace-nowrap">${formatPrice(overage.cost)}</span>
        </div>
        <div class="text-xs text-text-muted ml-3.5">${overage.minutes} Min × ${overage.rate} €/Min (über Inspektions-Bonus)</div>
      </div>`;
    }
    html += '</div>';
  }

  // Show travel fee as soon as we know it (werkstatt or reachable geo)
  const mobileTravelFee =
    state.locationType === 'werkstatt' ? 0 :
    (state.pricing?.travelFee ?? state.geoResult?.travelFee ?? null);

  if (mobileTravelFee !== null) {
    html += `<div class="border-t border-purple-600 pt-2 mt-2">`;
    html += `<div class="flex justify-between text-sm">
      <span class="text-text-secondary">Anfahrt</span>
      <span class="text-white">${mobileTravelFee > 0 ? formatPrice(mobileTravelFee) : 'Kostenlos'}</span>
    </div>`;

    const servicesSubtotal = (state.selectedServices || [])
      .reduce((sum, s) => sum + (s.price || 0), 0);
    const total = state.pricing?.total ?? (servicesSubtotal + mobileTravelFee);

    if (total > 0) {
      html += `<div class="flex justify-between text-lg font-bold mt-2">
        <span class="text-white">Gesamt</span>
        <span class="text-neon-lime">${formatPrice(total)}</span>
      </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html || '<p class="text-text-muted text-sm italic">Noch nichts ausgewählt</p>';
}

// Mobile drawer toggle
function toggleMobileDrawer() {
  document.getElementById('mobile-drawer')?.classList.toggle('hidden');
}

function closeMobileDrawer(event) {
  if (event.target.id === 'mobile-drawer') {
    document.getElementById('mobile-drawer')?.classList.add('hidden');
  }
}

// Swipe-down-to-close gesture for mobile drawer
(function setupDrawerGestures() {
  document.addEventListener('DOMContentLoaded', () => {
    const drawer = document.getElementById('mobile-drawer');
    const sheet = drawer?.querySelector('.mobile-drawer__sheet');
    if (!drawer || !sheet) return;

    const CLOSE_THRESHOLD = 90; // px
    const VELOCITY_THRESHOLD = 0.5; // px/ms
    let startY = 0;
    let lastY = 0;
    let startTime = 0;
    let dragging = false;
    let touchStartScrollTop = 0;

    function onTouchStart(e) {
      startY = e.touches[0].clientY;
      lastY = startY;
      startTime = Date.now();
      touchStartScrollTop = sheet.scrollTop;
      dragging = false;
    }

    function onTouchMove(e) {
      const y = e.touches[0].clientY;
      const delta = y - startY;
      // Start dragging only if pulling down from top of sheet
      if (!dragging && delta > 6 && touchStartScrollTop === 0) {
        dragging = true;
        sheet.style.transition = 'none';
      }
      if (dragging) {
        lastY = y;
        const translate = Math.max(0, y - startY);
        sheet.style.transform = `translateY(${translate}px)`;
        // Dim backdrop proportionally
        const sheetHeight = sheet.offsetHeight || 1;
        const progress = Math.min(1, translate / sheetHeight);
        drawer.style.backgroundColor = `rgba(0, 0, 0, ${0.6 * (1 - progress)})`;
      }
    }

    function onTouchEnd() {
      if (!dragging) return;
      dragging = false;
      const delta = lastY - startY;
      const velocity = delta / Math.max(1, Date.now() - startTime);
      sheet.style.transition = 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)';

      if (delta > CLOSE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
        // Close
        sheet.style.transform = 'translateY(100%)';
        drawer.style.transition = 'background-color 240ms ease';
        drawer.style.backgroundColor = 'rgba(0, 0, 0, 0)';
        setTimeout(() => {
          drawer.classList.add('hidden');
          sheet.style.transition = '';
          sheet.style.transform = '';
          drawer.style.transition = '';
          drawer.style.backgroundColor = '';
        }, 260);
      } else {
        // Snap back
        sheet.style.transform = 'translateY(0)';
        drawer.style.transition = 'background-color 180ms ease';
        drawer.style.backgroundColor = '';
        setTimeout(() => {
          sheet.style.transition = '';
          drawer.style.transition = '';
        }, 260);
      }
    }

    sheet.addEventListener('touchstart', onTouchStart, { passive: true });
    sheet.addEventListener('touchmove', onTouchMove, { passive: true });
    sheet.addEventListener('touchend', onTouchEnd);
    sheet.addEventListener('touchcancel', onTouchEnd);
  });
})();

// Subscribe to all state changes
BookingState.subscribe(() => updateSidebar());

// Initial render
document.addEventListener('DOMContentLoaded', () => updateSidebar());
