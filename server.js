const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

// ─── CORS für Plugin-Embed ───────────────────────────────────────────────
// Nur für /api/* und /embed/* aktiv. Whitelist aus PLUGIN_ORIGINS.
// Same-Origin-Aufrufe (kein Origin-Header) werden immer durchgelassen.
const ALLOWED_ORIGINS = (process.env.PLUGIN_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Same-origin / curl / Server-to-Server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Origin nicht erlaubt → keine CORS-Header senden, Request läuft durch.
    // Browser blockiert die Response. Kein Server-Error werfen → vermeidet 500.
    return cb(null, false);
  },
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Plugin-Key'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

// Optionaler API-Key-Check für Plugin-Requests.
// Greift nur bei Cross-Origin-Requests (req.headers.origin gesetzt).
// Same-Origin-Calls vom eigenen Frontend bleiben ungeprüft.
function pluginKeyCheck(req, res, next) {
  const key = process.env.PLUGIN_API_KEY;
  if (!key) return next();              // Kein Key konfiguriert → skip
  if (!req.headers.origin) return next(); // Same-origin → skip
  if (req.method === 'OPTIONS') return next(); // Preflight ohne Key
  if (req.headers['x-plugin-key'] === key) return next();
  return res.status(401).json({ error: 'Ungültiger oder fehlender X-Plugin-Key' });
}

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Routes
app.use('/', require('./routes/pages'));
app.use('/embed', corsMiddleware, pluginKeyCheck, require('./routes/embed'));
app.use('/api/catalog', corsMiddleware, pluginKeyCheck, require('./routes/api-catalog'));
app.use('/api/pricing', corsMiddleware, pluginKeyCheck, require('./routes/api-pricing'));
app.use('/api/geo', corsMiddleware, pluginKeyCheck, require('./routes/api-geo'));
app.use('/api/etermin', corsMiddleware, pluginKeyCheck, require('./routes/api-etermin'));
app.use('/api/booking', corsMiddleware, pluginKeyCheck, require('./routes/api-booking'));
app.use('/api/brands', corsMiddleware, pluginKeyCheck, require('./routes/api-brands'));
app.use('/api/leasing', corsMiddleware, pluginKeyCheck, require('./routes/api-leasing'));
app.use('/api/upload', corsMiddleware, pluginKeyCheck, require('./routes/api-upload'));
app.use('/api/paypal', corsMiddleware, pluginKeyCheck, require('./routes/api-paypal'));
app.use('/api/voucher', corsMiddleware, pluginKeyCheck, require('./routes/api-voucher'));
app.use('/api/analytics', corsMiddleware, pluginKeyCheck, require('./routes/api-analytics'));
// Admin bleibt absichtlich ohne CORS — nur Same-Origin via Basic Auth in Nginx
app.use('/api/admin', require('./routes/api-admin'));
// Portal: Server-to-Server-Endpoints (Bearer-Auth via PORTAL_API_TOKEN, kein CORS)
app.use('/api/portal', require('./routes/api-portal'));
// Auth: Magic-Link/Logout-Endpoints + Callback-Landing-Page (Supabase Auth).
app.use('/api/auth', corsMiddleware, pluginKeyCheck, require('./routes/api-auth'));
// Account: eingeloggter Kunde liest sein Profil (JWT-Auth in der Middleware).
app.use('/api/account', corsMiddleware, pluginKeyCheck, require('./routes/api-account'));
// v1: Externe Buchungs-API (Bearer-Auth via EXTERNAL_API_TOKEN, kein CORS).
// Swagger-Doku unter /api/v1/docs, Spec unter /api/v1/openapi.json.
app.use('/api/v1', require('./routes/api-v1'));

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

app.listen(PORT, () => {
  console.log(`Booking Tool running at http://localhost:${PORT}`);
});
