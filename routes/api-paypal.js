const express = require('express');
const router = express.Router();
const paypal = require('../lib/paypal');
const config = require('../lib/config');

// Fallback wenn Airtable nicht erreichbar — Live-Wert in Tabelle Konfiguration.
const DEPOSIT_AMOUNT_FALLBACK_EUR = 20;

/**
 * Create PayPal order for deposit (called from browser).
 */
router.post('/create-order', async (req, res) => {
  try {
    const depositEur = await config.get('DepositAmountEUR', DEPOSIT_AMOUNT_FALLBACK_EUR);
    const amount = Number(depositEur).toFixed(2); // PayPal verlangt String mit 2 Nachkommastellen
    const order = await paypal.createOrder({
      amount,
      description: 'Anzahlung Fahrrad-Service — wird mit Rechnungsbetrag verrechnet'
    });
    res.json({ id: order.id });
  } catch (err) {
    console.error('PayPal create-order error:', err.message);
    res.status(500).json({ error: 'Zahlung konnte nicht initialisiert werden.' });
  }
});

/**
 * Capture PayPal order after approval (called from browser).
 */
router.post('/capture-order', async (req, res) => {
  const { orderID } = req.body;
  if (!orderID) return res.status(400).json({ error: 'Order ID fehlt' });

  try {
    const capture = await paypal.captureOrder(orderID);

    if (capture.status === 'COMPLETED') {
      const payment = capture.purchase_units?.[0]?.payments?.captures?.[0];
      console.log('PayPal payment captured:', {
        orderId: orderID,
        captureId: payment?.id,
        amount: payment?.amount?.value,
        status: capture.status
      });

      res.json({
        success: true,
        captureId: payment?.id,
        orderId: orderID
      });
    } else {
      res.status(400).json({ error: `Zahlung nicht abgeschlossen (Status: ${capture.status})` });
    }
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    res.status(500).json({ error: 'Zahlung konnte nicht abgeschlossen werden.' });
  }
});

module.exports = router;
