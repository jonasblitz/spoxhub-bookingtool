#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy-Script: WP-Plugin-relevante Backend-Änderungen auf spoxhub.io live.
#
# Sicherheits-Eigenschaften:
#   • WHITELIST: deployed nur Files die in unserer Plugin-Session geändert wurden.
#     Andere Backend-Files (auto-pause, calendars, etc.) bleiben UNANGETASTET.
#   • Server-Backup: legt vor dem Deploy einen Snapshot des bookingTool/ an.
#   • Dry-Run: zeigt zuerst was passieren würde, fragt um Bestätigung.
#   • npm install --production: zieht neue Dependencies (cors, postcss-prefix-selector).
#   • Healthcheck nach pm2-restart.
#
# Aufruf:
#   ./scripts/deploy-plugin-changes.sh
#
# Erfordert SSH-Zugang zu access-5016492709.webspace-host.com (User a1185959).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Konfig ─────────────────────────────────────────────────────────────────
SSH_HOST="access-5016492709.webspace-host.com"
SSH_USER="a1185959"
PM2_NAME="spoxhub-booking"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Server-Pfad — der einzige Wert der hardcoded ist; bei Erst-Deploy von dir
# bestätigen lassen. Default-Wert kommt aus PM2-Lookup unten falls leer.
REMOTE_DIR="${REMOTE_DIR:-}"

# ─── Files die deployed werden ──────────────────────────────────────────────
# Strenge Whitelist. Alles andere bleibt auf dem Server unangetastet.
FILES_TO_DEPLOY=(
  # NEUE Backend-Routes/Templates für WP-Plugin-Embed
  "routes/embed.js"
  "src/views/embed.ejs"

  # Server-Setup: CORS-Middleware, Embed-Route-Mount
  "server.js"
  "package.json"
  "package-lock.json"

  # Frontend-Assets (Wizard, geteilt zwischen Standalone und Embed)
  "public/js/state.js"        # scrollToWizardTop helper
  "public/js/flow.js"         # scroll usage
  "public/js/wizard.js"       # scroll usage
  "public/js/payment.js"      # sofortige Buchung nach Zahlung

  # Standalone-Markup (SEPA-Disable in PayPal-SDK URL)
  "src/views/booking.ejs"

  # Payment-Screen Cleanup (success/booking divs entfernt)
  "src/views/partials/screens/21-payment.ejs"

  # Embed-Build-Pipeline + Output
  "tailwind.embed.config.js"
  "src/input.embed.css"
  "scripts/build-embed-css.js"
  "public/css/output.embed.css"
)

# ─── Helpers ────────────────────────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

confirm() {
  read -r -p "$1 [yes/NO] " resp
  [[ "$resp" == "yes" ]]
}

# ─── Schritt 0: Files prüfen ────────────────────────────────────────────────
bold "▸ Schritt 0/6 — Lokale Files prüfen"
missing=()
for f in "${FILES_TO_DEPLOY[@]}"; do
  if [[ ! -f "$LOCAL_DIR/$f" ]]; then
    missing+=("$f")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  red "✗ Folgende Files fehlen lokal:"
  printf "  - %s\n" "${missing[@]}"
  exit 1
fi
green "✓ Alle ${#FILES_TO_DEPLOY[@]} Files vorhanden"

# ─── Schritt 1: Server-Pfad ermitteln ───────────────────────────────────────
bold ""
bold "▸ Schritt 1/6 — Server-Pfad ermitteln"
if [[ -z "$REMOTE_DIR" ]]; then
  yellow "REMOTE_DIR nicht gesetzt — versuche via PM2 zu finden…"
  REMOTE_DIR=$(ssh "$SSH_USER@$SSH_HOST" \
    "pm2 jlist 2>/dev/null | python3 -c \"import sys,json; apps=json.load(sys.stdin); print([a['pm2_env']['pm_cwd'] for a in apps if a['name']=='$PM2_NAME'][0])\"" 2>/dev/null || true)

  if [[ -z "$REMOTE_DIR" ]]; then
    red "✗ Konnte REMOTE_DIR nicht ermitteln."
    yellow "Setze ihn manuell: REMOTE_DIR=/pfad/zu/bookingTool $0"
    exit 1
  fi
