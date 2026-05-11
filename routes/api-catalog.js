const express = require('express');
const router = express.Router();
const { getCatalogForVehicle } = require('../lib/catalog');

router.get('/:vehicleType', async (req, res) => {
  const { vehicleType } = req.params;

  if (!['ebike', 'cargobike'].includes(vehicleType)) {
    return res.status(400).json({ error: 'Unbekannter Fahrzeugtyp' });
  }

  try {
    const catalog = await getCatalogForVehicle(vehicleType);
    res.json(catalog);
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.status(500).json({ error: 'Katalog konnte nicht geladen werden.' });
  }
});

module.exports = router;
