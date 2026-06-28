/**
 * Traffic-Source-Erkennung (Last-Touch-Attribution).
 *
 * Klassifiziert die Quelle eines Besuchs in {adwords | meta_ads | organisch |
 * direkt | sonstige}. Schreibt das Ergebnis ins `BookingState.source`.
 *
 * Funktioniert standalone (spoxhub.io/booking/) UND im WP-Plugin-Inline-
 * Embedding (kein iframe), weil das Booking-Tool dort als Inline-Skript der
 * WP-Seite läuft und damit dieselbe URL/Referrer sieht wie der WP-Host.
 *
 * Erkennungs-Quellen, in dieser Reihenfolge (erster qualifizierter Treffer
 * gewinnt, schwächere Signale werden überschrieben wenn stärkere da sind):
 *
 *   1. window.location.href  — UTM/click-ids in der aktuellen URL
 *   2. document.referrer     — UTM/click-ids in der Vor-Seite (z.B. wenn der
 *                              User zuerst auf radblitz.de/?gclid=… landet
 *                              und dann zur Buchung navigiert)
 *   3. document.referrer     — Host (Search Engine? Social Media?)
 *   4. localStorage          — Last-Touch der letzten 30 Tage (für In-App-
 *                              Browser ohne referrer + für mehrtägige Funnels)
 *
 * Klassifikations-Regeln (qualifiziert = adwords/meta_ads/organisch):
 *   - gclid in URL/Referrer    → adwords
 *   - fbclid in URL/Referrer   → meta_ads
 *   - utm_source=google + utm_medium in {cpc,ppc,paidsearch,paid_search} → adwords
 *   - utm_source in {facebook,instagram,…} + utm_medium "bezahlt-artig" → meta_ads
 *   - Referrer-Host facebook/instagram/m.facebook → meta_ads (organisch)
 *   - Referrer-Host google/bing/… → organisch
 *   - sonstige UTMs gesetzt → sonstige
 *   - Kein Referrer, keine UTM, kein localStorage → direkt
 */
