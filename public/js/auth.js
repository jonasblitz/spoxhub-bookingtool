/**
 * Auth-Helper fürs Booking-Tool.
 *
 *  - Token-Persistenz in localStorage (Schlüssel `booking_jwt`)
 *  - `apiFetch(url, opts)` — Wrapper mit Authorization-Header
 *  - Login-Modal (Magic-Link-Flow): Email eingeben → Lookup → wenn
 *    Bestandskunde, „Hallo VORNAME, Link unterwegs" → Mail-Versand →
 *    User klickt Link in Mail → Browser landet auf /api/auth/callback →
 *    Token landet in localStorage → Wizard wird neu geladen.
 *  - `applyProfileToState()` — nach Login das Profil holen und
 *    BookingState.customer/bike vorbefüllen.
 *
 * Globale `Auth`-Schnittstelle:
 *   Auth.getToken() / setToken(t,r) / clearToken()
 *   Auth.apiFetch(url, opts)
 *   Auth.openLoginModal()
 *   Auth.logout()
 *   Auth.applyProfileToState()  → Promise<{ logged: bool, name: string|null }>
 *   Auth.renderBanner('#auth-banner')
 */

(function () {
  const TOKEN_KEY   = 'booking_jwt';
  const REFRESH_KEY = 'booking_refresh';

  // ─── OAuth Provider Toggle ────────────────────────────────────────────────
  // Aktivierte OAuth-Provider, in der Reihenfolge, in der sie im Login-
  // Modal angezeigt werden. Apple wieder einschalten: 'apple' an die Liste
  // anhängen. Voraussetzung: Provider ist auch im Supabase Dashboard
  // konfiguriert (Authentication → Sign In / Up).
  const OAUTH_PROVIDERS = ['google'];

  const PROVIDER_META = {
    google: {
      label: 'Mit Google fortfahren',
      svg: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.79 2.72v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.62z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.81.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.71H.96v2.34A9 9 0 0 0 9 18z"/>
        <path fill="#FBBC05" d="M3.95 10.71A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.71V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l2.99-2.34z"/>
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58A8.99 8.99 0 0 0 9 0 9 9 0 0 0 .96 4.95l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"/>
      </svg>`
    },
    apple: {
      label: 'Mit Apple fortfahren',
      svg: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
        <path d="M14.84 14.04c-.3.7-.66 1.34-1.08 1.94-.58.81-1.05 1.37-1.42 1.68-.56.51-1.17.78-1.81.8-.46 0-1.02-.13-1.66-.4-.65-.27-1.24-.4-1.78-.4-.57 0-1.18.13-1.83.4-.65.27-1.18.41-1.58.42-.62.02-1.24-.25-1.85-.82-.4-.34-.89-.92-1.48-1.74-.62-.88-1.14-1.9-1.54-3.06C.36 11.6.14 10.5.14 9.45c0-1.22.27-2.27.8-3.15a4.62 4.62 0 0 1 1.66-1.67 4.4 4.4 0 0 1 2.24-.63c.49 0 1.14.15 1.94.45.8.3 1.32.45 1.55.45.17 0 .74-.18 1.71-.53.92-.32 1.69-.46 2.32-.4 1.7.13 2.98.8 3.83 2.02-1.52.91-2.27 2.18-2.26 3.82.01 1.28.48 2.35 1.4 3.2.42.39.89.7 1.41.92-.11.32-.23.63-.36.92zM12.13 1.18c0 .91-.34 1.76-1.01 2.55-.8.94-1.78 1.48-2.83 1.4a2.8 2.8 0 0 1-.03-.34c0-.87.39-1.81 1.07-2.57.34-.39.78-.71 1.31-.97a3.7 3.7 0 0 1 1.45-.41c.01.12.04.23.04.34z"/>
      </svg>`
    }
  };

  // ─── Supabase Browser-Client (für OAuth) ─────────────────────────────────
  // Wird nur initialisiert, wenn die supabase-js-Library + Public-Werte da
  // sind. Bei fehlendem Setup bleiben OAuth-Buttons funktionslos — Magic
  // Link funktioniert weiter über die Booking-Tool-Backend-Endpoints.
  let _sb = null;
  function getSbClient() {
    if (_sb) return _sb;
    if (typeof window.supabase?.createClient !== 'function') return null;
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return null;
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return _sb;
  }

  // ─── Token-Storage ────────────────────────────────────────────────────────
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(access, refresh) {
    try {
      if (access)  localStorage.setItem(TOKEN_KEY, access);
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    } catch {}
  }
  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {}
  }

  // ─── apiFetch ─────────────────────────────────────────────────────────────
  async function apiFetch(url, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const tok = getToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    if (opts.body && !headers['Content-Type'] && typeof opts.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401 && tok) {
      // Token invalid/expired → wegschmeißen, Banner-Refresh
      clearToken();
      window.dispatchEvent(new CustomEvent('auth:changed'));
    }
    return res;
  }

  // ─── Profil laden + auf BookingState anwenden ─────────────────────────────
  async function applyProfileToState() {
    const tok = getToken();
    if (!tok || typeof BookingState === 'undefined') return { logged: false, name: null };

    let data;
    try {
      const r = await apiFetch('api/account/profile');
      if (!r.ok) return { logged: false, name: null };
      data = await r.json();
    } catch (err) {
      console.warn('[auth] profile fetch error:', err.message);
      return { logged: false, name: null };
    }

    // Customer-Stammdaten vorbefüllen — leere Felder im State überschreiben,
    // bereits gesetzte (vom User editierte) Felder respektieren
    const cust = BookingState.get('customer') || {};
    const next = Object.assign({}, cust, {
      vorname: cust.vorname || data.customer?.firstName || '',
      name:    cust.name    || data.customer?.lastName  || '',
      email:   cust.email   || data.contact?.email      || '',
      mobil:   cust.mobil   || data.contact?.phone      || '',
      strasse: cust.strasse || data.address?.street     || '',
      plz:     cust.plz     || data.address?.plz        || '',
      ort:     cust.ort     || data.address?.city       || ''
    });
    if (data.billing) {
      next.rechnungFirma   = cust.rechnungFirma   || data.billing.company || '';
      next.rechnungStrasse = cust.rechnungStrasse || data.billing.street  || '';
      next.rechnungPlz     = cust.rechnungPlz     || data.billing.plz     || '';
      next.rechnungOrt     = cust.rechnungOrt     || data.billing.city    || '';
    }
    BookingState.set('customer', next);

    // Letztes Fahrrad vorbefüllen (das erste in der Liste, sortiert nach
    // created_at desc auf Server-Seite)
    const bike = (data.bicycles || [])[0];
    if (bike) {
      const cur = BookingState.get('bike') || {};
      const nextBike = Object.assign({}, cur, {
        marke:          cur.marke          || bike.marke || '',
        modell:         cur.modell         || bike.modell || '',
        farbe:          cur.farbe          || bike.farbe || '',
        rahmennummer:   cur.rahmennummer   || bike.rahmennummer || '',
        leasing:        cur.leasing        || bike.leasing || '',
        leasingNr:      cur.leasingNr      || bike.leasingNr || '',
        versicherung:   cur.versicherung   || bike.versicherung || '',
        versicherungNr: cur.versicherungNr || bike.versicherungNr || ''
      });
      BookingState.set('bike', nextBike);
    }

    // Falls Customer/Bike-Screens schon im DOM gerendert sind (= User ist
    // schon auf Screen 02/11/14/17/18 als der Login durchläuft), die Inputs
    // direkt nachschieben. Auf neu betretenen Screens passiert das über
    // den OnEnter-Hook (flow.js).
    try { window.prefillFormFromState?.(); } catch {}
    try { window.prefillAddressFromState?.(); } catch {}

    return {
      logged: true,
      name: data.customer?.firstName || data.contact?.email || null,
      email: data.contact?.email || null
    };
  }

  async function logout() {
    const tok = getToken();
    if (tok) {
      try {
        await apiFetch('api/auth/logout', { method: 'POST' });
      } catch {}
    }
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:changed'));
    // Profil-Vorbefüllung im BookingState zurücksetzen (nicht zerstörerisch — nur
    // ein simples Reload bringt den State zurück).
    if (window.location && window.location.reload) window.location.reload();
  }

  // ─── Banner-Render ────────────────────────────────────────────────────────
  // Zeigt entweder "Schon Kunde? Einloggen" oder "Eingeloggt als VORNAME · Abmelden"
  async function renderBanner(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    const tok = getToken();
    if (!tok) {
      el.innerHTML = `
        <div class="auth-banner auth-banner--anon">
          <span>Du bist schon Kunde? <button type="button" class="auth-banner__login">Einloggen</button> oder Account anlegen und deine Daten übernehmen.</span>
        </div>`;
      el.querySelector('.auth-banner__login')?.addEventListener('click', openLoginModal);
      return;
    }
    // Eingeloggt — Profilfetch (cached durchs Browser ggf.)
    let name = null;
    try {
      const r = await apiFetch('api/account/profile');
      if (r.ok) {
        const d = await r.json();
        name = d.customer?.firstName || d.contact?.email || 'Konto';
      }
    } catch {}
    el.innerHTML = `
      <div class="auth-banner auth-banner--logged">
        <span>Eingeloggt als <strong>${name || 'Konto'}</strong></span>
        <button type="button" class="auth-banner__logout">Abmelden</button>
      </div>`;
    el.querySelector('.auth-banner__logout')?.addEventListener('click', logout);
  }

  // ─── OAuth ────────────────────────────────────────────────────────────────
  // Startet den OAuth-Redirect zu Google / Apple.
  //
  // Wir leiten den User zurück auf die AKTUELLE Page-URL (ohne Hash). Damit:
  //   1. Im standalone (spoxhub.io/booking/) landet er wieder auf der
  //      Booking-Seite — der Hash-Parser unten greift den Token raus.
  //   2. Im WP-Embed (radblitz.de/buchen/) bleibt er auf der WordPress-Seite —
  //      Token landet in localStorage von radblitz.de (derselben Origin wie
  //      die spätere Profil-/API-Calls), kein Cross-Origin-Bruch.
  //
  // Die alte Variante `${window.location.origin}${API_BASE}/api/auth/callback`
  // war broken im Embed-Setup: API_BASE ist dort absolut (z.B.
  // https://spoxhub.io/booking) und wurde doppelt-prefixiert mit der WP-
  // Origin → kaputte URL → Redirect schlug fehl.
  async function signInWithProvider(provider) {
    const sb = getSbClient();
    if (!sb) {
      console.warn('[auth] supabase-js not available — OAuth nicht möglich');
      return { error: 'supabase-js missing' };
    }
    const redirectTo = window.location.href.split('#')[0];
    console.log('[auth] OAuth start', provider, '→', redirectTo);
    const { data, error } = await sb.auth.signInWithOAuth({
      provider,                       // 'google' | 'apple'
      options: { redirectTo, skipBrowserRedirect: false }
    });
    if (error) console.error('[auth] OAuth start error:', error.message);
    return { data, error };
  }

  // ─── Hash-Parser (für OAuth-Returns auf der aktuellen Page) ─────────────
  // Supabase OAuth gibt den User mit `#access_token=…&refresh_token=…`
  // zurück. Wir greifen den Hash beim Boot ab, schreiben das Token in
  // localStorage, entfernen den Hash aus der URL und feuern ein
  // 'auth:changed'-Event, damit das Banner sich aktualisiert.
  function parseHashTokens() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    if (!hash.includes('access_token=')) return false;
    const p = new URLSearchParams(hash);
    const access  = p.get('access_token');
    const refresh = p.get('refresh_token');
    if (!access) return false;
    setToken(access, refresh);
    // Hash entfernen — schöner für den User und verhindert Re-Apply bei Reload
    try {
      const cleanUrl = window.location.pathname + window.location.search;
      history.replaceState(null, '', cleanUrl);
    } catch {}
    window.dispatchEvent(new CustomEvent('auth:changed'));
    console.log('[auth] hash-token captured, applied to localStorage');
    return true;
  }
  // Sofort beim Script-Load ausführen — vor jeglichem Render
  parseHashTokens();

  // ─── Login-Modal ──────────────────────────────────────────────────────────
  function openLoginModal() {
    if (document.getElementById('auth-modal')) return;
    const oauthEnabled = !!getSbClient();
    const modal = document.createElement('div');
    modal.id = 'auth-modal';
    modal.className = 'auth-modal';
    modal.innerHTML = `
      <div class="auth-modal__backdrop"></div>
      <div class="auth-modal__panel">
        <button type="button" class="auth-modal__close" aria-label="Schließen">×</button>
        <h2>Einloggen</h2>
        <p class="auth-modal__hint">Wir senden dir einen Login-Link per E-Mail. Kein Passwort nötig.</p>
        <form class="auth-modal__form">
          <label for="auth-modal-email">E-Mail-Adresse</label>
          <input id="auth-modal-email" type="email" required autocomplete="email" placeholder="dein.name@beispiel.de" />
          <button type="submit" class="auth-modal__submit">Login-Link senden</button>
          <div class="auth-modal__status" aria-live="polite"></div>
        </form>
        ${oauthEnabled && OAUTH_PROVIDERS.length ? `
          <div class="auth-modal__divider"><span>oder</span></div>
          <div class="auth-modal__oauth">
            ${OAUTH_PROVIDERS.map(p => {
              const m = PROVIDER_META[p];
              if (!m) return '';
              return `
                <button type="button" class="auth-modal__oauth-btn" data-provider="${p}">
                  ${m.svg}
                  <span>${m.label}</span>
                </button>`;
            }).join('')}
          </div>` : ''}
      </div>`;
    document.body.appendChild(modal);

    // OAuth-Buttons verkabeln
    modal.querySelectorAll('.auth-modal__oauth-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.provider;
        btn.disabled = true;
        const status = modal.querySelector('.auth-modal__status');
        if (status) status.textContent = `Leite weiter zu ${provider === 'google' ? 'Google' : 'Apple'} …`;
        const { error } = await signInWithProvider(provider);
        if (error) {
          if (status) status.textContent = `Fehler: ${error.message || error}`;
          btn.disabled = false;
        }
        // Erfolg → Browser redirected automatisch, Modal verschwindet danach.
      });
    });

    const close = () => modal.remove();
    modal.querySelector('.auth-modal__close').addEventListener('click', close);
    modal.querySelector('.auth-modal__backdrop').addEventListener('click', close);

    const form     = modal.querySelector('.auth-modal__form');
    const submit   = modal.querySelector('.auth-modal__submit');
    const statusEl = modal.querySelector('.auth-modal__status');
    const input    = modal.querySelector('#auth-modal-email');
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = input.value.trim().toLowerCase();
      if (!email || !email.includes('@')) {
        statusEl.textContent = 'Bitte gültige E-Mail eintragen.';
        return;
      }
      submit.disabled = true;
      statusEl.textContent = 'Prüfe …';
      try {
        const lookupR = await fetch('api/auth/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const lookup = lookupR.ok ? await lookupR.json() : { existsAsContact: false };
        if (lookup.existsAsContact && lookup.firstName) {
          statusEl.textContent = `Hallo ${lookup.firstName}, ich sende dir den Login-Link …`;
        } else if (lookup.existsAsContact) {
          statusEl.textContent = 'Bestandskunde erkannt — Login-Link unterwegs …';
        } else {
          statusEl.textContent = 'Login-Link unterwegs … (neuer Account wird angelegt)';
        }
        const sendR = await fetch('api/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        if (sendR.ok) {
          statusEl.innerHTML = `<strong>✓ E-Mail unterwegs.</strong> Schau in dein Postfach. Der Link öffnet diese Seite eingeloggt.`;
          submit.textContent = 'Erneut senden';
          submit.disabled = false;
        } else {
          statusEl.textContent = 'Versand fehlgeschlagen — bitte später erneut versuchen.';
          submit.disabled = false;
        }
      } catch (err) {
        statusEl.textContent = 'Netzwerk-Fehler — bitte später erneut versuchen.';
        submit.disabled = false;
      }
    });
  }

  // Auto-Banner bei "auth:changed" neu rendern (mehrere Banner gleichzeitig OK)
  window.addEventListener('auth:changed', () => {
    document.querySelectorAll('[data-auth-banner]').forEach(el => renderBanner('#' + el.id || ''));
  });

  window.Auth = {
    getToken, setToken, clearToken,
    apiFetch,
    openLoginModal, logout,
    signInWithProvider,
    applyProfileToState,
    renderBanner
  };
})();
