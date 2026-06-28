# eTermin Field Mapping

Welche Daten das Booking-Tool bei jedem `POST /appointment` an eTermin
sendet. Quelle: [`lib/etermin.js → createAppointment`](../lib/etermin.js)
und [`lib/booking-core.js → buildEterminNotes`](../lib/booking-core.js).

Dieselbe Payload geht parallel an den n8n-Order-Webhook
(`N8N_ORDER_WEBHOOK_URL` in der .env, siehe
[`lib/webhook.js`](../lib/webhook.js)) — dort als JSON statt URL-encoded.

---

## 1. Standard-Felder

Die eTermin-Termine bekommen jeweils einen festen Satz Standardfelder.
Alle Werte landen URL-encoded im POST-Body.

| Feld | Quelle (BookingState) | Beispiel | Bemerkung |
|---|---|---|---|
| `calendarid` | `slot.calendarId` oder Werkstatt-Default | `216919` | Siehe [Kalender-IDs](#5-kalender-ids) |
| `start` | `slot.date + ' ' + slot.start` | `2026-07-02 09:15` | Format `YYYY-MM-DD HH:MM` |
| `end` | `slot.date + ' ' + slot.end` | `2026-07-02 10:15` | inkl. 15-Min Auftrags-Puffer |
| `firstname` | `customer.vorname` | `Anna` | |
| `lastname` | `customer.name` | `Müller` | |
| `email` | `customer.email` | `anna@…` | |
| `phone` | `customer.mobil` | `+491701234567` | |
| `street` | `customer.strasse` | `Mönckebergstraße 1` | Wohnadresse des Kunden, nicht Service-Ort |
| `zip` | `customer.plz` | `20095` | |
| `city` | `customer.ort` | `Hamburg` | |
| `notes` | `buildEterminNotes(state)` | (siehe [§ 3](#3-notes-block)) | mehrzeiliger formatierter Text-Block |
| `services` | `state.selectedServices.map(s => s.eterminId).join(',')` | `593430,594710` | comma-separated, nur **gesetzte** eTermin-IDs (Airtable-Feld `EterminID`) |
| `location` | `customer.strasse + plz + ort` (für mobil) | `Mönckebergstraße 1, 20095 Hamburg` | nur bei `locationType ≠ werkstatt` — Service-Adresse, nicht Wohn-Adresse |

## 2. Steuer-Flags

| Feld | Fester Wert | Wirkung |
|---|---|---|
| `sendemail` | `1` | eTermin sendet die Bestätigungs-Mail an den Kunden |
| `manualconfirmed` | `1` | Termin gilt als manuell bestätigt (kein Pending) |
| `sync` | `1` | Sync zum externen CalDav-Kalender (Google Cal, iCal etc.) wird ausgelöst |
| `canceldeadline` | `1440` | 24 h vor Termin kann der Kunde via eTermin selbst stornieren |
| `appattrib` | `0` oder `1` | `1` = bezahlt (Anzahlung erfolgt). Wert kommt aus `ETERMIN_PAID_APPATTRIB` env, nur gesetzt wenn `payment.captureId` oder `payment.status='completed'` |

## 3. Notes-Block

Mehrzeiliger Text in `notes`. Sektionen sind durch `══ TITEL ══` getrennt;
Reihenfolge ist fest, leere Sektionen werden weggelassen.

```
🚧🚧🚧  T E S T B U C H U N G  🚧🚧🚧
(Gutscheincode statt Anzahlung — kein Geld geflossen)

══ LEISTUNGEN ══
- Inspektion komplett (89,00 €)
- Kette wechseln (35,00 €)

══ PROBLEMBESCHREIBUNG ══
Bremse hinten schleift, manchmal Knacken aus dem Tretlager.

══ FAHRZEUG ══
Cargobike — Riese & Müller Load 75
Rahmennummer: RM-TEST-12345
Leasing:       JobRad (Vertrags-Nr JR-987654)
Versicherung:  Wertgarantie (Vertrags-Nr WG-555123)

══ FOTOS / VIDEOS ══
Problem 1: https://spoxhub.io/booking/uploads/abc123.jpg
Problem 2: https://spoxhub.io/booking/uploads/def456.mp4

══ KUNDE ══
Herr Anna Müller
anna@example.com · +491701234567
Mönckebergstraße 1, 20095 Hamburg

══ RECHNUNG ══
Abweichend:
Testfirma GmbH
Am Sandtorkai 50
20457 Hamburg

══ SERVICE-ORT ══
Werkstatt

══ PREIS & ZAHLUNG ══
Geschätzter Gesamtpreis: 124,00 €
   Anfahrtskosten:       0,00 €
Anzahlung (PayPal):       20,00 €
PayPal Order-ID:          17J34598AB123456C
```

| Sektion | Wird gerendert wenn | Quelle |
|---|---|---|
| TESTBUCHUNG-Banner | `state.payment.method === 'voucher'` | hardcoded |
| LEISTUNGEN | immer | `state.pricing.lineItems` (Name + Preis + Mengen-Prefix + "inkl. Inspektion"-Badge) |
| PROBLEMBESCHREIBUNG | nur wenn ausgefüllt | `state.problemDescription` |
| FAHRZEUG | immer | `state.vehicleType` + `state.bike.*` |
| FOTOS / VIDEOS | nur wenn Uploads vorhanden | `state.uploadedFiles[].filename` → `https://<PUBLIC_BASE>/uploads/<filename>` |
| KUNDE | immer | `state.customer.*` (Anrede + Name + Email/Mobil + Adresse) |
| RECHNUNG | nur wenn `rechnungStrasse` oder `rechnungFirma` gesetzt | `state.customer.rechnung*` |
| SERVICE-ORT | immer | `state.locationType` + `state.address` + `state.addressNotes` |
| PREIS & ZAHLUNG | immer wenn `pricing.total` oder Payment vorhanden | `state.pricing.*` + `state.payment.*` |

## 4. Additional-Felder

eTermin gibt 17 generische Custom-Fields (`additional1` bis
`additional17`). Wir belegen davon 9. Die Belegung muss im eTermin
Backoffice auch entsprechend benannt sein (Settings → Calendar →
Additional Fields).

| Feld | Label in eTermin | Inhalt | Quelle (BookingState) | Bedingung |
|---|---|---|---|---|
| `additional1` | Hersteller | `Riese & Müller` | `state.bike.marke` | wenn gesetzt |
| `additional2` | Modell | `Load 75` | `state.bike.modell` | wenn gesetzt |
| `additional3` | Rahmennummer | `RM-TEST-12345` | `state.bike.rahmennummer` | wenn gesetzt |
| `additional4` | Leasinggeber | `JobRad` | `state.bike.leasing` | wenn gesetzt |
| `additional5` | Leasing-Vertragsnummer | `JR-987654` | `state.bike.leasingNr` | wenn gesetzt |
| `additional6` | — frei — | — | — | |
| `additional7` | — frei — | — | — | |
| `additional8` | Rechnungsadresse | `Testfirma GmbH, Am Sandtorkai 50, 20457 Hamburg` | abweichende Rechnungsadresse, fallback Wohnadresse | immer wenn nicht-leer |
| `additional9` | PayPal-Order-ID | `17J34598AB123456C` | `state.payment.orderId` | wenn gesetzt |
| `additional10` – `additional15` | — frei — | — | — | |
| `additional16` | Versicherung | `Wertgarantie` | `state.bike.versicherung` | wenn gesetzt |
| `additional17` | Versicherungs-Vertragsnummer | `WG-555123` | `state.bike.versicherungNr` | wenn gesetzt |

**Hinweis zu `additional8` (Rechnungsadresse):**
- Wenn der Kunde im Wizard eine **abweichende Rechnungsadresse** angibt:
  `[rechnungFirma, rechnungStrasse, "<rechnungPlz> <rechnungOrt>"]` mit Komma getrennt
- Sonst Fallback auf die Wohnadresse: `[strasse, "<plz> <ort>"]` (damit das Feld in eTermin nie leer bleibt — vereinfacht das CSV-Export)

## 5. Consents (Datenschutz-Flags)

Werden nur gesendet **wenn der Kunde sie aktiv akzeptiert hat** (Checkbox im Wizard).

| Feld | Quelle | Wirkung in eTermin |
|---|---|---|
| `agbaccepted` | `state.agbAccepted` | AGB akzeptiert |
| `dataprivacyaccepted` | `state.privacyAccepted` | Datenschutz akzeptiert |
| `newsletter` | `state.newsletterOptIn` | Newsletter-Opt-in |
| `feedbackpermissionaccepted` | `state.feedbackOptIn` | Feedback-Anfrage erlaubt |

AGB + Privacy sind im Wizard Pflicht-Checkboxes; Newsletter +
Feedback sind Opt-in, defaulten im State auf `true`.

## 6. Kalender-IDs

Aktiv verwendete Kalender (Stand 2026-06-28, aus Airtable-Tabelle
`Kalender` (`tbluykbJ3BpZS2wE5`) — verändert sich, wenn dort neue
Einträge angelegt werden):

| ID | Name | Typ | Beschreibung |
|---|---|---|---|
| 211614 | Blitz 1 | mobil | Mobile Werkstatt 1, Geo-Check über `MaxFahrzeitMin` |
| 216919 | St. Pauli Werkstatt | werkstatt | Werkstatt-Slot, kein Travel-Buffer |
| 219019 | Blitz 2 | mobil | Mobile Werkstatt 2, aktuell inaktiv (siehe Airtable) |
| 225270 | Werkstattplatz 1 | werkstatt | Werkstatt-Slot, kein Travel-Buffer |

Die `calendarid` im POST-Body wird **vom Booking-Tool gewählt**, je nach
Service-Art und Verfügbarkeit:

1. **Reservation hat schon einen Kalender festgelegt** → der gewinnt
2. **Mobile Buchung** → `pickLeastBusyFromSet` über `geoResult.eligible[]`
   (Kalender, die den Service-Ort innerhalb ihrer `MaxFahrzeitMin` erreichen können)
3. **Werkstatt-Buchung** → `pickLeastBusyWorkshopCalendar(date)` über alle
   aktiven Werkstatt-Kalender, tie-breaker Belegung des Tages
4. **Fallback** → erster aktiver Kalender

## 7. Services / eTermin-Service-IDs

`services` ist ein Komma-getrennter String von eTermin-Service-IDs
(Zahlen). Die IDs kommen aus dem **Airtable Catalog**
(`tblxfZMerv61U0hjb`) — jeder Catalog-Eintrag hat ein Feld `EterminID`,
das auf die entsprechende Leistung im eTermin Backoffice verweist.

```
Airtable Catalog Row  →  eTermin Service
─────────────────────────────────────────
"Inspektion komplett" (EterminID 593430)  →  services contains "593430"
"Kette wechseln"      (EterminID 594710)  →  services contains "594710"
"Aufbau Ebike"        (EterminID 599434)  →  services contains "599434"
```

Im Booking-Tool werden Catalog-Einträge im Wizard ausgewählt
(`state.selectedServices[]`), und beim Confirm extrahieren wir
`s.eterminId` aus jedem Eintrag (Dedup über `Set`, leere Werte werden
weggefiltert).

**Wichtig:** Nur Catalog-Einträge, bei denen das Feld `EterminID` in
Airtable gesetzt ist, landen im `services`-Feld. Einträge ohne EterminID
sind trotzdem in den Notes (LEISTUNGEN-Sektion) sichtbar, aber eTermin
selbst sieht sie nicht als Service-Verknüpfung.

## 8. Was wir NICHT an eTermin senden

Bewusst weggelassene Felder, die der Vollständigkeit halber erwähnt
seien:

- **Geburtsdatum** (`Birthday`) — nicht im Wizard erfasst
- **Anrede** als separates Feld (`Salutation`) — kommt aktuell nur in den
  Notes-Block, nicht ins eTermin-Standard-Feld. Wenn das gewünscht ist:
  in `createAppointment` ein zusätzliches `salutation: c.anrede` ergänzen.
- **CustomerNumber** — eTermin vergibt das automatisch
- **AppointmentTitle** — eTermin generiert das aus den ausgewählten Services

## 9. n8n-Webhook-Spezifika

Der n8n-Webhook (`N8N_ORDER_WEBHOOK_URL`) bekommt die identische Feld-
Belegung als **JSON-Objekt** (statt URL-encoded), plus zwei zusätzliche
Felder, die eTermin nicht bekommt:

| Extra-Feld | Inhalt | Zweck |
|---|---|---|
| `eterminBookingId` | `result.ID` oder `result.IID` (numerisch) | Referenz auf den frisch erstellten eTermin-Termin |
| `eterminExternalId` | `result.ExternalID` (UUID) | Stabilere Referenz, wird auch in Airtable Bookings (`EterminBookingID`) und in Spoxhub `public.order_appointments.etermin_booking_id` gespeichert |

Damit kann n8n parallel zu eTermin eigene Workflows triggern (z.B.
Bestellungen anstoßen, CRM-Updates, Slack-Notifications), ohne dass das
Booking-Tool davon wissen muss.
