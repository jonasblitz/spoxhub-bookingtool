/**
 * Auth-Endpoints fürs Kunden-Login.
 *
 *   POST /api/auth/lookup       — prüft ob die Email einem Bestandskunden
 *                                 in eTermin/Airtable entspricht. Antwort
 *                                 enthält den Vornamen für die UI-Begrüßung,
 *                                 ABER startet noch keinen Login.
 *   POST /api/auth/magic-link   — löst Supabase signInWithOtp aus.
 *                                 Erzeugt auth.users-Row falls nicht
 *                                 vorhanden (signInWithOtp ist passwordless).
 *   GET  /auth/callback         — landet hier nach Magic-Link-Klick.
 *                                 Supabase schiebt access_token + refresh_token
 *                                 als URL-Hash. Wir rendern eine kleine HTML-
 *                                 Page, die den Hash parst, in localStorage
 *                                 schreibt und auf den Wizard zurückleitet.
 *   POST /api/auth/logout       — invalidiert das Token. Frontend räumt
 *                                 zusätzlich seinen localStorage auf.
 */

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const etermin = require('../lib/etermin');

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}

function publicBaseUrl(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, '');
  const baseUrl = (req.baseUrl || '').replace(/\/api.*$/, '');
  return `${req.protocol}://${req.get('host')}${baseUrl}`.replace(/\/$/, '');
}

async function findAirtableCustomerByEmail(email) {
  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table  = process.env.AIRTABLE_CUSTOMERS_TABLE;
  if (!token || !baseId || !table) return null;
  const filter = `LOWER({Email})='${escapeFormulaString(email.toLowerCase())}'`;
  const params = `?filterByFormula=${encodeURIComponent(filter)}&pageSize=1`;
  const r = await fetch(`${AIRTABLE_BASE_URL}/${baseId}/${table}${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.records?.[0] || null;
}

// ─── POST /api/auth/lookup ──────────────────────────────────────────────────
//
// Body: { email: string }
// Returns: { existsAsContact: bool, firstName: string|null, source: 'airtable'|'etermin'|null }

router.post('/lookup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email required' });
  }
  try {
    const [atCustomer, etContact] = await Promise.all([
      findAirtableCustomerByEmail(email).catch(() => null),
      etermin.findContactByEmail(email).catch(() => null)
    ]);
    if (atCustomer) {
      return res.json({
        existsAsContact: true,
        firstName: atCustomer.fields?.Vorname || atCustomer.fields?.Nachname || null,
        source: 'airtable'
      });
    }
    if (etContact) {
      return res.json({
        existsAsContact: true,
        firstName: etContact.FirstName || etContact.LastName || null,
        source: 'etermin'
      });
    }
    res.json({ existsAsContact: false, firstName: null, source: null });
  } catch (err) {
    console.error('[auth] lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/magic-link ─────────────────────────────────────────────
//
// Body: { email: string }
// Schickt einen Magic-Link an die Email. Antwortet immer "ok" auch wenn
// die Email keinen User hat (Anti-Enumeration).

router.post('/magic-link', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!supabase.isConfigured()) {
    return res.status(503).json({ error: 'auth not configured on server' });
  }
  try {
    const authClient = supabase.getAuthClient();
    const emailRedirectTo = `${publicBaseUrl(req)}/api/auth/callback`;
    const { error } = await authClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo, shouldCreateUser: true }
    });
    if (error) {
      // Mailer-Fehler im Server-Log, dem Browser nur "ok" zurück melden
      console.error('[auth] signInWithOtp error:', error.message);
    }
    res.json({ ok: true, message: 'Wenn ein Konto existiert (oder erstellt werden kann), bekommst du in Kürze eine E-Mail.' });
  } catch (err) {
    console.error('[auth] magic-link error:', err);
    res.json({ ok: true }); // bewusst kein Detail rausgeben
  }
});

// ─── GET /auth/callback ────────────────────────────────────────────────────
//
// Supabase verifiziert den Magic-Link-Token und redirected hierher mit
// URL-Fragment (#access_token=...). Das Fragment ist client-side; daher
// rendern wir eine kleine HTML-Page die das Fragment parst, das Token
// in localStorage schreibt und auf den Wizard zurückleitet.

router.get('/callback', (req, res) => {
  const baseUrl = publicBaseUrl(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Anmeldung läuft …</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #222; }
    .box { background: #fff; padding: 2rem 2.5rem; border-radius: 0.75rem; box-shadow: 0 4px 16px rgba(0,0,0,0.05); text-align: center; max-width: 26rem; }
    .err { color: #c00; }
  </style>
</head>
<body>
  <div class="box">
    <h1 id="title">Anmeldung läuft …</h1>
    <p id="msg">Einen kleinen Moment bitte.</p>
  </div>
  <script>
    (function () {
      const hash = (window.location.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const access  = params.get('access_token');
      const refresh = params.get('refresh_token');
      const errorDesc = params.get('error_description') || params.get('error');
      const target = ${JSON.stringify(baseUrl)} + '/';
      if (errorDesc) {
        document.getElementById('title').textContent = 'Anmeldung fehlgeschlagen';
        document.getElementById('title').className = 'err';
        document.getElementById('msg').textContent = decodeURIComponent(errorDesc);
        return;
      }
      if (!access) {
        document.getElementById('msg').textContent = 'Kein Token erhalten — bitte erneut versuchen.';
        return;
      }
      try {
        localStorage.setItem('booking_jwt', access);
        if (refresh) localStorage.setItem('booking_refresh', refresh);
      } catch (e) {
        document.getElementById('title').className = 'err';
        document.getElementById('msg').textContent = 'Browser blockiert localStorage — Login nicht möglich.';
        return;
      }
      window.location.replace(target);
    })();
  </script>
</body>
</html>`);
});

