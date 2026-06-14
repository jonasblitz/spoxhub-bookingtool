# Handover: Visueller Logik-Editor — Phase 1

Plan: `/Users/jonpro/.claude/plans/tranquil-crunching-trinket.md`
Phase: **1 von 4** — Globale Konstanten + Kalender + Katalog editierbar
Stand: 2026-05-29

## Was diese Phase liefert

Drei vorher hartkodierte/datenbasierte Bereiche bekommen einen Editor im
Spoxhub-Portal:

1. **Globale Einstellungen** (vorher hartkodiert):
   `TravelFeeEUR`, `DepositAmountEUR`, `InspektionFreeMinutes`,
   `RatePerMinuteEUR`, `AppointmentBufferMinutes`,
   `TravelBufferMinutesDefault` — alle in der neuen Airtable-Tabelle
   `Konfiguration`.
2. **Kalender** (vorher: nur per Airtable-Web-UI): Form-Editor pro Kalender
   für Arbeitszeiten, Pause-Fenster, Travel-Buffer, Aktiv-Flag, MaxFahrzeit.
3. **Katalog** (vorher: nur per Airtable-Web-UI): Tabelle mit Inline-Edit
   für Preis, Dauer, addPrice, addDuration, Material pro Leistung.

Save → PATCH zur Booking-Tool-Portal-API → Cache-Reload-Webhook → Werte
sind sofort live (statt nach 5 Min TTL).

## Geänderte / neue Dateien

### Booking-Tool

| Datei | Status |
|---|---|
| `lib/config.js` | **NEU** — KV-Loader aus Airtable mit 5-Min-Cache + `update()` + `invalidateCache()` |
| `scripts/setup-config-table.js` | **NEU** — legt `Konfiguration`-Tabelle an, schreibt Initial-Record mit aktuellen Code-Defaults |
| `lib/pricing.js` | RATE_PER_MINUTE / INSPEKTION_FREE_MINUTES / APPOINTMENT_BUFFER_MINUTES aus config (Fallback bleibt) |
| `lib/etermin.js` | TRAVEL_BUFFER_MINUTES aus config (Fallback bleibt) |
| `lib/slots.js` | `generateSlots()` akzeptiert optional `options.defaultTravelBuffer` (kommt aus etermin.js) |
| `routes/api-paypal.js` | DEPOSIT_AMOUNT aus config (Fallback bleibt) |
| `routes/api-geo.js` | TRAVEL_FEE_EUR aus config (Fallback bleibt) |
| `routes/api-booking.js` | Voucher-Path-Amount aus config |
| `routes/api-portal.js` | **NEU**: `GET /config`, `PATCH /config`, `GET /calendars`, `PATCH /calendars/:recordId`, `GET /catalog`, `PATCH /catalog/:recordId`, `POST /reload` |

### Spoxhub-Portal

| Datei | Status |
|---|---|
| `apps/buchungstool-config/buchungstool-config.html` | **NEU** — Page-Shell mit 3 Tabs |
| `apps/buchungstool-config/buchungstool-config.css`  | **NEU** — App-Styles (Tabs, Forms, Cards) |
| `apps/buchungstool-config/app.js`                   | **NEU** — Load/Save-Logik gegen Portal-API |
| `shared/config.js`   | erweitert um `BOOKING_API_BASE` + `BOOKING_API_TOKEN` |
| `shared/portal.html` | neuer App-Tile „Buchungstool-Konfig" für Rollen admin/inhaber/verwaltung |

## Deploy-Schritte

```bash
# ─────────── Booking-Tool ───────────
ssh root@194.164.205.180
cd /opt/spoxhub/bookingTool

# 1. Pull
git pull

# 2. Tabelle in Airtable anlegen + Initial-Record schreiben
node scripts/setup-config-table.js
# → Output: "AIRTABLE_CONFIG_TABLE=tbl…"  (optional in .env eintragen)

# 3. PM2 restart
pm2 restart spoxhub-booking

# 4. Smoke-Test
curl -s -H "Authorization: Bearer $PORTAL_API_TOKEN" \
  https://spoxhub.io/booking/api/portal/config | jq
# → erwartet: {"recordId":"rec…","fields":{"TravelFeeEUR":20,…}}


# ─────────── Spoxhub-Portal ───────────
# shared/config.js → BOOKING_API_TOKEN auf denselben Wert setzen
# wie PORTAL_API_TOKEN auf dem Booking-Tool-Server.
# Dann Portal deployen (gleicher Prozess wie sonst).
```

