/**
 * Analytics & Booking Persistence — schreibt Session/Customer/Bike/Booking
 * in Airtable. Fail-soft: wenn Airtable nicht konfiguriert ist oder ein
 * Aufruf fehlschlägt, wird loggt aber nicht der Haupt-Flow gestoppt.
 */

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

function config() {
  return {
    token:   process.env.AIRTABLE_TOKEN,
    baseId:  process.env.AIRTABLE_BASE_ID,
    tables: {
      sessions:        process.env.AIRTABLE_SESSIONS_TABLE,
      customers:       process.env.AIRTABLE_CUSTOMERS_TABLE,
      bikes:           process.env.AIRTABLE_BIKES_TABLE,
      bookings:        process.env.AIRTABLE_BOOKINGS_TABLE,
      failedBookings:  process.env.AIRTABLE_FAILED_BOOKINGS_TABLE
    }
  };
}

function isConfigured() {
  const c = config();
  return !!(c.token && c.baseId && c.tables.sessions);
}

async function api(method, tableId, path = '', body = null) {
  const { token, baseId } = config();
  if (!token || !baseId) throw new Error('Airtable not configured');
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${tableId}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
    throw new Error(`Airtable ${method} ${url} → ${msg}`);
  }
  return data;
}

function nowISO() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSIONS — upsert by SessionID
// ─────────────────────────────────────────────────────────────────────────────

async function upsertSession(sessionId, fields = {}) {
  const { tables } = config();
  if (!tables.sessions) return null;

  const payload = {
    performUpsert: { fieldsToMergeOn: ['SessionID'] },
    records: [{ fields: { SessionID: sessionId, LastUpdatedAt: nowISO(), ...fields } }]
  };

  const result = await api('PATCH', tables.sessions, '', payload);
  return result.records?.[0] || null;
}

