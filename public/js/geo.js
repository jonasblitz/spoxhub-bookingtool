/**
 * Geo — Location-Auswahl + Geofencing (TravelTime)
 */

function selectLocation(el) {
  const locationType = el.dataset.location;

  // Update cards
  document.querySelectorAll('.location-card').forEach(card => {
    card.classList.toggle('active', card.dataset.location === locationType);
  });

  BookingState.set('locationType', locationType);

  // Show/hide address input
  const addressSection = document.getElementById('address-section');
  const outOfArea = document.getElementById('out-of-area');
  const addressLabel = document.getElementById('address-label');
  if (addressSection) {
    addressSection.classList.toggle('hidden', locationType === 'werkstatt');
  }
  if (outOfArea) outOfArea.classList.add('hidden');

  // Dynamic label
  if (addressLabel) {
    addressLabel.textContent = locationType === 'anderer_ort' ? 'Einsatzort' : 'Deine Adresse';
  }

  // Reset geo result when switching
  if (locationType === 'werkstatt') {
    BookingState.set('geoResult', { reachable: true, travelTimeMinutes: 0, zone: 0, travelFee: 0 });
    BookingState.set('address', null);
  } else {
    BookingState.set('geoResult', null);
  }
}

function selectVehicle(el) {
  const vehicleType = el.dataset.vehicle;

  document.querySelectorAll('[data-vehicle]').forEach(card => {
    card.classList.toggle('active', card.dataset.vehicle === vehicleType);
  });

  BookingState.set('vehicleType', vehicleType);
}

async function checkAddress() {
  const street = document.getElementById('address-street')?.value.trim();
  const plz = document.getElementById('address-plz')?.value.trim();
  const city = document.getElementById('address-city')?.value.trim();
  const outOfArea = document.getElementById('out-of-area');

  // Validate all fields
  let hasError = false;
  [
    { el: document.getElementById('address-street'), val: street, msg: 'Bitte gib Straße und Hausnummer ein.' },
    { el: document.getElementById('address-plz'), val: plz, msg: 'Bitte gib eine PLZ ein.' },
    { el: document.getElementById('address-city'), val: city, msg: 'Bitte gib einen Ort ein.' }
  ].forEach(({ el, val, msg }) => {
    const err = el?.parentElement?.querySelector('.form-error');
    if (!val) {
      el?.classList.add('!border-state-danger');
      if (err) { err.textContent = msg; err.classList.remove('hidden'); }
      hasError = true;
    } else {
      el?.classList.remove('!border-state-danger');
      if (err) { err.textContent = ''; err.classList.add('hidden'); }
    }
  });

  if (hasError) return;

  const address = `${street}, ${plz} ${city}`;
  showGeoFeedback('loading', 'Adresse wird geprüft...');

  try {
    const res = await fetch(API_BASE + '/api/geo/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address })
    });
    const result = await res.json();

    BookingState.set('address', address);
    BookingState.set('addressFields', { street, plz, city });
    BookingState.set('geoResult', result);

    if (result.reachable) {
      showGeoFeedback('success', `Super! Wir können zu dir kommen. (Anfahrt: ${result.travelFee > 0 ? result.travelFee + ' €' : 'Kostenlos'})`);
      outOfArea?.classList.add('hidden');
    } else {
      showGeoFeedback('error', 'Diese Adresse liegt leider außerhalb unseres Einsatzgebiets.');
      outOfArea?.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Geo check error:', err);
    showGeoFeedback('error', 'Fehler bei der Adressprüfung. Bitte versuche es erneut.');
  }
}

function showGeoFeedback(type, message) {
  const feedback = document.getElementById('geo-feedback');
  if (!feedback) return;

  feedback.classList.remove('hidden');
  const classMap = {
    success: 'geo-status geo-status--success',
    error: 'geo-status geo-status--error',
    loading: 'geo-status geo-status--loading'
  };

  const iconMap = {
    success: '&#10003;',
    error: '&#10007;',
    loading: '<span class="inline-block w-4 h-4 border-2 border-text-muted border-t-transparent rounded-full animate-spin"></span>'
  };

  feedback.className = classMap[type] || '';
  feedback.innerHTML = `${iconMap[type] || ''} <span>${message}</span>`;
}

// PLZ → Ort Auto-Lookup via openplzapi.org
let plzAbortControllers = {};

