/**
 * Payment — PayPal Anzahlung (20 €)
 */

let paypalButtonsRendered = false;
let depositPaid = false;

function initPaypalButtons() {
  const container = document.getElementById('paypal-button-container');
  if (!container || paypalButtonsRendered) return;

  // Check if PayPal SDK is loaded
  const paypal = window.paypal_sdk || window.paypal;
  if (!paypal) {
    container.innerHTML = '<p class="text-text-muted text-sm text-center py-4">PayPal wird geladen...</p>';
    return;
  }

  paypalButtonsRendered = true;

  paypal.Buttons({
    style: {
      layout: 'vertical',
      color: 'gold',
      shape: 'rect',
      label: 'pay',
      height: 45
    },

    onInit: (data, actions) => {
      actions.disable();
      window.__paypalActions = actions;
      updateConsentState();
    },

    onClick: (data, actions) => {
      // Save consent to state right before payment
      const agb = document.getElementById('consent-agb')?.checked;
      const privacy = document.getElementById('consent-privacy')?.checked;
      const newsletter = document.getElementById('consent-newsletter')?.checked;
      if (!agb || !privacy) return actions.reject();
      BookingState.set('agbAccepted', !!agb);
      BookingState.set('privacyAccepted', !!privacy);
      BookingState.set('newsletterOptIn', !!newsletter);
      return actions.resolve();
    },

    createOrder: async () => {
      showPaymentState('processing');
      try {
        const res = await fetch(API_BASE + '/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showPaymentState('buttons');
        return data.id;
      } catch (err) {
        console.error('PayPal create order error:', err);
        showPaymentState('error', 'Zahlung konnte nicht initialisiert werden.');
        throw err;
      }
    },

    onApprove: async (data) => {
      // Spinner bleibt durchgehend sichtbar — kein Zwischenstop nach Capture,
      // direkt zur Confirmation. PayPal-Capture + eTermin-Buchung sind aus
      // User-Sicht eine einzige verbindliche Aktion.
      showPaymentState('processing');
      try {
        const res = await fetch(API_BASE + '/api/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderID: data.orderID })
        });
        const result = await res.json();

        if (!result.success) {
          showPaymentState('error', result.error || 'Zahlung fehlgeschlagen.');
          return;
        }

        depositPaid = true;
        BookingState.set('depositPaid', true);
        BookingState.set('payment', {
          method: 'paypal',
          orderId: data.orderID,
          captureId: result.captureId,
          amount: 20,
          status: 'completed'
        });

        // Direkt buchen — Spinner bleibt im 'processing'-State, bis confirmBooking
        // den flowNext zur Confirmation-Seite triggert. Kein "verbindlich buchen"-
        // Zwischenscreen mehr (UX: eine Aktion, ein Ergebnis).
        try {
          await window.confirmBooking();
          // Success path: confirmBooking advanced flow to confirmation screen.
        } catch (err) {
          console.error('Booking after PayPal failed:', err);
          showPaymentState('booking-error', err.message || 'Buchung fehlgeschlagen.');
        }
      } catch (err) {
        console.error('PayPal capture error:', err);
        showPaymentState('error', 'Zahlung konnte nicht abgeschlossen werden.');
      }
    },

    onCancel: () => {
      showPaymentState('buttons');
    },

    onError: (err) => {
      console.error('PayPal error:', err);
      showPaymentState('error', 'Ein Fehler ist aufgetreten. Bitte versuche es erneut.');
    }
  }).render('#paypal-button-container');
}

function showPaymentState(state, errorMsg) {
  // Vereinfachter State-Manager: nur 4 States.
  // 'success' und 'booking' wurden entfernt — Spinner bleibt durchgehend bis
  // flow zur Confirmation-Seite wechselt.
  const buttons      = document.getElementById('paypal-button-container');
  const processing   = document.getElementById('payment-processing');
  const error        = document.getElementById('payment-error');
  const bookingError = document.getElementById('payment-booking-error');

  [buttons, processing, error, bookingError].forEach(el => {
    if (el) el.classList.add('hidden');
  });

  switch (state) {
    case 'buttons':
      if (buttons) buttons.classList.remove('hidden');
      break;
    case 'processing':
      if (processing) processing.classList.remove('hidden');
      break;
    case 'error':
      if (error) {
        error.classList.remove('hidden');
        const msg = document.getElementById('payment-error-msg');
        if (msg) msg.textContent = errorMsg || 'Zahlung fehlgeschlagen.';
      }
      if (buttons) buttons.classList.remove('hidden');
      break;
    case 'booking-error':
      // Payment war erfolgreich, eTermin-Buchung schlug fehl → Retry-Button
      if (bookingError) {
        bookingError.classList.remove('hidden');
        const msg = document.getElementById('payment-booking-error-msg');
        if (msg) msg.textContent = errorMsg || 'Buchung fehlgeschlagen.';
      }
      break;
  }
}