async function appendScreenToSession(sessionId, screenId, meta = {}) {
  const { tables } = config();
  if (!tables.sessions) return null;

  // Fetch existing session to append to history
  const list = await api(
    'GET',
    tables.sessions,
    `?filterByFormula=${encodeURIComponent(`{SessionID}='${sessionId}'`)}&maxRecords=1`
  );
  const existing = list.records?.[0];

  const now = nowISO();
  const historyLine = `${now}  ${screenId}`;
  let history = historyLine;
  let startedAt = now;

  if (existing) {
    history = (existing.fields.ScreenHistory || '') + '\n' + historyLine;
    startedAt = existing.fields.StartedAt || now;
  }

  const fields = {
    SessionID: sessionId,
    StartedAt: startedAt,
    LastUpdatedAt: now,
    LastScreen: screenId,
    ScreenHistory: history.trim(),
    ...meta
  };

  const upsert = await api('PATCH', tables.sessions, '', {
    performUpsert: { fieldsToMergeOn: ['SessionID'] },
    records: [{ fields }]
  });
  return upsert.records?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMERS — upsert by Email
// ─────────────────────────────────────────────────────────────────────────────

async function findOrCreateCustomer(email, customerData = {}) {
  const { tables } = config();
  if (!tables.customers || !email) return null;

  const fields = {
    Email: email,
    Anrede:           customerData.anrede || undefined,
    Vorname:          customerData.vorname || undefined,
    Nachname:         customerData.name || undefined,
    Mobil:            customerData.mobil || undefined,
    Strasse:          customerData.strasse || undefined,
    PLZ:              customerData.plz || undefined,
    Ort:              customerData.ort || undefined,
    RechnungFirma:    customerData.rechnungFirma || undefined,
    RechnungStrasse:  customerData.rechnungStrasse || undefined,
    RechnungPlz:      customerData.rechnungPlz || undefined,
    RechnungOrt:      customerData.rechnungOrt || undefined,
    CreatedAt:        customerData.createdAt || nowISO()
  };

  // Strip undefineds so upsert doesn't overwrite with empty
  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  const result = await api('PATCH', tables.customers, '', {
    performUpsert: { fieldsToMergeOn: ['Email'] },
    records: [{ fields }]
  });
  return result.records?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BIKES — always create a new row (per user requirement)
// ─────────────────────────────────────────────────────────────────────────────

async function createBike(customerRecordId, bikeData = {}, vehicleType, bikePhotoUrl) {
  const { tables } = config();
  if (!tables.bikes) return null;

  const label = [bikeData.marke, bikeData.modell].filter(Boolean).join(' ').trim() || 'Unbenanntes Rad';

  const fields = {
    Label:                 label,
    VehicleType:           vehicleType || undefined,
    BidexKlasse:           bikeData.bidexKlasse ? Number(bikeData.bidexKlasse) : undefined,
    Marke:                 bikeData.marke || undefined,
    Modell:                bikeData.modell || undefined,
    Farbe:                 bikeData.farbe || undefined,
    Rahmennummer:          bikeData.rahmennummer || undefined,
    IstLeasing:            !!bikeData.leasing,
    LeasingAnbieter:       bikeData.leasing || undefined,
    LeasingVertragsnr:     bikeData.leasingNr || undefined,
    IstVersichert:         !!bikeData.versicherung,
    Versicherung:          bikeData.versicherung || undefined,
    VersicherungVertragsnr: bikeData.versicherungNr || undefined,
    CreatedAt:             nowISO()
  };
  if (customerRecordId) fields.Customer = [customerRecordId];
  if (bikePhotoUrl) {
    fields.BikePhoto = [{ url: bikePhotoUrl }];
  }

  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  const result = await api('POST', tables.bikes, '', {
    records: [{ fields }]
  });
  return result.records?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKINGS — always create
// ─────────────────────────────────────────────────────────────────────────────

function buildBookingRef() {
  const d = new Date();
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BK-${yyyymmdd}-${rand}`;
}

async function createBooking({
  customerRecordId,
  bikeRecordId,
  state,
  eterminBookingId,
  problemMediaUrls
}) {
  const { tables } = config();
  if (!tables.bookings) return null;

  const services = (state.selectedServices || []).map(s => {
    const qty = s.quantity || 1;
    return qty > 1 ? `${qty}× ${s.name}` : s.name;
  }).join(', ');
  const serviceIds = (state.selectedServices || []).map(s => s.id).join(',');

  const slot = state.selectedSlot;
  const slotDateTime = slot ? `${slot.date}T${slot.start}:00` : undefined;

  const fields = {
    BookingRef:        buildBookingRef(),
    ServiceType:       state.serviceType || undefined,
    Services:          services,
    ServiceIDs:        serviceIds,
    ProblemDescription: state.problemDescription || undefined,
    LocationType:      state.locationType || undefined,
    Address:           state.address || undefined,
    EstimatedPrice:    state.pricing?.total ?? undefined,
    TravelFee:         state.pricing?.travelFee ?? undefined,
    DepositAmount:     state.payment?.amount ?? undefined,
    DepositPaid:       !!state.depositPaid || state.payment?.status === 'completed',
    SelectedSlot:      slotDateTime,
    EterminBookingID:  eterminBookingId || undefined,
    PayPalOrderID:     state.payment?.orderId || undefined,
    PayPalCaptureID:   state.payment?.captureId || undefined,
    Status:            'confirmed',
    AGBAccepted:       !!state.agbAccepted,
    PrivacyAccepted:   !!state.privacyAccepted,
    NewsletterOptIn:   !!state.newsletterOptIn,
    CreatedAt:         nowISO()
  };
  if (customerRecordId) fields.Customer = [customerRecordId];
  if (bikeRecordId) fields.Bike = [bikeRecordId];
  if (Array.isArray(problemMediaUrls) && problemMediaUrls.length > 0) {
    fields.ProblemMedia = problemMediaUrls.map(url => ({ url }));
  }

  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  const result = await api('POST', tables.bookings, '', {
    records: [{ fields }]
  });
  return result.records?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Link + complete session
// ─────────────────────────────────────────────────────────────────────────────

async function linkSessionToCustomer(sessionId, customerRecordId) {
  if (!customerRecordId) return null;
  return upsertSession(sessionId, { Customer: [customerRecordId] });
}

async function completeSession(sessionId, bookingRecordId, customerRecordId) {
  const fields = { Completed: true };
  if (bookingRecordId) fields.Booking = [bookingRecordId];
  if (customerRecordId) fields.Customer = [customerRecordId];
  return upsertSession(sessionId, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// FAILED BOOKINGS — log entries when eTermin booking fails after PayPal capture
// (so nothing falls through the cracks even if auto-refund also fails).
// ─────────────────────────────────────────────────────────────────────────────

async function createFailedBooking({
  state,
  errorMessage,
  refund = null  // { status, refundId?, error? }
}) {
  const { tables } = config();
  if (!tables.failedBookings) {
    console.warn('[failed-booking] AIRTABLE_FAILED_BOOKINGS_TABLE not configured — skipping log');
    return null;
  }

  const c = state?.customer || {};
  const b = state?.bike || {};
  const slot = state?.selectedSlot || {};
  const services = (state?.selectedServices || [])
    .map(s => (s.quantity > 1 ? `${s.quantity}× ${s.name}` : s.name))
    .join(', ');

  const slotDateTime = (slot.date && slot.start)
    ? `${slot.date}T${slot.start}:00`
    : undefined;

  const fields = {
    CreatedAt:        nowISO(),
    CustomerName:     [c.vorname, c.name].filter(Boolean).join(' ') || undefined,
    CustomerEmail:    c.email || undefined,
    CustomerPhone:    c.mobil || undefined,
    Bike:             [b.marke, b.modell].filter(Boolean).join(' ') || undefined,
    Services:         services || undefined,
    SelectedSlot:     slotDateTime,
    LocationType:     state?.locationType || undefined,
    Address:          state?.address || undefined,
    EstimatedPrice:   state?.pricing?.total ?? undefined,
    DepositAmount:    state?.payment?.amount ?? undefined,
    PayPalOrderID:    state?.payment?.orderId || undefined,
    PayPalCaptureID:  state?.payment?.captureId || undefined,
    ErrorMessage:     errorMessage || undefined,
    RefundStatus:     refund?.status || undefined,    // 'refunded' | 'failed' | 'skipped'
    RefundID:         refund?.refundId || undefined,
    RefundError:      refund?.error || undefined,
    Status:           refund?.status === 'refunded' ? 'refunded' : 'open',
    Notes:            state?.problemDescription || undefined
  };
  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  const result = await api('POST', tables.failedBookings, '', { records: [{ fields }] });
  return result.records?.[0] || null;
}

module.exports = {
  isConfigured,
  upsertSession,
  appendScreenToSession,
  findOrCreateCustomer,
  createBike,
  createBooking,
  createFailedBooking,
  linkSessionToCustomer,
  completeSession
};
