# SpoxHub Booking — WordPress-Plugin

Frontend-Hülle für das `bookingTool`-Backend. Backend bleibt auf `spoxhub.io`,
das Plugin lädt nur Markup + Assets via `/embed/*`-Endpoints und ruft die
`/api/*`-Endpoints per CORS.

## Verzeichnis-Struktur

```
wp-plugin/
├── README.md                    # diese Datei
└── spoxhub-booking/             # eigentlicher Plugin-Ordner (in WP installieren)
    ├── spoxhub-booking.php      # Plugin-Header + Bootstrap
    ├── readme.txt               # WP.org-Format
    ├── includes/
    │   ├── class-plugin.php       # Singleton-Orchestrator
    │   ├── class-api-client.php   # HTTP-Wrapper + Transient-Cache
    │   ├── class-settings.php     # Settings-Page + AJAX
    │   ├── class-asset-loader.php # wp_enqueue_script/style
    │   └── class-shortcode.php    # [spoxhub_booking]
    └── assets/                  # leer — alle Assets kommen vom Backend
```

## Installation auf einem WP-Server

**Variante A — ZIP per Hand:**
```bash
cd wp-plugin
zip -r spoxhub-booking.zip spoxhub-booking
# In WP-Admin: Plugins → Plugin hinzufügen → Plugin hochladen → ZIP wählen
```

**Variante B — direkt kopieren:**
```bash
rsync -av spoxhub-booking/ user@wp-server:/path/to/wp-content/plugins/spoxhub-booking/
```

Dann in WP: **Plugins → SpoxHub Booking → Aktivieren**.

## Konfiguration

Nach der Aktivierung:

1. **WP**: Settings → SpoxHub Booking
   - `API-Base-URL`: `https://spoxhub.io/booking`  (default)
   - `API-Key`: leer lassen oder Shared-Secret aus spoxhub-`.env`
   - "Verbindung testen" klicken → muss `✓` zeigen

2. **Backend** (`bookingTool/.env` auf spoxhub):
   ```
   PLUGIN_ORIGINS=https://kunde-wp-domain.de
   PLUGIN_API_KEY=                # optional, gleicher Wert wie in WP
   ```
   Danach `pm2 restart spoxhub-booking`.

3. **WP-Seite anlegen**, Shortcode einfügen:
   ```
   [spoxhub_booking]
   ```

## Wie das funktioniert

```
Browser auf kunde.de
   ├─ GET kunde.de/seite             → WP rendert Page
   │                                    + spoxhub-booking shortcode liefert
   │                                    HTML-Fragment vom Backend (gecacht 5min)
   ├─ GET spoxhub.io/booking/css/output.embed.css   ← gescoped, ohne Preflight
   ├─ GET spoxhub.io/booking/js/state.js            ← Bootstrap setzt
   │     [+ window.SPOXHUB_API_BASE = 'https://spoxhub.io/booking']
   │     [+ window.SPOXHUB_STATE_NAMESPACE = '<8-char-md5(home_url)>']
   ├─ GET spoxhub.io/booking/js/...                 ← weitere Scripts in order
   └─ POST spoxhub.io/booking/api/booking           ← CORS, X-Plugin-Key
```

Das WordPress-Plugin selbst ist passiv: es macht **keine** Backend-Logik,
**keine** Datenpersistenz, **keinen** Payment-Flow. Alles läuft auf spoxhub.

## Update-Strategie

Aktuell: manueller Re-Upload bei neuer Version.
Geplant (Phase 5): Auto-Update via GitHub-Releases mit `plugin-update-checker`.

## Backend-Anforderungen

Backend muss folgende Endpoints exponieren (sind seit `bookingTool@1.0.0`
implementiert in `routes/embed.js`):

| Endpoint | Zweck |
|----------|-------|
| `GET /embed/markup`  | HTML-Fragment des Wizards |
| `GET /embed/config`  | JSON: Asset-Liste, PayPal-ID, AGB-URL, Version |
| `GET /embed/version` | Healthcheck für Settings-Page |

CORS muss für die WP-Domain freigeschaltet sein (`PLUGIN_ORIGINS`).
