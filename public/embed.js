/**
 * SpoxHub Booking — Embed Loader
 *
 * Verwendung auf der Partner-Seite:
 *
 *   <div id="spoxhub-booking"></div>
 *   <script src="https://spoxhub.io/booking/embed.js"
 *           data-target="#spoxhub-booking"
 *           data-min-height="700"
 *           async></script>
 *
 * Optional kann der src auch ohne data-target geladen werden — dann fügt der
 * Loader das iframe direkt nach dem <script>-Tag ein.
 *
 * Auto-Resize: das iframe passt sich der Inhaltshöhe automatisch an
 * (postMessage von iframe-bridge.js im Booking-Tool).
 */
(function () {
  const script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  if (!script) return;

  // Base URL aus dem src des Scripts ableiten — funktioniert für jeden Host.
  const baseUrl = script.src.replace(/\/embed\.js(\?.*)?$/, '');

  // Container bestimmen: data-target Selector oder direkt nach Script
  let container = null;
  if (script.dataset.target) {
    container = document.querySelector(script.dataset.target);
  }
  if (!container) {
    container = document.createElement('div');
    container.id = 'spoxhub-booking-' + Math.random().toString(36).slice(2, 8);
    script.parentNode.insertBefore(container, script.nextSibling);
  }

  // Iframe erzeugen
  const minHeight = parseInt(script.dataset.minHeight || '700', 10);
  const iframe = document.createElement('iframe');
  iframe.src = baseUrl + '/';
  iframe.title = 'Termin buchen — SpoxHub';
  iframe.allow = 'payment *; clipboard-write';
  iframe.loading = 'lazy';
  iframe.style.cssText = [
    'width: 100%',
    'border: 0',
    'display: block',
    'background: transparent',
    'min-height: ' + minHeight + 'px'
  ].join(';');
  container.appendChild(iframe);

  // PostMessage-Listener — Höhe anpassen, optional zur iframe-Spitze scrollen
  let lastNavigateAt = 0;
  window.addEventListener('message', function (e) {
    const data = e.data;
    if (!data || data.source !== 'spoxhub-booking') return;

    if (data.type === 'height' && typeof data.height === 'number') {
      iframe.style.height = Math.max(minHeight, Math.ceil(data.height)) + 'px';
    }

    if (data.type === 'redirect-top' && typeof data.url === 'string') {
      // Booking abgeschlossen → Top-Window (Partner-Seite) zur Danke-Seite leiten.
      try {
        const safe = new URL(data.url, window.location.href);
        // Nur http/https zulassen
        if (safe.protocol === 'http:' || safe.protocol === 'https:') {
          window.top.location.href = safe.href;
        }
      } catch (_) { /* ignore malformed URL */ }
      return;
    }

    if (data.type === 'navigate') {
      // Bei Screen-Wechsel: iframe-Top in den Viewport scrollen, damit der
      // Kunde den neuen Screen sofort sieht (auch wenn der vorherige Screen
      // gescrollt war).
      const now = Date.now();
      if (now - lastNavigateAt < 300) return; // throttle
      lastNavigateAt = now;
      const rect = iframe.getBoundingClientRect();
      if (rect.top < 0) {
        window.scrollTo({
          top: window.scrollY + rect.top - 20,
          behavior: 'smooth'
        });
      }
    }
  });
})();
