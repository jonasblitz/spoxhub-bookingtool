/**
 * BookingState — Zentraler State-Store (Pub/Sub, Vanilla JS)
 * Persistiert in sessionStorage für Back-Button-Resilience.
 */
const BookingState = (() => {
  // Versionierter Storage-Key. Bei Breaking Changes am defaults-Schema
  // einfach Versions-Suffix hochziehen → alte Sessions werden ignoriert.
  // Im WordPress-Plugin-Kontext können mehrere Embed-Instanzen koexistieren,
  // daher zusätzlich an Pathname binden, falls SPOXHUB_STATE_NAMESPACE nicht gesetzt.
  const NAMESPACE = (typeof window !== 'undefined' && window.SPOXHUB_STATE_NAMESPACE)
    ? window.SPOXHUB_STATE_NAMESPACE
    : 'default';
  const STORAGE_KEY = `spoxhub_booking_state_v2:${NAMESPACE}`;

  const defaults = {
    currentStep: 1,
    locationType: null,
    address: null,
    geoResult: null,
    vehicleType: null,
    bidexClass: null,
    serviceType: null,
    inspektionAddRepair: null,
    knowWhat: null,
    needMore: null,
    depositPaid: false,
    agbAccepted: false,
    privacyAccepted: false,
    newsletterOptIn: true,
    feedbackOptIn: true,
    selectedServices: [],
    customer: {
      anrede: '', vorname: '', name: '', email: '', mobil: '',
      strasse: '', plz: '', ort: '',
      rechnungFirma: '', rechnungStrasse: '', rechnungPlz: '', rechnungOrt: ''
    },
    bike: {
      marke: '', modell: '', rahmennummer: '', versicherung: '', leasing: ''
    },
    problemDescription: '',
    uploadedFiles: [],
    addressNotes: '',
    selectedSlot: null,
    pricing: null,
    bookingResult: null,
    // Traffic-Source (last-touch attribution). Wird von public/js/source.js
    // beim Boot gesetzt: { classification, utmSource, utmMedium, utmCampaign,
    // utmContent, utmTerm, gclid, fbclid, referrer, detectedAt, pageUrl }
    source: null
  };

  let _state;
  const _listeners = [];

  function saveToStorage() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch (e) { /* ignore */ }
  }

  function clearStorage() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  // Always start fresh on every page load (reload = clean state).
  clearStorage();
  _state = { ...defaults };
  saveToStorage();

  return {
    get(key) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let val = _state;
        for (const p of parts) val = val?.[p];
        return val;
      }
      return _state[key];
    },

    set(key, value) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let obj = _state;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      } else {
        _state[key] = value;
      }
      saveToStorage();
      _listeners.forEach(fn => {
        try { fn(key, value, _state); } catch (e) { console.error('State listener error:', e); }
      });
    },

    subscribe(fn) {
      _listeners.push(fn);
      return () => {
        const idx = _listeners.indexOf(fn);
        if (idx > -1) _listeners.splice(idx, 1);
      };
    },

    getAll() {
      return { ..._state };
    },

    reset() {
      _state = { ...defaults };
      clearStorage();
      _listeners.forEach(fn => {
        try { fn('*', null, _state); } catch (e) { /* ignore */ }
      });
    },

    toJSON() {
      return JSON.parse(JSON.stringify(_state));
    }
  };
})();

// Start inactivity timer + bind user-activity listeners
/**
 * scrollToWizardTop — context-aware Scroll bei Step-/Screen-Wechseln.
 *
 * Standalone:  Wizard füllt den Body, scrollt effektiv zum Page-Top.
 * Embed (WP):  Scrollt zum oberen Rand des .spoxhub-booking-Containers,
 *              NICHT zum Page-Top. Page-Header bleibt sichtbar.
 *
 * Macht außerdem nichts, wenn der Wizard-Top schon im sichtbaren oberen
 * Viewport-Bereich ist — verhindert nervige Mini-Sprünge bei kurzen Steps.
 *
 * Berücksichtigt einen Sticky-Header-Offset (--spoxhub-scroll-offset oder 80px).
 */
function scrollToWizardTop() {
  const reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wizard = document.querySelector('.spoxhub-booking');

  // Fallback wenn der Wrapper fehlt: alter Standalone-Default
  if (!wizard) {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    return;
  }

  const rect = wizard.getBoundingClientRect();

  // Konfigurierbarer Offset für Sticky-Header.
  // Theme kann mit `:root { --spoxhub-scroll-offset: 100px; }` overriden.
  const cssVar = getComputedStyle(document.documentElement)
    .getPropertyValue('--spoxhub-scroll-offset').trim();
  const offset = cssVar ? parseInt(cssVar, 10) || 0 : 80;

  // Wenn Wizard-Top bereits sichtbar (innerhalb [-10px, offset+40px] vom Viewport-Top),
  // sparen wir uns den Sprung — User ist schon "oben am Wizard".
  if (rect.top >= -10 && rect.top <= offset + 40) return;

  const targetY = Math.max(0, window.scrollY + rect.top - offset);
  window.scrollTo({ top: targetY, behavior: reduced ? 'auto' : 'smooth' });
}

(function initInactivityTracking() {
  function start() {
    document.addEventListener('click',        __resetTimer, { passive: true });
    document.addEventListener('keydown',      __resetTimer, { passive: true });
    document.addEventListener('touchstart',   __resetTimer, { passive: true });
    document.addEventListener('pointerdown',  __resetTimer, { passive: true });
    document.addEventListener('scroll',       __resetTimer, { passive: true });
    __resetTimer();
  }
  const INACTIVITY_MS = 30 * 60 * 1000;
  let timer = null;
  function __resetTimer() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log('[state] Inactivity timeout — reloading for fresh state.');
      try { sessionStorage.removeItem('spoxhub_booking_state'); } catch (_) {}
      window.location.href = window.location.pathname;
    }, INACTIVITY_MS);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