fi
green "✓ Server-Pfad: $REMOTE_DIR"

# ─── Schritt 2: Dry-Run ─────────────────────────────────────────────────────
bold ""
bold "▸ Schritt 2/6 — Dry-Run: was würde geändert?"
echo ""
rsync -avzn --relative \
  -e "ssh" \
  "${FILES_TO_DEPLOY[@]/#/$LOCAL_DIR/./}" \
  "$SSH_USER@$SSH_HOST:$REMOTE_DIR/" \
  2>&1 | grep -vE "^(sending incremental|sent |total size)" | head -40

echo ""
yellow "Bitte prüfe oben die Diff-Liste."
echo ""
if ! confirm "Mit echtem Deploy fortfahren?"; then
  red "Abgebrochen."
  exit 0
fi

# ─── Schritt 3: Server-Backup ───────────────────────────────────────────────
bold ""
bold "▸ Schritt 3/6 — Backup auf dem Server anlegen"
BACKUP_NAME="bookingTool.bak.$(date +%Y%m%d-%H%M%S)"
ssh "$SSH_USER@$SSH_HOST" "cp -a '$REMOTE_DIR' '$REMOTE_DIR'-bak-\$(date +%Y%m%d-%H%M%S)" \
  || { red "✗ Backup fehlgeschlagen"; exit 1; }
green "✓ Backup als $REMOTE_DIR-bak-... angelegt"

# ─── Schritt 4: Echtes rsync ────────────────────────────────────────────────
bold ""
bold "▸ Schritt 4/6 — rsync (echt)"
rsync -avz --relative \
  -e "ssh" \
  "${FILES_TO_DEPLOY[@]/#/$LOCAL_DIR/./}" \
  "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"
green "✓ Files kopiert"

# ─── Schritt 5: npm install + pm2 restart ───────────────────────────────────
bold ""
bold "▸ Schritt 5/6 — npm install + pm2 restart"
ssh "$SSH_USER@$SSH_HOST" "cd '$REMOTE_DIR' && npm install --production --no-audit --no-fund && pm2 restart $PM2_NAME"
green "✓ Dependencies installiert + Service neugestartet"

# ─── Schritt 6: Healthcheck ─────────────────────────────────────────────────
bold ""
bold "▸ Schritt 6/6 — Healthcheck"
sleep 2
HEALTH=$(curl -sS https://spoxhub.io/booking/embed/version || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok":true'; then
  green "✓ Backend antwortet: $HEALTH"
else
  red "✗ Healthcheck fehlgeschlagen: $HEALTH"
  yellow "Prüfe manuell: ssh $SSH_USER@$SSH_HOST 'pm2 logs $PM2_NAME --lines 30'"
  exit 1
fi

bold ""
green "═══════════════════════════════════════════════════════"
green "  Deploy erfolgreich."
green "═══════════════════════════════════════════════════════"
echo ""
yellow "▸ NÄCHSTE MANUELLE SCHRITTE auf dem Server (per SSH):"
echo ""
echo "  1. .env editieren — radblitz.de zur CORS-Whitelist hinzufügen:"
echo "     ssh $SSH_USER@$SSH_HOST"
echo "     cd $REMOTE_DIR"
echo "     nano .env"
echo "     (Zeile PLUGIN_ORIGINS= ergänzen oder anlegen:)"
echo "     PLUGIN_ORIGINS=https://radblitz.de,https://www.radblitz.de"
echo ""
echo "  2. Backend neu starten damit ENV greift:"
echo "     pm2 restart $PM2_NAME"
echo ""
echo "  3. Test ob CORS für radblitz.de funktioniert:"
echo "     curl -sI -H 'Origin: https://radblitz.de' \\"
echo "          -X OPTIONS https://spoxhub.io/booking/api/catalog/ebike \\"
echo "       | grep -i access-control"
echo "     (sollte 'Access-Control-Allow-Origin: https://radblitz.de' zeigen)"
