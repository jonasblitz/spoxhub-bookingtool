/**
 * Voucher redemption — for internal testing & comp bookings.
 *
 * A valid code marks the deposit as paid (Anzahlung) WITHOUT charging the
 * customer. eTermin still gets the `appattrib=1` marker (via the same payment
 * flow as PayPal). Real payment via PayPal stays the default path.
 *
 * Codes live in env `TEST_VOUCHER_CODES` as a comma-separated list. Codes are
 * case-insensitive and whitespace-trimmed when compared.
 */
const express = require('express');
const router = express.Router();

function validCodes() {
  return String(process.env.TEST_VOUCHER_CODES || '')
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);
}

function isValidVoucher(code) {
  if (!code || typeof code !== 'string') return false;
  return validCodes().includes(code.trim().toUpperCase());
}

router.post('/redeem', (req, res) => {
  const code = (req.body?.code || '').trim();
  if (!code) return res.status(400).json({ valid: false, error: 'Bitte Code eingeben.' });

  if (!isValidVoucher(code)) {
    return res.status(400).json({ valid: false, error: 'Gutscheincode ungültig.' });
  }

  // We don't generate per-redemption tokens — the booking endpoint re-validates
  // the same code server-side, so a leaked frontend response gains nothing.
  res.json({ valid: true, code: code.toUpperCase(), amount: 20 });
});

// Export the helper so other modules (api-booking) can re-validate.
module.exports = router;
module.exports.isValidVoucher = isValidVoucher;