(function () {
  if (typeof BookingState === 'undefined') return;

  const STORAGE_KEY = 'spoxhub_source_v1';
  const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage Last-Touch-Fenster
  const DEBUG = /[?&]source-debug=1/.test(window.location.search);

  const META_SOURCES    = ['facebook', 'instagram', 'fb', 'ig', 'meta'];
  const META_MEDIUMS    = ['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial',
                           'social-cpc', 'social-paid', 'display', 'paid-social'];
  const ADWORDS_MEDIUMS = ['cpc', 'ppc', 'paidsearch', 'paid_search', 'paid-search'];
  const SEARCH_HOSTS    = ['google.', 'bing.', 'duckduckgo.', 'yandex.', 'ecosia.', 'qwant.', 'yahoo.'];
  const META_HOSTS      = ['facebook.', 'instagram.', 'm.facebook.', 'l.facebook.',
                           'l.instagram.', 'lm.facebook.', 'fb.com', 'fb.me'];

  // ─── Parse helpers ────────────────────────────────────────────────────────

  function parseSignals(urlStr) {
    let url;
    try { url = new URL(urlStr, window.location.origin); } catch { return null; }
    const p = url.searchParams;
    const get = k => (p.get(k) || '').trim().toLowerCase();
    return {
      utmSource:   get('utm_source')   || null,
      utmMedium:   get('utm_medium')   || null,
      utmCampaign: get('utm_campaign') || null,
      utmContent:  get('utm_content')  || null,
      utmTerm:     get('utm_term')     || null,
      gclid:       get('gclid')        || null,
      fbclid:      get('fbclid')       || null
    };
  }

  function isExternalHost(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.host === window.location.host) return null;
      return u.host.toLowerCase();
    } catch { return null; }
  }

  function hostStartsWithAny(host, prefixes) {
    if (!host) return false;
    return prefixes.some(p => host.includes(p));
  }

  // ─── Classification ───────────────────────────────────────────────────────
  // signals: bereits aufgelöste UTMs / click-ids (oder leer)
  // referrerHost: extern, oder null
  function classify(signals, referrerHost) {
    const s = signals || {};
    if (s.gclid)  return { classification: 'adwords', reasoning: 'gclid' };
    if (s.fbclid) return { classification: 'meta_ads', reasoning: 'fbclid' };
    if (s.utmSource === 'google' && ADWORDS_MEDIUMS.includes(s.utmMedium)) {
      return { classification: 'adwords', reasoning: `utm:${s.utmSource}/${s.utmMedium}` };
    }
    if (META_SOURCES.includes(s.utmSource) && META_MEDIUMS.includes(s.utmMedium)) {
      return { classification: 'meta_ads', reasoning: `utm:${s.utmSource}/${s.utmMedium}` };
    }
    if (referrerHost) {
      if (hostStartsWithAny(referrerHost, META_HOSTS)) {
        return { classification: 'meta_ads', reasoning: `ref:${referrerHost}` };
      }
      if (hostStartsWithAny(referrerHost, SEARCH_HOSTS)) {
        return { classification: 'organisch', reasoning: `ref:${referrerHost}` };
      }
    }
    if (s.utmSource || s.utmMedium || s.utmCampaign) {
      return { classification: 'sonstige', reasoning: `utm:${s.utmSource || '?'}/${s.utmMedium || '?'}` };
    }
    return null; // kein qualifiziertes Signal — Aufrufer entscheidet (cache oder direkt)
  }

  // ─── Resolve: combine signals from multiple sources ───────────────────────

  function resolveSource() {
    const referrer = (document.referrer || '').trim();
    const refHost  = isExternalHost(referrer);
    const debug    = [];

    // 1. Signale aus aktueller URL
    const urlSignals = parseSignals(window.location.href);
    debug.push(`url:${JSON.stringify(urlSignals)}`);
    let cls = classify(urlSignals, refHost);
    if (cls) {
      debug.push(`→ ${cls.classification} via ${cls.reasoning}`);
      return finalize(cls, urlSignals, referrer, debug);
    }

    // 2. Signale aus Referrer-URL parsen (UTMs der Landing-Page)
    const refSignals = referrer ? parseSignals(referrer) : null;
    debug.push(`refSignals:${JSON.stringify(refSignals)}`);
    if (refSignals) {
      cls = classify(refSignals, refHost);
      if (cls) {
        debug.push(`→ ${cls.classification} via referrer-${cls.reasoning}`);
        return finalize(cls, refSignals, referrer, debug);
      }
    }

    // 3. Referrer-Host allein (search/social)
    cls = classify({}, refHost);
    if (cls) {
      debug.push(`→ ${cls.classification} via ${cls.reasoning}`);
      return finalize(cls, {}, referrer, debug);
    }

    // 4. localStorage-Last-Touch (Cross-Session-Persistenz)
    const stored = readStorage();
    if (stored) {
      debug.push(`→ ${stored.classification} via storage (age ${Math.round((Date.now() - new Date(stored.detectedAt).getTime()) / 3600000)}h)`);
      return Object.assign({}, stored, { fromStorage: true, debug: DEBUG ? debug : undefined });
    }

    // 5. Default: direkt
    debug.push(`→ direkt (no signals)`);
    return finalize({ classification: 'direkt', reasoning: 'no-signals' }, {}, referrer, debug);
  }

  function finalize(cls, signals, referrer, debug) {
    const out = {
      classification: cls.classification,
      utmSource:   signals.utmSource   || null,
      utmMedium:   signals.utmMedium   || null,
      utmCampaign: signals.utmCampaign || null,
      utmContent:  signals.utmContent  || null,
      utmTerm:     signals.utmTerm     || null,
      gclid:       signals.gclid       || null,
      fbclid:      signals.fbclid      || null,
      referrer:    referrer            || null,
      detectedAt:  new Date().toISOString(),
      pageUrl:     window.location.href,
      reasoning:   cls.reasoning,
      debug:       DEBUG ? debug : undefined
    };
    // qualifizierte Sources (alles außer direkt/sonstige) cachen
    if (['adwords', 'meta_ads', 'organisch'].includes(cls.classification)) {
      writeStorage(out);
    }
    return out;
  }

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const ageMs = Date.now() - new Date(obj.detectedAt).getTime();
      if (ageMs > TTL_MS) return null;
      return obj;
    } catch { return null; }
  }

  function writeStorage(obj) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch {}
  }

  // ─── Main ─────────────────────────────────────────────────────────────────
  // Last-Touch: Wenn die aktuelle URL ODER der Referrer ein qualifiziertes
  // Signal (gclid/fbclid/UTM/social-referrer) hat, wird es immer übernommen
  // — auch wenn schon eine andere Klassifikation im State steht.
  // Wenn nur "schwach" (direkt/sonstige), respektieren wir existing.

  const existing = BookingState.get('source');
  const fresh = resolveSource();

  let chosen = fresh;
  if (existing && existing.classification) {
    const freshStrong = ['adwords', 'meta_ads', 'organisch'].includes(fresh.classification) && !fresh.fromStorage;
    if (!freshStrong) chosen = existing; // existing behalten
  }
  BookingState.set('source', chosen);

  // ─── Logging + Debug-Banner ───────────────────────────────────────────────
  console.log('[source]', chosen.classification, chosen.reasoning ? `via ${chosen.reasoning}` : '', chosen.fromStorage ? '(localStorage)' : '');

  if (DEBUG) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#3d0046;color:#e8ff00;font:12px/1.4 monospace;padding:8px 12px;z-index:99999;border-top:2px solid #e8ff00;max-height:40vh;overflow:auto;';
    banner.textContent = `[source-debug] ${chosen.classification} via ${chosen.reasoning || 'n/a'} ${chosen.fromStorage ? '(from localStorage)' : ''}\n` +
      `referrer: ${document.referrer || '(none)'}\n` +
      `url-params: ${window.location.search || '(none)'}\n` +
      `debug-trace: ${(fresh.debug || []).join(' | ')}`;
    banner.style.whiteSpace = 'pre-wrap';
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner));
  }
})();
