/**
 * Embed-Router — Endpoints für das WordPress-Plugin.
 *
 *   GET /embed/markup   → HTML-Fragment des Wizards (zum Einsetzen ins WP-DOM)
 *   GET /embed/config   → JSON mit clientseitig benötigter Konfiguration
 *                        (PayPal-Client-ID, AGB/Privacy-URLs, Asset-Versionen)
 *   GET /embed/version  → Schlanker Healthcheck + Versions-Info
 *                        (für Plugin-Update-Notice und Cache-Busting)
 */
const express = require('express');
const router = express.Router();
const pkg = require('../package.json');

// /embed/markup ─ HTML-Fragment ohne <html>/<body>.
// Erwartet die gleichen Template-Variablen wie booking.ejs, weil
// ein paar Partials (z.B. 21-payment) AGB-/Privacy-URLs einsetzen.
// PayPal-Client-ID wird im Markup NICHT verwendet (SDK lädt das Plugin
// dynamisch nach), daher leerer Default.
router.get('/markup', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300'); // 5 Min Cache
  res.render('embed', {
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    agbUrl: process.env.AGB_URL || 'https://spoxhub.io/agb',
    privacyUrl: process.env.PRIVACY_URL || 'https://spoxhub.io/datenschutz'
  });
});

// /embed/config ─ Public-Config für JS-Frontend
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');

  // PayPal-SDK-URL mit allen Standalone-Parametern.
  // ÄNDERUNGEN HIER reflektieren auch booking.ejs:80 (Standalone)
  // damit beide Frontends die gleichen SDK-Optionen haben.
  // Aktuell: SEPA ist deaktiviert (Geschäfts-Entscheidung).
  const paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
  const paypalSdkUrl = paypalClientId
    ? 'https://www.paypal.com/sdk/js'
      + '?client-id=' + encodeURIComponent(paypalClientId)
      + '&currency=EUR'
      + '&intent=capture'
      + '&disable-funding=sepa'
    : '';

  res.json({
    version: pkg.version,
    paypalClientId,
    paypalSdkUrl,
    paypalMode: process.env.PAYPAL_MODE || 'sandbox',
    agbUrl: process.env.AGB_URL || 'https://spoxhub.io/agb',
    privacyUrl: process.env.PRIVACY_URL || 'https://spoxhub.io/datenschutz',
    // Liste der Frontend-Scripts in der Reihenfolge, in der sie geladen werden
    // müssen. Plugin enqueued sie 1:1. Pfad ist relativ zum API-Base.
    scripts: [
      'js/state.js',
      'js/analytics.js',
      'js/sidebar-updater.js',
      'js/geo.js',
      'js/brands.js',
      'js/leasing.js',
      'js/customer-form.js',
      'js/catalog.js',
      'js/upload.js',
      'js/booking.js',
      'js/payment.js',
      'js/flow.js' // muss zuletzt geladen werden
    ],
    styles: [
      // WICHTIG: output.embed.css (gescoped unter .spoxhub-booking, ohne Preflight),
      // NICHT output.css — letztere würde mit dem WP-Theme kollidieren.
      'css/output.embed.css'
    ]
  });
});

// /embed/version ─ Schlanker Healthcheck (für Plugin-Settings-Page)
router.get('/version', (req, res) => {
  res.json({ ok: true, version: pkg.version, name: pkg.name });
});

module.exports = router;
