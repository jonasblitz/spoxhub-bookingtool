# Handover — Failed-Bookings-UI im Spoxhub Portal

## Ziel

Im Spoxhub Portal eine Aufarbeitungs-View bauen für Buchungs-Versuche, die
**nach** der PayPal-Anzahlung an eTermin gescheitert sind. Aktuell landen
solche Fälle in einer Airtable-Tabelle, aber niemand wird automatisch
informiert — das soll sich ändern.

## Wann tritt der Fall auf?

Wenn der Kunde im Booking-Tool die Anzahlung erfolgreich zahlt (PayPal capture
COMPLETED), aber der nachgelagerte eTermin-Call scheitert (z.B. Netzwerk,
Slot mittlerweile vergeben, eTermin-API-Fehler). Das Booking-Tool versucht
dann automatisch:

1. PayPal-Capture zurück zu erstatten (`paypal.refundCapture()`).
2. Den Vorgang in der Tabelle `FailedBookings` zu protokollieren — inkl.
   Kundendaten, Slot, Capture-ID und Refund-Status.

**Code-Pfad:** `routes/api-booking.js → handleBookingFailureAfterPayment()`.

## Datenquelle

**Airtable Base** `appQ2IaVtLbL219mZ`
**Tabelle** `FailedBookings`, ID **`tblqaXf4DOimr3EvB`**
(Env-Variable im bookingTool: `AIRTABLE_FAILED_BOOKINGS_TABLE`)

### Felder

| Feld              | Typ              | Beschreibung                                                  |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `CreatedAt`       | dateTime         | Wann der Fehler aufgetreten ist                               |
| `CustomerName`    | singleLineText   | „Vorname Nachname"                                            |
| `CustomerEmail`   | email            | Für Rückruf/Mail                                              |
| `CustomerPhone`   | phoneNumber      | Für Rückruf                                                   |
| `Bike`            | singleLineText   | Marke + Modell                                                |
| `Services`        | multilineText    | Komma-Liste (mit Qty)                                         |
| `SelectedSlot`    | dateTime         | Welcher Termin hätte gebucht werden sollen                    |
| `LocationType`    | singleLineText   | werkstatt / mobil / anderer_ort                               |
| `Address`         | singleLineText   | Service-Adresse                                               |
| `EstimatedPrice`  | currency (€)     | Geschätzter Gesamtpreis                                       |
| `DepositAmount`   | currency (€)     | Tatsächlich gezahlte Anzahlung                                |
| `PayPalOrderID`   | singleLineText   | PayPal Order                                                  |
| `PayPalCaptureID` | singleLineText   | PayPal Capture (für späteren manuellen Refund nötig)          |
| `ErrorMessage`    | multilineText    | eTermin-Fehler                                                |
| `RefundStatus`    | singleSelect     | `refunded` / `failed` / `skipped`                             |
| `RefundID`        | singleLineText   | PayPal Refund-ID (wenn auto-refund erfolgreich)               |
| `RefundError`     | multilineText    | Falls Auto-Refund auch scheiterte                             |
| `Status`          | singleSelect     | `open` / `refunded` / `rebooked` / `closed`                   |
| `Notes`           | multilineText    | Problembeschreibung des Kunden                                |

## Was im Portal zu bauen ist

1. **Inbox-Style Liste** aller `Status = open` Einträge. Newest first nach
   `CreatedAt`. Badge mit Anzahl im Portal-Hauptmenü.
2. **Detail-Ansicht** pro Eintrag — alle Felder + drei Aktionen:
   - **„Neu buchen"** (häufigster Fall): Termin im eTermin manuell anlegen
     (oder Workflow zurück ins Booking-Tool mit vorbefüllten Daten triggern),
     Status → `rebooked`.
   - **„Manuell erstatten"** (wenn `RefundStatus = failed` oder `skipped`):
     PayPal-Refund nachholen via `paypal.refundCapture(PayPalCaptureID)`,
     Status → `refunded`.
   - **„Schließen ohne Aktion"** (wenn z.B. Kunde telefonisch erreicht und
     anderweitig betreut wurde): Status → `closed` + Notes-Feld erweitern.
3. **Notification**: bei neuem Eintrag eine Mail/Slack/Teams-Benachrichtigung
   an die Werkstatt — Zielzeit: „innerhalb eines Werktags reagieren".
   Optionen:
   - **(a) Server-side Webhook**: in `handleBookingFailureAfterPayment()` einen
     zusätzlichen `fetch()` auf einen Slack/Teams/Mail-Webhook einbauen
     (einfachster Weg, direkt im Moment des Fehlers).
   - **(b) Airtable Automation**: in Airtable selbst eine Automation
     anlegen, die bei neuem Record in `FailedBookings` eine Mail sendet.

## Bestehende APIs (im bookingTool, wiederverwendbar)

| Funktion                              | Datei                  | Was sie macht                              |
| ------------------------------------- | ---------------------- | ------------------------------------------ |
| `paypal.refundCapture(captureId, …)`  | `lib/paypal.js`        | PayPal Capture refunden                    |
| `etermin.createAppointment({...})`    | `lib/etermin.js`       | Termin neu anlegen (für Rebook)            |
| `analytics.createBooking(...)`        | `lib/analytics.js`     | In Airtable `Bookings` persistieren        |

Für „Neu buchen" aus dem Portal heraus wäre die schnellste Lösung: einen
neuen Endpoint im bookingTool `POST /api/admin/rebook-failed` bauen, der die
FailedBooking-Record-ID nimmt und intern `etermin.createAppointment()` +
`analytics.createBooking()` ruft. Dann FailedBooking auf `rebooked` setzen.

## Wichtige Code-Pfade (Read-only-Referenz)

| Datei                                | Was es macht                                   |
| ------------------------------------ | ---------------------------------------------- |
| `lib/analytics.js → createFailedBooking()` | Wo FailedBookings geschrieben werden     |
| `routes/api-booking.js → handleBookingFailureAfterPayment()` | Trigger     |
| `scripts/setup-failed-bookings-table.js`   | Schema-Definition zur Referenz           |

## Env-Variablen (auf bookingTool-Server)

```
AIRTABLE_TOKEN=...
AIRTABLE_BASE_ID=appQ2IaVtLbL219mZ
AIRTABLE_FAILED_BOOKINGS_TABLE=tblqaXf4DOimr3EvB
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
PAYPAL_MODE=live
```

## Tech-Stack im Portal

(Bitte im neuen Chat aus der Portal-Codebase ermitteln — Portal liegt
vermutlich unter `/Users/jonpro/BlitzCloud/Persönliche Dateien/spoxhub/apps/...`
oder als PM2-Prozess `spoxhub-portal` auf dem Server unter `/opt/spoxhub/portal/`.)

## Wo loslegen

1. **Read** der Tabelle `FailedBookings` — Listenansicht in der Portal-UI.
2. **Notification-Strategie wählen** (Webhook im bookingTool ODER Airtable-
   Automation) und implementieren.
3. **Neue Admin-Endpoints im bookingTool** für die drei Aktionen — siehe
   Abschnitt „Was im Portal zu bauen ist".
4. **UI** im Portal: Inbox + Detail + Aktions-Buttons + Audit.

## Beziehung zum Refund/Storno-UI

Das Refund/Storno-UI (separates Handover-Dokument) arbeitet auf der
`Bookings`-Tabelle (= erfolgreich gebuchte Termine). Failed-Bookings ist eine
DISJUNKTE Datenquelle (= nie erfolgreich gebuchte Termine). Beide Views
sollten im Portal als eigene Navigations-Punkte erscheinen.
