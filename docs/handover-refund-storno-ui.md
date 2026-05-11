# Handover — Refund- & Stornierungs-UI im Spoxhub Portal

## Ziel

Im Spoxhub Portal eine Werkstatt-Admin-View bauen, mit der ein Mitarbeiter
einen bestehenden Termin in **einem Klick** stornieren UND die PayPal-Anzahlung
zurückerstatten kann.

## Kontext: woher kommen die Daten

Alle Buchungen werden vom Booking-Tool (`/opt/spoxhub/bookingTool/` auf
194.164.205.180, deployed unter `https://spoxhub.io/booking/`) in zwei Systeme
geschrieben:

1. **eTermin** (Kalender-System) → enthält den eigentlichen Termin (`appointment.ID`).
2. **Airtable Base `appQ2IaVtLbL219mZ`**, Tabelle `Bookings` (ID `${process.env.AIRTABLE_BOOKINGS_TABLE}`)
   → enthält jede erfolgreiche Buchung mit allen Kundendaten **plus**:
   - `EterminBookingID` (Verknüpfung zum Kalender)
   - `PayPalOrderID` (PayPal Order)
   - `PayPalCaptureID` (PayPal Capture — wird für Refund gebraucht; NEU: bisher nicht im
     Schema, muss ergänzt werden — siehe „Schema-Änderung" unten)
   - `DepositAmount`, `DepositPaid`
   - `Status` (`confirmed`, ggf. später `cancelled`, `refunded`)
   - Kundendaten via verknüpften `Customer`-Record

### Schema-Änderung (vor Start zu erledigen)

Aktuell wird `PayPalCaptureID` **nicht** in die `Bookings`-Tabelle geschrieben.
Sie liegt nur im Server-Log. Für sinnvollen Refund muss sie persistiert werden.

**Fix:** in `lib/analytics.js → createBooking()` das Feld ergänzen
(state.payment.captureId), in der Airtable-Tabelle ein Feld `PayPalCaptureID`
(singleLineText) anlegen. **Im Refund-UI-Chat als erstes erledigen.**

## Bestehende APIs (im bookingTool, wiederverwendbar)

### PayPal-Refund

`lib/paypal.js` exportiert `refundCapture(captureId, { reason, invoiceId })`.
Aktuell wird sie nur intern beim Auto-Refund aufgerufen — kein HTTP-Endpoint.
**Du musst einen schmalen Endpoint im bookingTool oder direkt im Portal-Backend
bauen, der diese Funktion ruft.**

Vorschlag: im bookingTool `POST /api/admin/refund` mit Basic-Auth (Portal-only,
nicht über CORS exposed). Body: `{ captureId, reason? }` → ruft
`paypal.refundCapture(captureId, ...)`.

### eTermin-Storno

`lib/etermin.js` exportiert `deleteAppointment(appointmentId)`. Macht intern:
```js
DELETE /appointment?id=<eterminBookingId>
```

Auch hier: kein HTTP-Endpoint vorhanden. Vorschlag: `POST /api/admin/cancel-appointment`
mit Body `{ eterminBookingId }`.

### Mounted unter

Admin-Routes im bookingTool: `server.js:66`:
```js
app.use('/api/admin', require('./routes/api-admin'));
```
Bestehende Route `routes/api-admin.js` — dort die zwei neuen Endpoints einbauen.
**Bewusst KEIN CORS** — Basic-Auth läuft über Nginx auf dem Server.

## Was im Portal zu bauen ist

1. **Liste aller bestätigten Buchungen** (aus Airtable `Bookings`, Filter
   `Status = confirmed`) — sortiert nach `SelectedSlot` aufsteigend.
   Columns: Datum/Uhrzeit, Kunde, Fahrrad, Services, Preis, Anzahlung-Status.
2. **Detail-Ansicht** pro Buchung mit allen Daten + zwei Buttons:
   - **„Termin stornieren"** → ruft `DELETE` im eTermin + setzt Airtable
     `Status = cancelled`.
   - **„Termin stornieren + Anzahlung erstatten"** → wie oben, aber zusätzlich
     `paypal.refundCapture(PayPalCaptureID)` + setzt `Status = refunded`.
   - (Optional) **„Nur Anzahlung erstatten"** für Edge-Cases.
3. **Bestätigungs-Dialog** vor jeder destruktiven Aktion (Storno/Refund sind
   nicht reversibel).
4. **Audit-Log**: jede Aktion mit Zeitstempel + User in Airtable festhalten —
   z.B. neues Feld `CancellationLog` (multilineText) oder eigene Tabelle
   `BookingAuditLog`.

## Edge-Cases

- Termin liegt in der Vergangenheit → Refund nur mit zusätzlicher Bestätigung
  (Werkstatt-Mitarbeiter rechtfertigen).
- Termin wurde manuell in eTermin gelöscht → DELETE-Call kann 404 zurückgeben,
  trotzdem Refund + Airtable-Update durchführen.
- Refund-Versuch ohne `PayPalCaptureID` (z.B. Voucher-Buchung, `payment.method
  === 'voucher'`) → nicht versuchen, stattdessen UI nur „Termin stornieren"
  anbieten.
- Termin in der Failed-Bookings-Tabelle (Tabelle `FailedBookings`,
  `tblqaXf4DOimr3EvB`) — siehe separates Handover-Dokument.

## Tech-Stack im Portal

(Bitte im neuen Chat anhand der vorhandenen Portal-Codebase ermitteln — der
Portal-Code liegt vermutlich unter `/Users/jonpro/BlitzCloud/Persönliche Dateien/spoxhub/apps/...`
oder als PM2-Prozess `spoxhub-portal` auf dem Server unter `/opt/spoxhub/portal/`.)

## Env-Variablen (auf bookingTool-Server)

```
AIRTABLE_TOKEN=...
AIRTABLE_BASE_ID=appQ2IaVtLbL219mZ
AIRTABLE_BOOKINGS_TABLE=tbl...   # siehe Server .env
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
PAYPAL_MODE=live
```

## Wichtige Code-Pfade (Read-only-Referenz)

| Datei                              | Was es macht                              |
| ---------------------------------- | ----------------------------------------- |
| `lib/paypal.js`                    | PayPal Order/Capture/Refund wrappers      |
| `lib/etermin.js`                   | eTermin API wrappers (incl. delete)       |
| `lib/analytics.js`                 | Airtable booking persistence              |
| `routes/api-admin.js`              | Bestehende Admin-Routes (hier erweitern)  |
| `routes/api-booking.js`            | Booking-Confirm-Flow (zum Verständnis)    |
| `scripts/refund-capture.js`        | CLI-Tool, das `paypal.refundCapture` ruft |

## Wo loslegen

1. Schema-Erweiterung: `PayPalCaptureID` ins Airtable + `lib/analytics.js` →
   `createBooking()` schreibt es mit.
2. Neue HTTP-Endpoints im bookingTool: `routes/api-admin.js`:
   - `POST /api/admin/refund` { captureId, reason? } → `paypal.refundCapture()`
   - `POST /api/admin/cancel-appointment` { eterminBookingId } →
     `etermin.deleteAppointment()`
   - `POST /api/admin/cancel-and-refund` { bookingRecordId } → kombiniert beides
     atomar (cancel + refund + Airtable-Status updaten).
3. Portal-UI: Buchungsliste + Detail + Buttons + Audit-Log.
