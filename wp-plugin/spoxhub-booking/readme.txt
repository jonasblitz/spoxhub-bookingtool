=== SpoxHub Booking ===
Contributors: spoxhub
Tags: booking, fahrrad, service, wizard, etermin
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.2
License: Proprietary

Bindet das SpoxHub Fahrrad-Service-Buchungstool als Shortcode in WordPress ein.

== Description ==

Dünne Frontend-Hülle für das SpoxHub Booking-Backend. Markup, Styles und Scripts werden vom konfigurierten Backend (default: https://spoxhub.io/booking) geladen, alle API-Calls (Airtable-Katalog, eTermin-Slots, TravelTime-Geofencing, PayPal) laufen weiter dort.

= Verwendung =

Nach der Aktivierung:

1. Settings → SpoxHub Booking → API-Base-URL prüfen
2. "Verbindung testen" klicken
3. Shortcode in eine Seite einfügen: `[spoxhub_booking]`

= Voraussetzungen =

Das Backend muss die Domain dieser WordPress-Installation in der CORS-Whitelist (`PLUGIN_ORIGINS` in der spoxhub-`.env`) eingetragen haben — sonst blockt der Browser die API-Calls.

== Changelog ==

= 1.0.2 =
* Critical-CSS inline mit hoher Spezifität: schützt den Wizard-Flow gegen Caches/Minifier (z.B. WPO-Minify) und gegen PageBuilder-CSS (z.B. Elementor), die !important-Display-Regeln überschreiben würden. Behebt: alle Wizard-Schritte werden gleichzeitig statt nacheinander angezeigt.

= 1.0.1 =
* API-Base: zusätzliches "Internal API URL"-Feld für Docker-Dev-Setups (host.docker.internal).
* Asset-Loader: setzt jetzt `const API_BASE` als Inline-Bootstrap, damit alle fetch()-Calls im Embed funktionieren (vorher: undefined → API-Calls broken).
* PayPal-SDK-URL kommt jetzt komplett vom Backend (`/embed/config → paypalSdkUrl`) — Plugin und Standalone teilen sich SEPA-Disable und alle weiteren Optionen.

= 1.0.0 =
* Initial Release. Shortcode, Settings-Page, Diagnose-Tools.
