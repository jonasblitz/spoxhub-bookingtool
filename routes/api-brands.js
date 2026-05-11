const express = require('express');
const router = express.Router();
const { loadBrands } = require('../lib/brands');

router.get('/', async (req, res) => {
  try {
    const brands = await loadBrands();
    res.json(brands);
  } catch (err) {
    console.error('Brands error:', err.message);
    res.status(500).json({ error: 'Marken konnten nicht geladen werden.' });
  }
});

module.exports = router;
