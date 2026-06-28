/**
 * Traffic-Source-Erkennung (Last-Touch-Attribution).
 *
 * Liest beim Boot Query-Parameter (utm_*, gclid, fbclid) und document.referrer
 * der AKTUELLEN Seite, klassifiziert in {adwords | meta_ads | organisch |
 * direkt | sonstige} und schreibt das Ergebnis ins `BookingState.source`.
 *
 * Funktioniert standalone (spoxhub.io/booking/) UND im WP-Plugin-Inline-
 * Embedding (kein iframe), weil das Booking-Tool dort als Inline-Skript der
 * WP-Seite läuft und damit dieselbe URL/Referrer sieht wie der WP-Host.
 *
 * Last-Touch-Logik: Source wird einmal pro Wizard-Session (sessionStorage)
 * ermittelt. Bei Browser-Reload bleibt sie, beim Tab-Schließen+Öffnen wird
 * sie neu klassifiziert (typisches Verhalten für „neue Session").
 *
 * Erkennungs-Reihenfolge (erste Übereinstimmung gewinnt):
 *   1. gclid    → adwords
 *   2. fbclid   → meta_ads
 *   3. utm_source=google + utm_medium=cpc/ppc       → adwords
 *   4. utm_source=facebook|instagram + utm_medium=cpc|paid_social|… → meta_ads
 *   5. sonstige utm_* gesetzt                       → sonstige
 *   6. Referrer ist Search Engine (google/bing/…)   → organisch
 *   7. Kein Referrer ODER selbe Origin              → direkt
 *   8. Fallback                                     → sonstige
 */
(function () {
  if (typeof BookingState === 'undefined') return; // state.js muss vorher geladen sein

  // Wenn die Source schon im sessionStorage steht (vom vorigen Page-Load
  // desselben Tabs), respektieren — Last-Touch heißt "Source der Wizard-
  // Session", nicht "Source jedes einzelnen Reloads".
  const existing = BookingState.get('source');
  if (existing && existing.classification) return;

  const params = new URLSearchParams(window.location.search || '');
  const get = k => (params.get(k) || '').trim().toLowerCase();

  const utm = {
    source:   get('utm_source'),
    medium:   get('utm_medium'),
    campaign: get('utm_campaign'),
    content:  get('utm_content'),
    term:     get('utm_term')
  };
  const gclid  = get('gclid');
  const fbclid = get('fbclid');
  const referrer = (document.referrer || '').trim();

  const META_SOURCES   = ['facebook', 'instagram', 'fb', 'ig', 'meta'];
  const META_MEDIUMS   = ['cpc', 'ppc', 'paid_social', 'paidsocial', 'social-cpc', 'social-paid'];
  const ADWORDS_MEDIUMS = ['cpc', 'ppc', 'paidsearch', 'paid_search'];
  const SEARCH_ENGINES = ['google.', 'bing.', 'duckduckgo.', 'yandex.', 'ecosia.', 'qwant.', 'yahoo.'];

  function refHost() {
    try {
      if (!referrer) return null;
      const u = new URL(referrer);
      if (u.host === window.location.host) return null; // selbe Origin = nicht "extern"
      return u.host.toLowerCase();
    } catch { return null; }
  }
  const host = refHost();

  let classification = 'sonstige';
  if (gclid) classification = 'adwords';
  else if (fbclid) classification = 'meta_ads';
  else if (utm.source === 'google' && ADWORDS_MEDIUMS.includes(utm.medium)) classification = 'adwords';
  else if (META_SOURCES.includes(utm.source) && META_MEDIUMS.includes(utm.medium)) classification = 'meta_ads';
  else if (utm.source || utm.medium || utm.campaign) classification = 'sonstige';
  else if (host && SEARCH_ENGINES.some(s => host.includes(s))) classification = 'organisch';
  else if (!host) classification = 'direkt';

  const source = {
    classification,            // adwords | meta_ads | organisch | direkt | sonstige
    utmSource:    utm.source   || null,
    utmMedium:    utm.medium   || null,
    utmCampaign:  utm.campaign || null,
    utmContent:   utm.content  || null,
    utmTerm:      utm.term     || null,
    gclid:        gclid         || null,
    fbclid:       fbclid        || null,
    referrer:     referrer      || null,
    detectedAt:   new Date().toISOString(),
    pageUrl:      window.location.href
  };
  BookingState.set('source', source);
  console.log('[source]', classification, utm.source ? `(utm:${utm.source}/${utm.medium})` : (host ? `(ref:${host})` : ''));
})();
