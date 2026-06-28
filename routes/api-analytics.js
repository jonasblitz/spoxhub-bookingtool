const express = require('express');
const router = express.Router();
const analytics = require('../lib/analytics');

// Fail-soft wrapper — analytics errors shouldn't block UX
async function safely(fn, res, label) {
  try {
    const result = await fn();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[analytics] ${label} error:`, err.message);
    res.json({ ok: false, error: err.message });
  }
}

// POST /screen  { sessionId, screenId, userAgent, referrer, source? }
// Upserts the session row and appends to screen history. Source-Felder
// werden mitgeschrieben wenn der Client sie liefert (von source.js).
router.post('/screen', async (req, res) => {
  const { sessionId, screenId, userAgent, referrer, source } = req.body || {};
  if (!sessionId || !screenId) return res.status(400).json({ ok: false, error: 'sessionId and screenId required' });
  if (!analytics.isConfigured()) return res.json({ ok: false, skipped: true });

  return safely(async () => {
    const meta = {};
    if (userAgent) meta.UserAgent = userAgent.substring(0, 500);
    if (referrer) meta.Referrer = referrer;
    if (source && source.classification) {
      meta.Source = source.classification;
      if (source.utmSource)   meta.UtmSource   = String(source.utmSource).slice(0, 255);
      if (source.utmMedium)   meta.UtmMedium   = String(source.utmMedium).slice(0, 255);
      if (source.utmCampaign) meta.UtmCampaign = String(source.utmCampaign).slice(0, 255);
      if (source.utmContent)  meta.UtmContent  = String(source.utmContent).slice(0, 255);
      if (source.utmTerm)     meta.UtmTerm     = String(source.utmTerm).slice(0, 255);
      const clickId = source.gclid || source.fbclid;
      if (clickId)            meta.ClickId     = String(clickId).slice(0, 255);
    }
    const record = await analytics.appendScreenToSession(sessionId, screenId, meta);
    return { recordId: record?.id };
  }, res, 'screen');
});

// POST /abort  { sessionId, reason, address? }
// Markiert die Session als abgebrochen mit Grund und (für outside_area) der
// eingegebenen Adresse. Wird heute von geo.js bei "außerhalb Einsatzgebiet"
// aufgerufen. Idempotent — gleicher Reason überschreibt nicht.
router.post('/abort', async (req, res) => {
  const { sessionId, reason, address } = req.body || {};
  if (!sessionId || !reason) return res.status(400).json({ ok: false, error: 'sessionId and reason required' });
  if (!analytics.isConfigured()) return res.json({ ok: false, skipped: true });

  return safely(async () => {
    const meta = { AbortReason: reason };
    if (address) meta.AbortedAddress = String(address).slice(0, 500);
    // Wir piggybacken auf appendScreenToSession — die Funktion macht ein
    // upsert via SessionID. screenId wird beim Abort als '_abort' getaggt
    // (taucht in ScreenHistory auf, damit die Sequenz klar bleibt).
    const record = await analytics.appendScreenToSession(sessionId, `_abort:${reason}`, meta);
    return { recordId: record?.id };
  }, res, 'abort');
});

module.exports = router;
