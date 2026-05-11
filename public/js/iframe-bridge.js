/**
 * Iframe Bridge — kommuniziert mit dem Parent-Fenster, wenn das Booking-Tool
 * via <iframe> eingebettet ist. Idle, wenn standalone geladen.
 *
 * Outgoing messages (zu window.parent):
 *   { source: 'spoxhub-booking', type: 'height', height: <px> }
 *   { source: 'spoxhub-booking', type: 'navigate', screen: <id> }
 */

(function () {
  if (window.parent === window) return; // standalone, nichts zu tun

  let lastHeight = 0;

  function postHeight() {
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    if (Math.abs(h - lastHeight) < 3) return; // dampening
    lastHeight = h;
    try {
      window.parent.postMessage(
        { source: 'spoxhub-booking', type: 'height', height: h },
        '*'
      );
    } catch (_) { /* ignore */ }
  }

  function postNavigate(screenId) {
    try {
      window.parent.postMessage(
        { source: 'spoxhub-booking', type: 'navigate', screen: screenId },
        '*'
      );
    } catch (_) { /* ignore */ }
  }

  // ResizeObserver: re-emit on any layout change
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => postHeight());
    ro.observe(document.body);
  }

  // Fallback for older browsers + window resize
  window.addEventListener('resize', postHeight);
  window.addEventListener('load',   postHeight);

  // Hook into flow.js screen changes
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(postHeight, 200);

    // Wrap flowShow if it exists (loaded after this script)
    if (typeof window.flowShow === 'function' && !window.flowShow.__iframeWrapped) {
      const original = window.flowShow;
      window.flowShow = function (idx, dir) {
        const r = original(idx, dir);
        setTimeout(() => {
          const active = document.querySelector('.screen-panel:not(.is-hidden)');
          if (active) postNavigate(active.dataset.screen);
          postHeight();
        }, 50);
        setTimeout(postHeight, 400); // catch animation end
        return r;
      };
      window.flowShow.__iframeWrapped = true;
    }
  });

  // Periodic safety net (covers cases the observers miss)
  setInterval(postHeight, 2000);
})();
