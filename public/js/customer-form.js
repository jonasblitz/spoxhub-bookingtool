/**
 * Customer Form — Inline-Validierung + State-Updates
 */

function updateCustomerField(el) {
  const field = el.dataset.field;
  if (!field) return;
  BookingState.set(field, el.value);
}

function validateField(el) {
  const field = el.dataset.field;
  if (!el.required) return true;

  const errorSpan = el.parentElement?.querySelector('.form-error');
  const value = el.value.trim();
  let errorMsg = '';

  if (!value) {
    errorMsg = 'Dieses Feld ist erforderlich.';
  } else if (field === 'customer.email' && !isValidEmail(value)) {
    errorMsg = 'Bitte gib eine gültige E-Mail-Adresse ein.';
  } else if (field === 'customer.mobil' && !isValidPhone(value)) {
    errorMsg = 'Bitte gib eine gültige Mobilnummer ein.';
  }

  if (errorMsg) {
    el.classList.add('!border-state-danger');
    if (errorSpan) {
      errorSpan.textContent = errorMsg;
      errorSpan.classList.remove('hidden');
    }
    return false;
  }

  el.classList.remove('!border-state-danger');
  if (errorSpan) {
    errorSpan.textContent = '';
    errorSpan.classList.add('hidden');
  }
  return true;
}

function validateCustomerForm() {
  const requiredFields = document.querySelectorAll('[data-step="4"] [required]');
  let allValid = true;

  requiredFields.forEach(field => {
    if (!validateField(field)) allValid = false;
  });

  return allValid;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^[\d\s+\-()]{6,}$/.test(phone);
}

function chooseBidex(klasse) {
  BookingState.set('bidexClass', klasse);
  BookingState.set('bike.bidexKlasse', klasse);
  document.querySelectorAll('[data-bidex]').forEach(card => {
    card.classList.toggle('active', card.dataset.bidex === klasse);
  });
  if (typeof flowAutoAdvance === 'function') flowAutoAdvance();
}

function toggleBikeSection(section, enabled) {
  const fieldsId = section + '-fields';
  const fields = document.getElementById(fieldsId);
  if (!fields) return;

  fields.classList.toggle('hidden', !enabled);
  if (!enabled) {
    fields.querySelectorAll('input').forEach(input => {
      input.value = '';
      if (input.dataset.field) BookingState.set(input.dataset.field, '');
    });
  }
}

function toggleBillingAlt(enabled) {
  const fields = document.getElementById('billing-alt-fields');
  if (!fields) return;
  fields.classList.toggle('hidden', !enabled);
  if (!enabled) {
    fields.querySelectorAll('input').forEach(input => {
      input.value = '';
      if (input.dataset.field) BookingState.set(input.dataset.field, '');
    });
  }
}

function toggleSection(sectionId, btn) {
  const section = document.getElementById(sectionId);
  if (!section) return;

  const isHidden = section.classList.contains('hidden');
  section.classList.toggle('hidden');
  btn?.classList.toggle('open', isHidden);
}

// Pre-fill address from Step 1 when entering Step 4
function prefillCustomerAddress() {
  const locationType = BookingState.get('locationType');
  const addressFields = BookingState.get('addressFields');
  const customer = BookingState.get('customer') || {};

  // Only pre-fill if mobile service and address fields exist and customer hasn't already filled them
  if ((locationType === 'mobil' || locationType === 'anderer_ort') && addressFields && !customer.strasse) {
    const strasse = document.getElementById('c-strasse');
    const plz = document.getElementById('c-plz');
    const ort = document.getElementById('c-ort');

    if (strasse && addressFields.street) {
      strasse.value = addressFields.street;
      BookingState.set('customer.strasse', addressFields.street);
    }
    if (plz && addressFields.plz) {
      plz.value = addressFields.plz;
      BookingState.set('customer.plz', addressFields.plz);
    }
    if (ort && addressFields.city) {
      ort.value = addressFields.city;
      BookingState.set('customer.ort', addressFields.city);
    }
  }
}