## End-to-End-Verifikation

### Test 1 — globale Konstante ändern

1. Portal → „Buchungstool-Konfig" → Tab „Globale Einstellungen"
2. `AppointmentBufferMinutes` von 15 auf 25 setzen → Speichern
3. Erwartet: Status-Bubble „✓ Gespeichert & Booking-Tool neu geladen"
4. Im Booking-Tool eine Test-Buchung anstoßen → der eTermin-Block
   sollte jetzt 25 statt 15 Min länger sein als die Service-Dauer.
5. Zurück auf 15 setzen.

### Test 2 — Kalender-Pause ändern

1. Tab „Kalender" → einen Werkstatt-Kalender aufklappen
2. `PausenLaenge` von 60 auf 90 setzen → Speichern
3. Booking-Tool: Slot-Engine sollte einen 90-Min-Pause-Block aus dem
   Pausen-Fenster aussparen.
4. Auto-Pause-Sync (cron oder nach nächster Buchung) schreibt 90-Min-Pause
   in eTermin.
5. Zurück auf 60 setzen.

### Test 3 — Katalog-Preis ändern

1. Tab „Katalog" → in einer Kategorie eine Leistung suchen
2. `Preis` z.B. von 39 auf 41 setzen → Save-Button neben der Zeile
3. Im Booking-Tool die Leistung in den Warenkorb legen → 41 statt 39 €.

### Test 4 — Validation

1. `AppointmentBufferMinutes` auf `-5` setzen → Save
2. Erwartet: Fehler „Auftrags-Puffer: darf nicht kleiner als 0 sein"
3. `pausenLaenge` größer als das Pausen-Fenster setzen → Save
4. Erwartet: Fehler „PausenLaenge ist größer als das Pausen-Fenster"

## Sicherheits-Modell (Phase 1)

- **Booking-Tool-Endpoints**: alle hinter Bearer-Token (`PORTAL_API_TOKEN`),
  same-origin Aufruf vom Portal aus.
- **Fallback-Strategie**: jeder `config.get(key, fallback)`-Aufruf liefert
  den Code-Fallback, wenn Airtable nicht erreichbar ist oder der Wert fehlt.
  Das Booking-Tool kann also ohne Airtable laufen.
- **Token im Browser**: `BOOKING_API_TOKEN` steht in `shared/config.js`
  und ist damit für jeden mit Portal-Zugriff sichtbar. Das ist dasselbe
  Trust-Niveau wie die n8n-Webhook-URLs daneben (durch Login gestützt).
  Long-term sollte das via Server-Proxy laufen; für Phase 1 ausreichend.

## Bekannte Einschränkungen / nicht in dieser Phase

- **Service-Types** (`inspektion` / `reparatur` / `aufbau`) bleiben
  hartkodiert. → Phase 2.
- **Flow-Reihenfolge + Show-Bedingungen** bleiben hartkodiert in
  `public/js/flow.js`. → Phase 3.
- **Audit-Log** der Konfig-Änderungen → Phase 4 (heute: nur `UpdatedAt`-
  Timestamp auf dem Record).
- **Catalog: neue Leistung anlegen / löschen** noch nicht im UI — nur
  bestehende Felder editierbar. Anlage weiter in Airtable.

## Rollback

Wenn etwas hängt:
1. PM2-Restart auf altes Commit zurück (`git reset --hard <hash>` + `pm2 restart`).
2. Der neue Code ist komplett abwärtskompatibel: ohne Airtable-Konfig-
   Tabelle nutzen alle Aufrufer den Code-Fallback (`get(key, defaultValue)`).
   Die Tabelle in Airtable darf also bestehen bleiben.
