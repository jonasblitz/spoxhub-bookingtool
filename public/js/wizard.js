/**
 * Wizard Navigation — Step-Management + pushState
 */

const TOTAL_STEPS = 5;

function goToStep(step) {
  const current = BookingState.get('currentStep');

  // Validate before moving forward
  if (step > current && !validateStep(current)) return;

  showStep(step);
  BookingState.set('currentStep', step);
  history.pushState({ step }, '', '?step=' + step);
}

function showStep(step) {
  // Toggle panels
  document.querySelectorAll('.step-panel').forEach(panel => {
    const panelStep = parseInt(panel.dataset.step);
    panel.classList.toggle('is-hidden', panelStep !== step);
  });

  // Update stepper
  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = parseInt(el.dataset.wizardStep);
    el.classList.remove('active', 'completed');
    if (s === step) el.classList.add('active');
    else if (s < step) el.classList.add('completed');
  });

  // Update connector lines
  document.querySelectorAll('.wizard-step-line').forEach((line, i) => {
    line.classList.toggle('completed', i + 1 < step);
  });

  // Pre-fill customer address when entering Step 4
  if (step === 4 && typeof prefillCustomerAddress === 'function') {
    prefillCustomerAddress();
  }

  // Smart-Scroll: zum Wizard-Top (nicht Page-Top) im Embed-Kontext.
  // In Standalone identisch mit dem alten window.scrollTo(0,0).
  scrollToWizardTop();
}

function validateStep(step) {
  switch (step) {
    case 1:
      if (!BookingState.get('locationType')) {
        flashError('Bitte wähle einen Standort.');
        return false;
      }
      if (BookingState.get('locationType') !== 'werkstatt') {
        const geo = BookingState.get('geoResult');
        if (!geo || !geo.reachable) {
          flashError('Bitte gib eine gültige Adresse ein und prüfe die Verfügbarkeit.');
          return false;
        }
      }
      if (!BookingState.get('vehicleType')) {
        flashError('Bitte wähle deinen Fahrzeugtyp.');
        return false;
      }
      return true;

    case 2:
      if (BookingState.get('selectedServices').length === 0) {
        flashError('Bitte wähle mindestens eine Leistung.');
        return false;
      }
      return true;

    case 3:
      return validateBikeForm();

    case 4:
      return validateCustomerForm();

    case 5:
      return true;

    default:
      return true;
  }
}

function flashError(msg) {
  // Brief visual feedback — could be a toast
  const existing = document.getElementById('wizard-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'wizard-toast';
  toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 bg-state-danger text-white px-6 py-3 rounded-lg shadow-card-lg text-sm font-body z-50 animate-fade-in';
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Update "Weiter" button states
function updateStepButtons() {
  const step = BookingState.get('currentStep');
  const loc = BookingState.get('locationType');
  const veh = BookingState.get('vehicleType');
  const services = BookingState.get('selectedServices');
  const geo = BookingState.get('geoResult');

  // Step 1: location + vehicle + geo (if needed)
  const btn1 = document.getElementById('btn-step1-next');
  if (btn1) {
    const geoOk = loc === 'werkstatt' || (geo && geo.reachable);
    const enabled = !!(loc && veh && geoOk);
    btn1.disabled = !enabled;
    btn1.classList.toggle('pulse', enabled);
  }

  // Step 2: at least one service
  const btn2 = document.getElementById('btn-step2-next');
  if (btn2) {
    btn2.disabled = services.length === 0;
    btn2.classList.toggle('pulse', services.length > 0);
  }

  // Step 3: bike fields (nur Marke ist Pflicht)
  const btn3 = document.getElementById('btn-step3-next');
  if (btn3) {
    const b = BookingState.get('bike') || {};
    const bikeOk = !!b.marke;
    btn3.disabled = !bikeOk;
    btn3.classList.toggle('pulse', bikeOk);
  }

  // Step 4: customer fields
  const btn4 = document.getElementById('btn-step4-next');
  if (btn4) {
    const complete = isCustomerFormComplete();
    btn4.disabled = !complete;
    btn4.classList.toggle('pulse', complete);
  }
}

function isCustomerFormComplete() {
  const c = BookingState.get('customer') || {};
  return !!(c.vorname && c.name && c.email && c.mobil && c.strasse && c.plz && c.ort);
}

function validateBikeForm() {
  const requiredFields = document.querySelectorAll('[data-step="3"] [required]');
  let allValid = true;
  requiredFields.forEach(field => {
    if (!validateField(field)) allValid = false;
  });
  return allValid;
}

// Back-button support
window.addEventListener('popstate', (e) => {
  const step = e.state?.step || 1;
  showStep(step);
  BookingState.set('currentStep', step);
});

// Subscribe to state changes for button updates
BookingState.subscribe(() => updateStepButtons());

// Init
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const step = parseInt(params.get('step')) || 1;
  showStep(step);
  BookingState.set('currentStep', step);
  updateStepButtons();
});
