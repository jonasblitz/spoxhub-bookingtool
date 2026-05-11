const express = require('express');
const router = express.Router();
const { loadLeasingProviders } = require('../lib/leasing');

router.get('/', async (req, res) => {
  try {
    const providers = await loadLeasingProviders();
    res.json(providers);
  } catch (err) {
    console.error('Leasing API error:', err.message);
    res.status(500).json({ error: 'Fehler beim Laden der Leasinggesellschaften' });
  }
});

module.exports = router;
