/**
 * PayPal helper — server-side wrappers around PayPal Orders v2.
 * Used by:
 *   - routes/api-paypal.js  (create-order / capture-order called from browser)
 *   - routes/api-booking.js (auto-refund when eTermin booking fails)
 *   - scripts/refund-capture.js (manual refund tooling)
 */

const PAYPAL_API = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const CURRENCY = 'EUR';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  // Reuse token while it's still valid (PayPal tokens last ~9h, we reuse ~80% of that).
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret   = process.env.PAYPAL_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials not configured');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth error: ${data.error_description || res.status}`);

  cachedToken = data.access_token;
  // expires_in is seconds; refresh ~5 min before expiry.
  cachedTokenExpiry = Date.now() + Math.max(0, (data.expires_in - 300)) * 1000;
  return cachedToken;
}

async function createOrder({ amount = '20.00', description = 'Anzahlung Fahrrad-Service' } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: CURRENCY, value: amount }, description }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `PayPal create order failed (${res.status})`);
  return data;
}

async function captureOrder(orderId) {
  if (!orderId) throw new Error('orderId required');
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `PayPal capture failed (${res.status})`);
  return data;
}

/**
 * Refund a captured payment (full or partial).
 * @param {string} captureId  — PayPal capture ID (e.g. "5XA39972K4440325K")
 * @param {object} [opts]
 * @param {string} [opts.amount]      — partial amount as decimal string ("10.00"); omit for full refund
 * @param {string} [opts.reason]      — short note shown in PayPal back-office (max 30 chars)
 * @param {string} [opts.invoiceId]   — optional invoice reference
 * @returns {Promise<object>}         — PayPal refund response
 */
async function refundCapture(captureId, opts = {}) {
  if (!captureId) throw new Error('captureId required');
  const token = await getAccessToken();

  const body = {};
  if (opts.amount) body.amount = { currency_code: CURRENCY, value: opts.amount };
  if (opts.reason) body.note_to_payer = String(opts.reason).slice(0, 250);
  if (opts.invoiceId) body.invoice_id = opts.invoiceId;

  const res = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data.message || data.details?.[0]?.description || `HTTP ${res.status}`;
    throw new Error(`PayPal refund failed: ${msg}`);
  }
  return data;
}

module.exports = {
  PAYPAL_API,
  CURRENCY,
  getAccessToken,
  createOrder,
  captureOrder,
  refundCapture
};
