const path = require('path');
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('booking', {
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    agbUrl: process.env.AGB_URL || 'https://spoxhub.io/agb',
    privacyUrl: process.env.PRIVACY_URL || 'https://spoxhub.io/datenschutz'
  });
});

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

module.exports = router;
