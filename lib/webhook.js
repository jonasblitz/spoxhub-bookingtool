/**
 * Webhook-Helper: feuert externe Notifications nach erfolgreichen Buchungen.
 *
 * Aktueller Konsument: n8n-Workflow `spoxhub-order-*` — bekommt nach jeder
 * Buchung dieselbe Payload, die auch eTermin gesehen hat (siehe
 * lib/etermin.js → createAppointment) plus die eTermin-bookingId zur
 * Referenz.
 *
 * Design:
 *   - Fire-and-forget. Webhook-Fehler werden geloggt, aber NIE an den
 *     Aufrufer geworfen — eine erfolgreiche Buchung wird nicht durch
 *     einen flackernden Webhook ungültig.
 *   - URL kommt aus ENV (`N8N_ORDER_WEBHOOK_URL`). Wenn nicht gesetzt
 *     → silent no-op. Token bleibt server-side, nie in Logs.
 *   - Timeout 10s, damit ein hängender n8n nicht den Prozess blockiert.
 */

function redactedUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('token')) u.searchParams.set('token', '<redacted>');
    return u.toString();
  } catch { return '<invalid-url>'; }
}

async function postOrderWebhook(payload) {
  const url = process.env.N8N_ORDER_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: 'N8N_ORDER_WEBHOOK_URL not set' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!r.ok) {
      console.warn(`[webhook] ${redactedUrl(url)} → ${r.status} ${r.statusText}`);
      return { ok: false, status: r.status };
    }
    console.log(`[webhook] ${redactedUrl(url)} → ${r.status}`);
    return { ok: true, status: r.status };
  } catch (err) {
    console.warn(`[webhook] ${redactedUrl(url)} error: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { postOrderWebhook };
