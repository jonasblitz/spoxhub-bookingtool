const express = require('express');
const router = express.Router();
const { calculatePricing } = require('../lib/pricing');

router.post('/calculate', async (req, res) => {
  const { serviceIds, quantities, vehicleType, locationType, travelTimeMinutes } = req.body;

  if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
    return res.status(400).json({ error: 'Keine Leistungen angegeben' });
  }

  try {
    const result = await calculatePricing({ serviceIds, quantities, vehicleType, locationType, travelTimeMinutes });
    res.json(result);
  } catch (err) {
    console.error('Pricing error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
