/**
 * Account-Endpoints (Read-only in Release 1).
 *
 *   GET /api/account/profile  — gibt das Kunden-Profil aus public.customers
 *                               + bicycles + addresses + contact_details
 *                               zurück. Beim ersten Aufruf für einen User
 *                               wird die Profile-Bridge getriggert
 *                               (eTermin/Airtable → Supabase).
 *
 * Future (Release 2): GET /bookings, POST /bookings/:id/cancel
 * Future (post-Release 2): PATCH /profile
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../lib/auth-middleware');
const supabase = require('../lib/supabase');
const bridge = require('../lib/profile-bridge');

router.use(requireAuth);

// ─── GET /api/account/profile ──────────────────────────────────────────────

router.get('/profile', async (req, res) => {
  try {
    const { customer, bicycles, isNew } = await bridge.ensureProfile(req.user);

    // Adressen + Kontaktdaten als Sidecars liefern
    const admin = supabase.getAdminClient();
    const [addrRes, detRes] = await Promise.all([
      admin.from('addresses')
        .select('*')
        .eq('entity_type', 'customer').eq('entity_id', customer.id)
        .order('is_primary', { ascending: false }),
      admin.from('contact_details')
        .select('*')
        .eq('entity_type', 'customer').eq('entity_id', customer.id)
        .order('is_primary', { ascending: false })
    ]);
    const addresses = addrRes.data || [];
    const contacts  = detRes.data || [];

    // Helper: pick first nach type
    const addrByType = t => addresses.find(a => a.address_type === t) || null;
    const ctByType   = t => contacts.find(c => c.detail_type === t) || null;

    // Booking-Tool-State-freundliches Shape (für einfache Vorbefüllung)
    const home    = addrByType('home');
    const billing = addrByType('billing');
    const emailCt = ctByType('email');
    const phoneCt = ctByType('phone');

    res.json({
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName:  customer.last_name,
        externalBookingId: customer.external_booking_id,
        isNew
      },
      contact: {
        email: emailCt?.value || req.user.email,
        phone: phoneCt?.value || null
      },
      address: home ? {
        street: home.street, plz: home.zip, city: home.city, country: home.country
      } : null,
      billing: billing ? {
        company: billing.company,
        street: billing.street, plz: billing.zip, city: billing.city
      } : null,
      bicycles: (bicycles || []).map(b => ({
        id: b.id,
        marke: b.make,
        modell: b.model,
        farbe: b.color,
        rahmennummer: b.frame_number,
        leasing: b.leasing_provider,
        leasingNr: b.leasing_contract_number,
        versicherung: b.insurer_name,
        versicherungNr: b.insurance_number,
        bidexKlasse: b.bidex_class
      }))
    });
  } catch (err) {
    console.error('[account] profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
