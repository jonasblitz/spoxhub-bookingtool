/**
 * Flow Manager — Single-question screens with conditional routing,
 * auto-advance, back navigation, and animated transitions.
 *
 * Each screen has:
 *   id        — unique DOM id on the <section data-screen="...">
 *   show?     — (state) => boolean; default always true
 *   validate? — (state) => true | "error message"; default always valid
 *   onEnter?  — ()    => void; hook called when the screen becomes active
 *   autoAdvance? — true for single-choice screens (advances from the choice handler)
 */

const FLOW_SCREENS = [
  // Phase 1 — Was & Wo
  { id: 'location-type',     autoAdvance: true,
    validate: () => !!BookingState.get('locationType') || 'Bitte wähle einen Standort.' },

  { id: 'address',
    show: () => ['mobil', 'anderer_ort'].includes(BookingState.get('locationType')),
    onEnter: () => window.prefillAddressFromState?.(),
    validate: () => {
      const geo = BookingState.get('geoResult');
      if (!geo || !geo.reachable) return 'Bitte gib eine gültige Adresse ein und prüfe die Verfügbarkeit.';
      return true;
    }
  },

  { id: 'vehicle-type',      autoAdvance: true,
    validate: () => !!BookingState.get('vehicleType') || 'Bitte wähle deinen Fahrzeugtyp.' },

  // Phase 2 — Service
  { id: 'service-type',      autoAdvance: true,
    validate: () => !!BookingState.get('serviceType') || 'Bitte wähle Inspektion oder Reparatur.' },

  { id: 'inspektion-additional',
    show: () => BookingState.get('serviceType') === 'inspektion',
    // Default ist "Nein" — kein expliziter Klick nötig. User klickt "Ja"
    // nur wenn er zusätzlich reparieren möchte; sonst direkt "Weiter".
    onEnter: () => {
      if (BookingState.get('inspektionAddRepair') == null) {
        BookingState.set('inspektionAddRepair', false);
      }
      // Button visuell synchronisieren mit aktuellem State
      const btn = document.getElementById('btn-inspektion-add-yes');
      if (btn) btn.classList.toggle('selected', BookingState.get('inspektionAddRepair') === true);
    } },

  { id: 'repair-catalog',
    show: () => BookingState.get('serviceType') === 'reparatur'
                || BookingState.get('inspektionAddRepair') === true,
    onEnter: () => window.onEnterRepairCatalog?.(),
    validate: () => (BookingState.get('selectedServices') || [])
                      .some(s => s.bereich !== 'Inspektion')
      || 'Bitte wähle mindestens eine Leistung.' },

  { id: 'repair-more', autoAdvance: true,
    // Nur bei Inspektion mit Zusatz-Reparatur — bei reiner Reparatur überspringen
    // (User kann im Catalog selbst weitere Leistungen hinzufügen).
    show: () => BookingState.get('inspektionAddRepair') === true,
    validate: () => BookingState.get('needMore') != null || 'Bitte triff eine Auswahl.' },

  // Termin-Wahl wandert nach vorn — der gewählte Slot wird in eTermin als
  // Reservierung mit appattrib=0 / sync=0 angelegt und beim Booking-Confirm
  // mit den finalen Daten geupdated.
  { id: 'slot-select',
    onEnter: () => window.onEnterSlotSelect?.(),
    validate: () => !!BookingState.get('selectedSlot') || 'Bitte wähle einen Termin.' },

  { id: 'problem-description' /* optional — Skip immer erlaubt */ },

  // Phase 3 — Dein Rad (kombinierter Screen: Marke + Modell + Rahmennummer, alles optional)
  { id: 'bike-brand',
    onEnter: () => window.prefillFormFromState?.(),
    validate: () => {
      const b = BookingState.get('bike') || {};
      // Marke ist optional. Wenn gesetzt, gilt aber die Blacklist.
      if (b.marke && typeof isBrandBlacklisted === 'function' && isBrandBlacklisted(b.marke)) {
        return `Leider können wir ${b.marke} aktuell nicht warten. Bitte wähle eine andere Marke oder kontaktiere uns.`;
      }
      return true;
    }
  },

  { id: 'bike-leasing',
    onEnter: () => { window.onEnterBikeLeasing?.(); window.prefillFormFromState?.(); } },


  // Phase 4 — Deine Daten
  { id: 'customer-name-contact',
    onEnter: () => window.prefillFormFromState?.(),
    validate: () => {
      const c = BookingState.get('customer') || {};
      if (!c.vorname) return 'Bitte gib deinen Vornamen ein.';
      if (!c.name)    return 'Bitte gib deinen Nachnamen ein.';
      if (!c.email)   return 'Bitte gib deine E-Mail-Adresse ein.';
      if (!c.mobil)   return 'Bitte gib deine Handynummer ein.';
      return true;
    }
  },

  { id: 'customer-address',
    onEnter: () => { window.prefillCustomerAddress?.(); window.prefillFormFromState?.(); },
    validate: () => {
      const c = BookingState.get('customer') || {};
      if (!c.strasse) return 'Bitte gib deine Straße ein.';
      if (!c.plz)     return 'Bitte gib deine PLZ ein.';
      if (!c.ort)     return 'Bitte gib deinen Ort ein.';
      return true;
    }
  },

  // Phase 5 — Zahlung
  { id: 'payment',
    onEnter: () => window.onEnterPayment?.(),
    validate: () => !!BookingState.get('depositPaid') || 'Bitte schließe die Anzahlung ab.' },

  { id: 'confirmation',
    onEnter: () => window.onEnterConfirmation?.() },
];