async function onPlzInput(el, cityId, loadingId) {
  // Default IDs for Step 1 (backward-compatible)
  cityId = cityId || 'address-city';
  loadingId = loadingId || 'plz-loading';

  const plz = el.value.replace(/\D/g, '');
  el.value = plz; // nur Ziffern erlauben

  const cityInput = document.getElementById(cityId);
  const loading = document.getElementById(loadingId);

  if (plz.length < 5) return;

  // Abort previous request for this specific field
  if (plzAbortControllers[cityId]) plzAbortControllers[cityId].abort();
  plzAbortControllers[cityId] = new AbortController();

  if (loading) loading.classList.remove('hidden');

  try {
    const res = await fetch(
      `https://openplzapi.org/de/Localities?postalCode=${plz}`,
      {
        headers: { 'accept': 'text/json' },
        signal: plzAbortControllers[cityId].signal
      }
    );
    const data = await res.json();

    if (loading) loading.classList.add('hidden');

    if (!data || data.length === 0) {
      if (cityInput) cityInput.placeholder = 'PLZ nicht gefunden — bitte manuell eingeben';
      return;
    }

    const orte = [...new Set(data.map(d => d.name))];
    clearCityOptions(cityId);

    if (orte.length === 1) {
      if (cityInput) {
        cityInput.value = orte[0];
        cityInput.classList.remove('!border-state-danger');
        const err = cityInput.parentElement?.querySelector('.form-error');
        if (err) { err.textContent = ''; err.classList.add('hidden'); }
        // Update state if this is a customer field
        if (cityInput.dataset.field) {
          BookingState.set(cityInput.dataset.field, orte[0]);
        }
      }
    } else {
      cityInput.value = '';
      showCityOptions(orte, cityInput);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('PLZ lookup error:', err);
    if (loading) loading.classList.add('hidden');
  }
}

function showCityOptions(orte, cityInput) {
  if (!cityInput) return;

  const cityId = cityInput.id;
  clearCityOptions(cityId);

  // Hide text input, show select dropdown instead
  cityInput.style.display = 'none';

  const select = document.createElement('select');
  select.id = cityId + '-options';
  select.className = 'form-select';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Ort wählen...';
  select.appendChild(defaultOpt);

  orte.forEach(ort => {
    const opt = document.createElement('option');
    opt.value = ort;
    opt.textContent = ort;
    select.appendChild(opt);
  });

  select.onchange = () => {
    cityInput.value = select.value;
    // Update state if this is a customer field
    if (cityInput.dataset.field) {
      BookingState.set(cityInput.dataset.field, select.value);
    }
  };

  cityInput.parentElement.insertBefore(select, cityInput.nextSibling);
}

function clearCityOptions(cityId) {
  cityId = cityId || 'address-city';
  const existing = document.getElementById(cityId + '-options');
  if (existing) existing.remove();
  const cityInput = document.getElementById(cityId);
  if (cityInput) cityInput.style.display = '';
}

// ═══════════════════════════════════════════
// Flow-Wrapper (auto-advance single-choice)
// ═══════════════════════════════════════════

function chooseLocation(el) {
  selectLocation(el);
  // For Werkstatt → skip address screen entirely, auto-advance
  // For mobil/anderer_ort → advance to address screen
  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function chooseVehicle(el) {
  selectVehicle(el);
  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

async function checkAddressAndAdvance() {
  await checkAddress();
  const geo = BookingState.get('geoResult');
  if (geo?.reachable && typeof flowAutoAdvance === 'function') {
    flowAutoAdvance(400);
  }
}

function subscribeNewsletter() {
  const email = document.getElementById('newsletter-email')?.value;
  if (!email) return;
  // TODO: Newsletter API call
  const btn = document.querySelector('#out-of-area button');
  if (btn) {
    btn.textContent = 'Eingetragen!';
    btn.disabled = true;
  }
}

// Restore state on load
document.addEventListener('DOMContentLoaded', () => {
  const loc = BookingState.get('locationType');
  const veh = BookingState.get('vehicleType');

  if (loc) {
    document.querySelectorAll('.location-card').forEach(card => {
      card.classList.toggle('active', card.dataset.location === loc);
    });
    if (loc !== 'werkstatt') {
      document.getElementById('address-section')?.classList.remove('hidden');
      const label = document.getElementById('address-label');
      if (label) label.textContent = loc === 'anderer_ort' ? 'Einsatzort' : 'Deine Adresse';
    }
    // Restore address fields
    const fields = BookingState.get('addressFields');
    if (fields) {
      const s = document.getElementById('address-street');
      const p = document.getElementById('address-plz');
      const c = document.getElementById('address-city');
      if (s) s.value = fields.street || '';
      if (p) p.value = fields.plz || '';
      if (c) c.value = fields.city || '';
    }
  }

  if (veh) {
    document.querySelectorAll('[data-vehicle]').forEach(card => {
      card.classList.toggle('active', card.dataset.vehicle === veh);
    });
  }
});