// Consent state (AGB + Datenschutz + Newsletter) — gates PayPal buttons
function updateConsentState() {
  const agb = document.getElementById('consent-agb');
  const privacy = document.getElementById('consent-privacy');
  const newsletter = document.getElementById('consent-newsletter');
  const feedback = document.getElementById('consent-feedback');
  if (agb) BookingState.set('agbAccepted', !!agb.checked);
  if (privacy) BookingState.set('privacyAccepted', !!privacy.checked);
  if (newsletter) BookingState.set('newsletterOptIn', !!newsletter.checked);
  if (feedback) BookingState.set('feedbackOptIn', !!feedback.checked);

  const ready = !!(agb?.checked && privacy?.checked);
  if (window.__paypalActions) {
    try {
      ready ? window.__paypalActions.enable() : window.__paypalActions.disable();
    } catch (e) { /* ignore */ }
  }
}
window.updateConsentState = updateConsentState;

// ─── Voucher / Gutscheincode (interne Tests) ───────────────────────────────
function toggleVoucherInput() {
  const wrap = document.getElementById('voucher-input-wrap');
  if (!wrap) return;
  wrap.classList.toggle('hidden');
  if (!wrap.classList.contains('hidden')) {
    setTimeout(() => document.getElementById('voucher-code')?.focus(), 50);
  }
}
window.toggleVoucherInput = toggleVoucherInput;

function showVoucherError(msg) {
  const el = document.getElementById('voucher-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

async function redeemVoucherFromInput() {
  const codeEl = document.getElementById('voucher-code');
  const code = (codeEl?.value || '').trim();
  showVoucherError(null);

  if (!code) {
    showVoucherError('Bitte Code eingeben.');
    return;
  }

  // Same consent gate as PayPal
  const agb = document.getElementById('consent-agb')?.checked;
  const privacy = document.getElementById('consent-privacy')?.checked;
  if (!agb || !privacy) {
    showVoucherError('Bitte AGB und Datenschutz akzeptieren.');
    return;
  }

  const newsletter = document.getElementById('consent-newsletter')?.checked;
  const feedback = document.getElementById('consent-feedback')?.checked;
  BookingState.set('agbAccepted', true);
  BookingState.set('privacyAccepted', true);
  BookingState.set('newsletterOptIn', !!newsletter);
  BookingState.set('feedbackOptIn', !!feedback);

  showPaymentState('processing');
  try {
    const res = await fetch(API_BASE + '/api/voucher/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!res.ok || !data.valid) {
      showPaymentState('buttons');
      showVoucherError(data.error || 'Gutscheincode ungültig.');
      return;
    }

    depositPaid = true;
    BookingState.set('depositPaid', true);
    BookingState.set('payment', {
      method: 'voucher',
      code: data.code,
      amount: data.amount || 20,
      status: 'completed'
    });

    try {
      await window.confirmBooking();
    } catch (err) {
      console.error('Booking after voucher failed:', err);
      showPaymentState('booking-error', err.message || 'Buchung fehlgeschlagen.');
    }
  } catch (err) {
    console.error('Voucher redeem error:', err);
    showPaymentState('buttons');
    showVoucherError('Code konnte nicht geprüft werden. Bitte erneut versuchen.');
  }
}
window.redeemVoucherFromInput = redeemVoucherFromInput;

// Exposed for flow.js onEnter hook
function onEnterPayment() {
  // Render price summary on this screen too
  if (typeof updatePriceSummary === 'function') updatePriceSummary();

  // Restore consent checkboxes from state
  const agb = document.getElementById('consent-agb');
  const privacy = document.getElementById('consent-privacy');
  const newsletter = document.getElementById('consent-newsletter');
  const feedback = document.getElementById('consent-feedback');
  if (agb) agb.checked = !!BookingState.get('agbAccepted');
  if (privacy) privacy.checked = !!BookingState.get('privacyAccepted');
  if (newsletter) {
    const nl = BookingState.get('newsletterOptIn');
    newsletter.checked = nl !== false; // default true
  }
  if (feedback) {
    const fb = BookingState.get('feedbackOptIn');
    feedback.checked = fb !== false; // default true
  }

  // Edge-Case: Page-Reload nachdem Zahlung abgeschlossen wurde.
  // Mit dem aktuellen state.js-Verhalten ("clear on every load") sehr selten,
  // aber wenn doch — z.B. forced restore — direkt zur Confirmation springen.
  // Den expliziten Confirm-Button gibt es nicht mehr.
  const payment = BookingState.get('payment');
  if (payment?.status === 'completed') {
    depositPaid = true;
    if (typeof flowNext === 'function') flowNext({ skipValidation: true });
    return;
  }
  // Allow a moment for PayPal SDK to load, then sync consent state
  setTimeout(() => {
    initPaypalButtons();
    updateConsentState();
  }, 400);
}