// ─── GET /api/auth/oauth-popup ─────────────────────────────────────────────
//
// Startet einen OAuth-Flow, der für einen Popup-Kontext gedacht ist:
// nach erfolgreichem Login landet der Browser auf /api/auth/popup-callback,
// das den Token per postMessage an window.opener sendet und das Fenster
// schließt.
//
// Wird vom iframe-embedded Booking-Tool benutzt: window.open('…/oauth-popup?
// provider=google') → Popup läuft OAuth → schickt Token zurück → iframe
// speichert Token und lädt Profil. Der WP-Wrapper bleibt unangetastet.
//
// Query: ?provider=google|apple (whitelist — sonst 400)

router.get('/oauth-popup', async (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase();
  if (!['google', 'apple'].includes(provider)) {
    return res.status(400).send('unsupported provider');
  }
  if (!supabase.isConfigured()) {
    return res.status(503).send('auth not configured');
  }
  try {
    const client = supabase.getAuthClient();
    const redirectTo = `${publicBaseUrl(req)}/api/auth/popup-callback`;
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true }
    });
    if (error || !data?.url) {
      console.error('[auth] oauth-popup start error:', error?.message || 'no url');
      return res.status(500).send('oauth start failed');
    }
    // Direkt zum Google/Apple-OAuth-Endpoint weiterleiten
    res.redirect(302, data.url);
  } catch (err) {
    console.error('[auth] oauth-popup error:', err);
    res.status(500).send(err.message);
  }
});

// ─── GET /api/auth/popup-callback ──────────────────────────────────────────
//
// Landing-Page nach dem OAuth-Login im Popup. Extrahiert Token aus
// URL-Hash, postMessage an window.opener + self.close().
// Fallback (kein opener oder postMessage klappt nicht): Redirect zur
// Booking-Tool-Startseite mit Token in localStorage.

router.get('/popup-callback', (req, res) => {
  const baseUrl = publicBaseUrl(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Anmeldung läuft …</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #3d0046; color: #fff; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .box { background:#5a0064; padding:2rem 2.5rem; border-radius:16px; text-align:center; max-width:26rem; border:1px solid #7d3386; }
    .box strong { color:#e8ff00; }
    .err { color:#ff8080; }
  </style>
</head>
<body>
  <div class="box">
    <h1 id="title">Anmeldung läuft …</h1>
    <p id="msg">Einen kleinen Moment, dann schließt sich das Fenster.</p>
  </div>
  <script>
    (function () {
      const hash = (window.location.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const access  = params.get('access_token');
      const refresh = params.get('refresh_token');
      const errorDesc = params.get('error_description') || params.get('error');
      const targetOrigin = ${JSON.stringify(baseUrl.match(/^https?:\/\/[^/]+/)?.[0] || '*')};

      function show(kind, text) {
        document.getElementById('title').textContent = kind === 'err' ? 'Anmeldung fehlgeschlagen' : 'Fertig!';
        document.getElementById('title').className = kind;
        document.getElementById('msg').textContent = text;
      }

      if (errorDesc) return show('err', decodeURIComponent(errorDesc));
      if (!access)   return show('err', 'Kein Token erhalten.');

      // 1. localStorage (auch für den Fallback: iframe kann später darauf zugreifen,
      //    weil Popup und iframe dieselbe spoxhub.io-Origin haben)
      try {
        localStorage.setItem('booking_jwt', access);
        if (refresh) localStorage.setItem('booking_refresh', refresh);
      } catch (e) { /* ignore */ }

      // 2. postMessage an opener (das ist das iframe-Fenster, ebenfalls spoxhub.io-Origin)
      let sent = false;
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            type: 'spoxhub-auth/login',
            access_token: access,
            refresh_token: refresh || null
          }, targetOrigin);
          sent = true;
        }
      } catch (_) {}

      // 3. Kurzer Feedback und dann schließen (oder Redirect als Fallback)
      show('ok', sent ? 'Login geklappt — dieses Fenster schließt sich gleich.' : 'Weiterleiten …');
      setTimeout(() => {
        try { window.close(); } catch (_) {}
        // Wenn Fenster nicht schließbar (kein opener oder Browser blockiert) → redirect
        if (!window.closed) {
          window.location.replace(${JSON.stringify(baseUrl)} + '/');
        }
      }, sent ? 400 : 800);
    })();
  </script>
</body>
</html>`);
});

// ─── POST /api/auth/logout ─────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  // Server-side: kein zwingender Call nötig, weil JWTs stateless sind. Wir
  // versuchen aber Supabase signOut für das vorhandene Token, damit der
  // Refresh-Token entwertet wird.
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (token && supabase.isConfigured()) {
    try {
      const client = supabase.getAuthClient();
      // setSession ist sync-ähnlich; signOut akzeptiert kein Token-Arg direkt,
      // daher: invalidate via Admin
      const admin = supabase.getAdminClient();
      const { data } = await client.auth.getUser(token);
      if (data?.user?.id) {
        await admin.auth.admin.signOut(data.user.id, 'global');
      }
    } catch (err) {
      console.warn('[auth] logout signOut warn:', err.message);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
