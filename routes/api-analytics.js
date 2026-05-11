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

// POST /screen  { sessionId, screenId, userAgent, referrer }
// Upserts the session row and appends to screen history.
router.post('/screen', async (req, res) => {
  const { sessionId, screenId, userAgent, referrer } = req.body || {};
  if (!sessionId || !screenId) return res.status(400).json({ ok: false, error: 'sessionId and screenId required' });
  if (!analytics.isConfigured()) return res.json({ ok: false, skipped: true });

  return safely(async () => {
    const meta = {};
    if (userAgent) meta.UserAgent = userAgent.substring(0, 500);
    if (referrer) meta.Referrer = referrer;
    const record = await analytics.appendScreenToSession(sessionId, screenId, meta);
    return { recordId: record?.id };
  }, res, 'screen');
});

module.exports = router;
