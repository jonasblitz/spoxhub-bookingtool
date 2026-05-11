/**
 * Analytics — session + screen tracking.
 *
 * Stores a per-tab sessionId in sessionStorage and sends a fire-and-forget
 * POST on every screen entry. Failures are silent (analytics should never
 * block the UX).
 */

(function () {
  const STORAGE_KEY = 'spoxhub_session_id';

  function getSessionId() {
    let sid = sessionStorage.getItem(STORAGE_KEY);
    if (!sid) {
      sid = 'sess-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem(STORAGE_KEY, sid);
    }
    return sid;
  }

  // Expose for booking state → so the confirm endpoint can update session
  window.getAnalyticsSessionId = getSessionId;

  let lastSentScreen = null;

  window.trackScreen = function trackScreen(screenId) {
    if (!screenId || screenId === lastSentScreen) return;
    lastSentScreen = screenId;

    const payload = {
      sessionId: getSessionId(),
      screenId,
      userAgent: navigator.userAgent,
      referrer: document.referrer || ''
    };

    try {
      fetch(API_BASE + '/api/analytics/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify(payload)
      }).catch(() => { /* ignore */ });
    } catch (_) { /* ignore */ }
  };
})();
