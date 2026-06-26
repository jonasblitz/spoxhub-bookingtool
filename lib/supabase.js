/**
 * Supabase-Client für das Booking-Tool.
 *
 * Zwei Clients, weil die Verwendungszwecke unterschiedliche Privilegien haben:
 *
 *   adminClient  — mit SUPABASE_SERVICE_ROLE_KEY. Hebt RLS aus. Wird für
 *                  Server-side Reads/Writes auf public.* benutzt (Profile-
 *                  Bridge, Customer-Lookup, etc.). NIEMALS im Browser-Code
 *                  oder in einer Response landen lassen.
 *
 *   authClient   — mit SUPABASE_ANON_KEY. Für Auth-Operationen wie
 *                  signInWithOtp (Magic Link) und das Validieren eines
 *                  Browser-JWT (auth.getUser).
 *
 * Lazy-init: clients werden erst beim ersten Zugriff erstellt; ohne ENV-
 * Konfiguration wird ein klarer Fehler geworfen. So bleibt das Booking-
 * Tool ohne Supabase-Setup grundsätzlich startfähig (alle anderen Routes
 * unberührt).
 */

const { createClient } = require('@supabase/supabase-js');

let _admin = null;
let _auth  = null;

function readEnv() {
  const url      = process.env.SUPABASE_URL;
  const anonKey  = process.env.SUPABASE_ANON_KEY;
  const roleKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, anonKey, roleKey };
}

function isConfigured() {
  const { url, anonKey, roleKey } = readEnv();
  return !!(url && anonKey && roleKey);
}

/**
 * Service-Role-Client (RLS-bypass). Für Server-side-Zugriff auf public.*.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getAdminClient() {
  if (_admin) return _admin;
  const { url, roleKey } = readEnv();
  if (!url || !roleKey) {
    throw new Error('Supabase admin client not configured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
  }
  _admin = createClient(url, roleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return _admin;
}

/**
 * Anon-Client für Auth-Operationen (Magic Link, JWT-Verify).
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getAuthClient() {
  if (_auth) return _auth;
  const { url, anonKey } = readEnv();
  if (!url || !anonKey) {
    throw new Error('Supabase auth client not configured: SUPABASE_URL or SUPABASE_ANON_KEY missing');
  }
  _auth = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return _auth;
}

module.exports = {
  isConfigured,
  getAdminClient,
  getAuthClient
};
