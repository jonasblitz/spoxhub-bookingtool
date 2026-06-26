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
    // schon auf Screen 11/14/17/18 als der Login durchläuft), die Inputs
    // direkt nachschieben. Auf neu betretenen Screens passiert das über
    // den OnEnter-Hook (flow.js).
    try { window.prefillFormFromState?.(); } catch {}

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

  // ─── Login-Modal ──────────────────────────────────────────────────────────
  function openLoginModal() {
    if (document.getElementById('auth-modal')) return;
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
      </div>`;
    document.body.appendChild(modal);

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
    applyProfileToState,
    renderBanner
  };
})();
