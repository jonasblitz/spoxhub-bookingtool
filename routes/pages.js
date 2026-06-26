const path = require('path');
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('booking', {
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    agbUrl: process.env.AGB_URL || 'https://spoxhub.io/agb',
    privacyUrl: process.env.PRIVACY_URL || 'https://spoxhub.io/datenschutz',
    // Supabase Public-Werte fürs Browser-Auth (Magic Link + OAuth). Anon-Key
    // ist absichtlich öffentlich — RLS-Policies regeln die Datenzugriffe.
    supabaseUrl:    process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

module.exports = router;
