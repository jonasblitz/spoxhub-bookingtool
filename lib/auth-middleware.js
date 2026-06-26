/**
 * JWT-Verifikations-Middleware für authentifizierte Routen.
 *
 * Liest `Authorization: Bearer <jwt>` aus dem Request, ruft
 * `supabase.auth.getUser(token)` auf (das prüft signature + revocation
 * gegen die Supabase-Instanz, kein lokales Schlüssel-Caching nötig).
 *
 * Zwei Exports:
 *
 *   requireAuth        — 401 wenn kein gültiger Token. Für Account-Routen.
 *   optionalAuth       — setzt req.user falls Token vorhanden, sonst null.
 *                        Für Routen die mit ODER ohne Login funktionieren
 *                        (z.B. der Booking-Flow selbst — eingeloggter
 *                        User wird optional erkannt, anonym bleibt OK).
 *
 * req.user-Shape bei Erfolg: { id: 'uuid', email: 'jon@example.com' }.
 */

const supabase = require('./supabase');

function extractToken(req) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await supabase.getAuthClient().auth.getUser(token);
    if (error) return null;
    const u = data?.user;
    if (!u?.id) return null;
    return { id: u.id, email: u.email || null };
  } catch (err) {
    console.warn('[auth] verify error:', err.message);
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'authentication required' });
  }
  verifyToken(token).then(user => {
    if (!user) return res.status(401).json({ error: 'invalid or expired token' });
    req.user = user;
    next();
  }).catch(next);
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  verifyToken(token).then(user => {
    req.user = user; // null bei ungültig — Request läuft trotzdem
    next();
  }).catch(() => { req.user = null; next(); });
}

module.exports = { requireAuth, optionalAuth };