let flowCurrentIndex = 0;
let flowHistory = [0];

function flowVisibleScreens() {
  return FLOW_SCREENS.filter(s => !s.show || s.show());
}

function flowCurrentId() {
  return FLOW_SCREENS[flowCurrentIndex]?.id;
}

function flowIndexById(id) {
  return FLOW_SCREENS.findIndex(s => s.id === id);
}

function flowProgress() {
  const visible = flowVisibleScreens();
  const currentId = flowCurrentId();
  const visibleIdx = visible.findIndex(s => s.id === currentId);
  if (visibleIdx < 0 || visible.length <= 1) return 0;
  return Math.round((visibleIdx / (visible.length - 1)) * 100);
}

function flowUpdateChrome() {
  const pct = flowProgress();
  const bar = document.getElementById('progress-bar');
  const pctEl = document.getElementById('progress-percent');
  if (bar)   bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + ' %';

  // Back button is always visible — from the first screen it leaves the booking tool
  const back = document.getElementById('btn-back');
  if (back) back.classList.remove('is-hidden');
}

function flowShow(idx, direction = 'forward') {
  const screen = FLOW_SCREENS[idx];
  if (!screen) return;
  flowCurrentIndex = idx;

  // Toggle panels
  document.querySelectorAll('[data-screen]').forEach(el => {
    const isActive = el.dataset.screen === screen.id;
    el.classList.toggle('is-hidden', !isActive);
    el.classList.remove('is-entering-forward', 'is-entering-back');
    if (isActive) {
      // trigger reflow so animation replays
      void el.offsetWidth;
      el.classList.add(direction === 'back' ? 'is-entering-back' : 'is-entering-forward');
    }
  });

  flowUpdateChrome();
  // Smart-Scroll: zum Wizard-Top (nicht Page-Top) im Embed-Kontext.
  // In Standalone identisch mit dem alten window.scrollTo(0,0).
  scrollToWizardTop();

  // Analytics: log screen entry
  if (typeof window.trackScreen === 'function') {
    try { window.trackScreen(screen.id); } catch (e) { /* ignore */ }
  }

  if (typeof screen.onEnter === 'function') {
    try { screen.onEnter(); } catch (e) { console.error('onEnter error', e); }
  }

  history.replaceState({ screen: screen.id }, '', '?s=' + encodeURIComponent(screen.id));
}

function flowNext(opts = {}) {
  const screen = FLOW_SCREENS[flowCurrentIndex];
  if (screen?.validate && !opts.skipValidation) {
    const result = screen.validate(BookingState.getAll?.() || {});
    if (result !== true) {
      flowFlashError(typeof result === 'string' ? result : 'Bitte fülle die Felder korrekt aus.');
      return false;
    }
  }

  // find next visible screen
  for (let i = flowCurrentIndex + 1; i < FLOW_SCREENS.length; i++) {
    const s = FLOW_SCREENS[i];
    if (!s.show || s.show()) {
      flowHistory.push(i);
      flowShow(i, 'forward');
      return true;
    }
  }
  return false;
}

function flowBack() {
  if (flowHistory.length > 1) {
    flowHistory.pop();
    const idx = flowHistory[flowHistory.length - 1];
    flowShow(idx, 'back');
    return;
  }
  // On first screen: leave the booking tool (go back in browser history, or to homepage)
  if (document.referrer && document.referrer !== window.location.href) {
    window.history.back();
  } else {
    window.location.href = '/';
  }
}

function flowSkip() {
  flowNext({ skipValidation: true });
}

/**
 * Call from screen UI after an auto-advance choice has updated BookingState.
 * Adds a brief delay so the user sees the selection before advancing.
 */
function flowAutoAdvance(delay = 220) {
  setTimeout(() => flowNext(), delay);
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function flowFlashError(msg) {
  // Remove any existing error
  document.querySelectorAll('.flow-error-toast').forEach(el => el.remove());

  const toast = document.createElement('div');
  toast.className = 'flow-error-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = msg;

  // Prefer placing inside the active screen's footer (right above the Weiter button)
  const activeScreen = document.querySelector('.screen-panel:not(.is-hidden)');
  const footerInner  = activeScreen?.querySelector('.screen-footer__inner');

  if (footerInner) {
    footerInner.insertBefore(toast, footerInner.firstChild);
  } else if (activeScreen) {
    activeScreen.appendChild(toast);
  } else {
    // Fallback: top-center toast
    toast.classList.add('flow-error-toast--floating');
    document.body.appendChild(toast);
  }

  setTimeout(() => toast.remove(), 4000);
}

// Back-button support (browser)
window.addEventListener('popstate', () => {
  if (flowHistory.length > 1) flowBack();
});

// Init
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const startId = params.get('s');
  const startIdx = startId ? flowIndexById(startId) : 0;
  flowCurrentIndex = Math.max(0, startIdx);
  flowHistory = [flowCurrentIndex];
  flowShow(flowCurrentIndex, 'forward');
});
