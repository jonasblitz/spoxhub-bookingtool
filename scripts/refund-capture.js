/**
 * Manually refund one or more PayPal capture IDs.
 *
 * Usage:
 *   node scripts/refund-capture.js <captureId> [<captureId> ...]
 *
 * Example:
 *   node scripts/refund-capture.js 5XA39972K4440325K 11P97027PW452181F
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const paypal = require('../lib/paypal');

const ids = process.argv.slice(2).filter(Boolean);
if (ids.length === 0) {
  console.error('Usage: node scripts/refund-capture.js <captureId> [<captureId> ...]');
  process.exit(1);
}

(async () => {
  console.log(`Mode: ${process.env.PAYPAL_MODE || 'sandbox'}`);
  for (const id of ids) {
    process.stdout.write(`→ refunding ${id} ... `);
    try {
      const r = await paypal.refundCapture(id, { reason: 'Buchung konnte nicht erstellt werden — manuell erstattet.' });
      console.log(`✓ ${r.status}  refundId=${r.id}  amount=${r.amount?.value} ${r.amount?.currency_code}`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }
})();
