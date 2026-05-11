/**
 * Catalog — Integration mit Flow (eine Frage pro Screen).
 * Rendert Inspektions-Auswahl, Reparatur-Akkordeon und reagiert auf Flow-Hooks.
 */

let catalogData = null;

// ═══════════════════════════════════════════
// Flow-Choice-Handler (auto-advance)
// ═══════════════════════════════════════════

async function chooseServiceType(type) {
  BookingState.set('serviceType', type);

  if (type === 'inspektion') {
    // Reset repair-related flags
    BookingState.set('knowWhat', null);
    BookingState.set('needMore', null);

    // Auto-select the (single) inspektion matching the chosen vehicle type
    if (!catalogData) await loadCatalog();
    const bereich = catalogData?.bereiche.find(b => b.id === 'inspektion');
    const leistung = bereich?.leistungen[0];
    if (leistung) {
      const services = BookingState.get('selectedServices').filter(s => s.bereich !== 'Inspektion');
      services.push({
        id: leistung.id,
        name: leistung.name,
        bereich: 'Inspektion',
        price: leistung.price,
        duration: leistung.duration,
        eterminId: leistung.eterminId || null
      });
      BookingState.set('selectedServices', services);
      recalculatePricing();
    }
  } else {
    BookingState.set('inspektionAddRepair', null);
  }

  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function chooseInspektionAdditional(yes) {
  BookingState.set('inspektionAddRepair', yes);
  if (!yes) {
    // Reset repair state when user says "no"
    BookingState.set('knowWhat', null);
    BookingState.set('needMore', null);
  }
  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function chooseKnowWhat(yes) {
  BookingState.set('knowWhat', yes);
  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function chooseNeedMore(yes) {
  BookingState.set('needMore', yes);
  if (yes) {
    // Back to catalog — use flowBack so history is preserved? Actually we want to GO to repair-catalog.
    // Since repair-catalog comes before repair-more in the flow, "Yes" means: reset needMore and go back.
    setTimeout(() => {
      BookingState.set('needMore', null);
      flowBack();
    }, 220);
  } else {
    if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
  }
}

// ═══════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════

function renderInspektionOptions() {
  if (!catalogData) return;
  const container = document.getElementById('inspektion-options');
  if (!container) return;

  const bereich = catalogData.bereiche.find(b => b.id === 'inspektion');
  if (!bereich) return;

  container.innerHTML = bereich.leistungen.map(l => {
    const descHtml = l.description
      ? `<div class="svc-card__tooltip">${l.description}</div>`
      : '';
    return `<div class="svc-card" data-leistung="${l.id}" onclick="pickInspektion('${l.id}')">
      <div class="svc-card__header">
        <span class="svc-card__name">${l.name}</span>
        <span class="svc-card__price">${formatLeistungPrice(l.priceWork ?? l.price)} €</span>
      </div>
      <div class="svc-card__meta">${l.duration} Minuten${l.materialkosten ? ` · zzgl. ca. ${formatLeistungPrice(l.materialkosten)} € Material` : ''}</div>
      ${descHtml}
    </div>`;
  }).join('');
}

function pickInspektion(leistungId) {
  const bereich = catalogData.bereiche.find(b => b.id === 'inspektion');
  const leistung = bereich?.leistungen.find(l => l.id === leistungId);
  if (!leistung) return;

  // Replace any previously selected inspektion
  const services = BookingState.get('selectedServices').filter(s => s.bereich !== 'Inspektion');
  services.push({
    id: leistung.id,
    name: leistung.name,
    bereich: 'Inspektion',
    price: leistung.price,
    duration: leistung.duration,
    eterminId: leistung.eterminId || null
  });
  BookingState.set('selectedServices', services);
  recalculatePricing();

  document.querySelectorAll('#inspektion-options .svc-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.leistung === leistungId);
  });

  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function renderAccordion() {
  const container = document.getElementById('repair-accordion');
  if (!container || !catalogData) return;

  const repairBereiche = catalogData.bereiche.filter(b => b.id !== 'inspektion');
  const selectedServices = BookingState.get('selectedServices') || [];

  container.innerHTML = repairBereiche.map(b => {
    const leistungenHtml = b.leistungen.map(l => {
      const selectedItem = selectedServices.find(s => s.id === l.id);
      const isSelected = !!selectedItem;
      const qty = selectedItem?.quantity || 0;
      const maxQty = l.maxQuantity || 1;
      const hasQtyChoice = maxQty > 1;
      // Card zeigt nur Arbeitskosten — Material extra in der Meta
      const previewQty = Math.max(1, qty);
      const workPrice = calcLineWork(l, previewQty);
      const displayPrice = formatLeistungPrice(workPrice);
      const totalMaterial = (l.priceMaterial || 0) * previewQty;
      const materialHint = totalMaterial > 0
        ? ` · zzgl. ca. ${formatLeistungPrice(totalMaterial)} € Material`
        : '';
      const descHtml = l.description
        ? `<div class="svc-card__tooltip">${l.description}</div>`
        : '';

      // For services with maxQuantity > 1: always visible stepper, card-click does NOT toggle
      // For services with maxQuantity = 1: card is clickable to toggle
      const stepperHtml = hasQtyChoice ? `
        <div class="qty-stepper" onclick="event.stopPropagation()">
          <span class="qty-stepper__label">Anzahl:</span>
          <button type="button" class="qty-stepper__btn" onclick="changeQty('${l.id}', -1)" ${qty <= 0 ? 'disabled' : ''} aria-label="Weniger">−</button>
          <span class="qty-stepper__value">${qty}</span>
          <button type="button" class="qty-stepper__btn" onclick="changeQty('${l.id}', 1)" ${qty >= maxQty ? 'disabled' : ''} aria-label="Mehr">+</button>
          <span class="qty-stepper__max">von ${maxQty}</span>
        </div>` : '';

      const cardOnClick = hasQtyChoice ? '' : `onclick="toggleLeistung('${l.id}')"`;

      return `<div class="svc-card ${isSelected ? 'selected' : ''} ${hasQtyChoice ? 'svc-card--with-qty' : ''}"
                   data-leistung="${l.id}" data-max-qty="${maxQty}"
                   ${cardOnClick}>
        <div class="svc-card__header">
          <span class="svc-card__name">${l.name}</span>
          <span class="svc-card__price">${displayPrice} €</span>
        </div>
        <div class="svc-card__meta">${l.duration} Minuten${materialHint}</div>
        ${descHtml}
        ${stepperHtml}
      </div>`;
    }).join('');

    return `<div class="accordion-item">
      <button type="button" class="accordion-header"
              onclick="toggleAccordion(this)">
        <span>${b.name}</span>
        <svg class="accordion-chevron" xmlns="http://www.w3.org/2000/svg" width="20" height="20"
             viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      <div class="accordion-body hidden">
        <div class="grid grid-cols-1 gap-3">
          ${leistungenHtml}
        </div>
      </div>
    </div>`;
  }).join('');

  updateRepairNextButton();
}

function toggleAccordion(header) {
  const isOpen = header.classList.contains('open');

  // Alle anderen schließen
  document.querySelectorAll('.accordion-header.open').forEach(h => {
    if (h !== header) {
      h.classList.remove('open');
      h.nextElementSibling?.classList.add('hidden');
    }
  });

  header.classList.toggle('open', !isOpen);
  header.nextElementSibling?.classList.toggle('hidden', isOpen);

  if (!isOpen) {
    setTimeout(() => header.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  }
}

function toggleLeistung(leistungId) {
  const selected = [...BookingState.get('selectedServices')];
  const idx = selected.findIndex(s => s.id === leistungId);

  if (idx > -1) {
    // Remove completely
    selected.splice(idx, 1);
  } else {
    const leistung = findLeistungInCatalog(leistungId);
    if (leistung) {
      selected.push({
        id: leistung.id,
        name: leistung.name,
        bereich: leistung.bereich,
        price: calcLineTotal(leistung, 1),       // line total
        unitPrice: leistung.price,
        duration: calcLineDuration(leistung, 1), // line duration
        quantity: 1,
        maxQuantity: leistung.maxQuantity || 1,
        eterminId: leistung.eterminId || null
      });
    }
  }

  BookingState.set('selectedServices', selected);
  updateCardUI(leistungId);
  recalculatePricing();
  updateRepairNextButton();
}

function updateCardUI(leistungId) {
  const card = document.querySelector(`.svc-card[data-leistung="${leistungId}"]`);
  if (!card) return;

  const selected = BookingState.get('selectedServices') || [];
  const item = selected.find(s => s.id === leistungId);
  const qty = item?.quantity || 0;
  const maxQty = parseInt(card.dataset.maxQty || '1', 10);
  const leistung = findLeistungInCatalog(leistungId);

  card.classList.toggle('selected', qty > 0);

  // Update price + meta display using marginal calculation
  if (leistung) {
    const previewQty = Math.max(1, qty);
    const workPrice     = calcLineWork(leistung, previewQty);
    const totalDuration = calcLineDuration(leistung, previewQty);

    const priceEl = card.querySelector('.svc-card__price');
    if (priceEl) priceEl.textContent = formatLeistungPrice(workPrice) + ' €';

    const metaEl = card.querySelector('.svc-card__meta');
    if (metaEl) {
      const totalMaterial = (leistung.priceMaterial || 0) * previewQty;
      const materialPart = totalMaterial > 0 ? ` · zzgl. ca. ${formatLeistungPrice(totalMaterial)} € Material` : '';
      metaEl.textContent = ''; // clear before set
      metaEl.innerHTML = `${totalDuration} Minuten${materialPart}`;
    }
  }

  // Update stepper state (only present on maxQty > 1 cards)
  const stepper = card.querySelector('.qty-stepper');
  if (stepper) {
    const val = stepper.querySelector('.qty-stepper__value');
    const btns = stepper.querySelectorAll('.qty-stepper__btn');
    if (val) val.textContent = qty;
    if (btns[0]) btns[0].disabled = qty <= 0;
    if (btns[1]) btns[1].disabled = qty >= maxQty;
  }
}

function findLeistungInCatalog(leistungId) {
  if (!catalogData) return null;
  for (const b of catalogData.bereiche) {
    const match = b.leistungen.find(l => l.id === leistungId);
    if (match) return match;
  }
  return null;
}

/**
 * Compute total line price for a service at a given quantity, using marginal
 * pricing if the service has addPrice/addDuration set.
 *   work_total = priceWork + (qty - 1) × (addPrice ?? priceWork)
 *   material_total = priceMaterial × qty
 *   line_total = work_total + material_total
 */
function calcLineTotal(leistung, qty) {
  const q = Math.max(1, qty || 1);
  const work     = leistung.priceWork     || 0;
  const addPrice = leistung.addPrice     != null ? leistung.addPrice : work;
  const material = (leistung.priceMaterial || 0) * q;
  return work + (q - 1) * addPrice + material;
}

/** Work-only (no material) for display on catalog cards */
function calcLineWork(leistung, qty) {
  const q = Math.max(1, qty || 1);
  const work     = leistung.priceWork || 0;
  const addPrice = leistung.addPrice != null ? leistung.addPrice : work;
  return work + (q - 1) * addPrice;
}

function calcLineDuration(leistung, qty) {
  const q = Math.max(1, qty || 1);
  const baseDuration = leistung.duration || 0;
  const addDuration  = leistung.addDuration != null ? leistung.addDuration : baseDuration;
  return baseDuration + (q - 1) * addDuration;
}

function changeQty(leistungId, delta) {
  const selected = [...(BookingState.get('selectedServices') || [])];
  const idx = selected.findIndex(s => s.id === leistungId);
  const leistung = findLeistungInCatalog(leistungId);

  if (idx < 0) {
    if (delta <= 0 || !leistung) return;
    selected.push({
      id: leistung.id,
      name: leistung.name,
      bereich: leistung.bereich,
      price: calcLineTotal(leistung, 1),
      unitPrice: leistung.price,
      duration: calcLineDuration(leistung, 1),
      quantity: 1,
      maxQuantity: leistung.maxQuantity || 1,
      eterminId: leistung.eterminId || null
    });
  } else {
    const item = { ...selected[idx] };
    const maxQty = item.maxQuantity || 1;
    const newQty = (item.quantity || 1) + delta;

    if (newQty < 1) {
      selected.splice(idx, 1);
    } else {
      item.quantity = Math.min(maxQty, newQty);
      if (leistung) {
        item.price    = calcLineTotal(leistung, item.quantity);
        item.duration = calcLineDuration(leistung, item.quantity);
      }
      selected[idx] = item;
    }
  }

  BookingState.set('selectedServices', selected);
  updateCardUI(leistungId);
  recalculatePricing();
  updateRepairNextButton();
}

function updateRepairNextButton() {
  const btn = document.getElementById('btn-repair-next');
  if (!btn) return;
  const hasRepair = (BookingState.get('selectedServices') || [])
    .some(s => s.bereich !== 'Inspektion');
  btn.disabled = !hasRepair;
  btn.classList.toggle('pulse', hasRepair);
}

// ═══════════════════════════════════════════
// PRICING
// ═══════════════════════════════════════════

function formatLeistungPrice(price) {
  return price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function recalculatePricing() {
  const services = BookingState.get('selectedServices');
  if (services.length === 0) {
    BookingState.set('pricing', null);
    return;
  }

  const quantities = services.reduce((acc, s) => {
    acc[s.id] = s.quantity || 1;
    return acc;
  }, {});
  const payload = {
    serviceIds: services.map(s => s.id),
    quantities,
    vehicleType: BookingState.get('vehicleType') || 'ebike',
    bidexClass: BookingState.get('bidexClass'),
    locationType: BookingState.get('locationType'),
    travelTimeMinutes: BookingState.get('geoResult')?.travelTimeMinutes
  };
  console.log('[pricing] request →', payload);

  try {
    const res = await fetch(API_BASE + '/api/pricing/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const pricing = await res.json();
    console.log('[pricing] response ←', pricing);
    BookingState.set('pricing', pricing);

    // Race-condition guard: merge server response against the CURRENT state.
    // Items that were removed by the user between request and response stay
    // removed — we only update prices/duration on items still in cart.
    const current = BookingState.get('selectedServices') || [];
    const byId = new Map(pricing.lineItems.map(i => [i.id, i]));
    const updated = current.map(s => {
      const item = byId.get(s.id);
      if (!item) return s; // server didn't price it (race): keep as-is
      return {
        ...s,
        price: item.price,
        unitPrice: item.unitPrice ?? s.unitPrice,
        duration: item.duration,
        quantity: item.quantity || s.quantity || 1,
        maxQuantity: item.maxQuantity || s.maxQuantity || 1,
        eterminId: item.eterminId || s.eterminId || null,
        includedInInspektion: !!item.includedInInspektion
      };
    });
    BookingState.set('selectedServices', updated);
  } catch (err) {
    console.error('Pricing error:', err);
  }
}

// ═══════════════════════════════════════════
// CATALOG LOADING
// ═══════════════════════════════════════════

async function loadCatalog() {
  const vehicleType = BookingState.get('vehicleType') || 'ebike';
  try {
    const res = await fetch(`${API_BASE}/api/catalog/${vehicleType}`);
    catalogData = await res.json();
  } catch (err) {
    console.error('Catalog load error:', err);
  }
}

// Remove a service from the cart (called from sidebar summary)
function removeService(serviceId) {
  const services = BookingState.get('selectedServices').filter(s => s.id !== serviceId);
  BookingState.set('selectedServices', services);
  recalculatePricing();
  document.querySelectorAll('.svc-card').forEach(card => {
    if (card.dataset.leistung === serviceId) card.classList.remove('selected');
  });
  if (typeof updateRepairNextButton === 'function') updateRepairNextButton();
}

// Hooks für flow.js — werden beim Eintritt in die jeweiligen Screens aufgerufen.
// Registriere sie, indem flow.js die onEnter-Namen hier findet.
async function onEnterInspektionSelect() {
  if (!catalogData) await loadCatalog();
  renderInspektionOptions();
}

async function onEnterRepairCatalog() {
  if (!catalogData) await loadCatalog();
  renderAccordion();
}

// Reload catalog when vehicleType changes
BookingState.subscribe((key) => {
  if (key === 'vehicleType') {
    BookingState.set('selectedServices', []);
    BookingState.set('pricing', null);
    loadCatalog();
  }
});

// Recalculate pricing when location or address verification changes,
// if services are already selected.
BookingState.subscribe((key) => {
  if ((key === 'locationType' || key === 'geoResult') &&
      (BookingState.get('selectedServices') || []).length > 0) {
    recalculatePricing();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  loadCatalog();
});
