#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy-Script: Externe Buchungs-API v1 auf spoxhub.io/booking live bringen.
#
# Sicherheits-Eigenschaften (analog deploy-plugin-changes.sh):
#   • WHITELIST: deployed nur die 5 API-Files. Alles andere bleibt unangetastet.
#   • Server-Backup vor dem Deploy.
#   • Dry-Run + Bestätigung (überspringbar mit AUTO_YES=1).
#   • Token: generiert EXTERNAL_API_TOKEN, falls noch keiner gesetzt ist.
#   • pm2 restart + Healthcheck gegen die neue API.
#   • Server-.env-Secrets bleiben erhalten — es kommt nur EINE Zeile dazu.
#
# Ziel: root@194.164.205.180:/opt/spoxhub/bookingTool (Key-Auth via id_ed25519).
# (Der IONOS-Webspace hostet nur die Landing-Page, NICHT das Booking-Tool.)
#
# Aufruf:
#   AUTO_YES=1 ./scripts/deploy-api-v1.sh   # ohne Rückfrage
#   ./scripts/deploy-api-v1.sh              # mit Dry-Run-Bestätigung
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SSH_HOST="194.164.205.180"
SSH_USER="root"
PM2_NAME="spoxhub-booking"
REMOTE_DIR="${REMOTE_DIR:-/opt/spoxhub/bookingTool}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -o ConnectTimeout=20"
PUBLIC_BASE="https://spoxhub.io/booking"

FILES_TO_DEPLOY=(
  "routes/api-v1.js"        # neue v1-API (Bearer-Auth, Swagger)
  "lib/booking-core.js"     # gemeinsame Buchungs-Logik (web + API)
  "docs/openapi.json"       # OpenAPI-Spec
  "server.js"               # Mount /api/v1
  "routes/api-booking.js"   # nutzt jetzt booking-core
)

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

# ─── Schritt 0: Lokale Files prüfen ──────────────────────────────────────────
bold "▸ 0/6 — Lokale Files prüfen"
for f in "${FILES_TO_DEPLOY[@]}"; do
  [[ -f "$LOCAL_DIR/$f" ]] || { red "✗ fehlt lokal: $f"; exit 1; }
done
green "✓ Alle ${#FILES_TO_DEPLOY[@]} Files vorhanden"

# ─── Schritt 1: Server-Pfad ermitteln ────────────────────────────────────────
bold "▸ 1/6 — Server-Pfad ermitteln"
REMOTE_DIR="${REMOTE_DIR:-}"
if [[ -z "$REMOTE_DIR" ]]; then
  REMOTE_DIR=$($SSH "$SSH_USER@$SSH_HOST" \
    "pm2 jlist 2>/dev/null | python3 -c \"import sys,json; a=json.load(sys.stdin); print([x['pm2_env']['pm_cwd'] for x in a if x['name']=='$PM2_NAME'][0])\"" 2>/dev/null || true)
fi
[[ -n "$REMOTE_DIR" ]] || { red "✗ REMOTE_DIR nicht ermittelbar — setze ihn manuell: REMOTE_DIR=/pfad $0"; exit 1; }
green "✓ Server-Pfad: $REMOTE_DIR"

# ─── Schritt 2: Dry-Run ───────────────────────────────────────────────────────
bold "▸ 2/6 — Dry-Run"
rsync -avzn --relative -e "ssh" \
  "${FILES_TO_DEPLOY[@]/#/$LOCAL_DIR/./}" \
  "$SSH_USER@$SSH_HOST:$REMOTE_DIR/" \
  2>&1 | grep -vE "^(sending incremental|sent |total size)" | head -40

if [[ "${AUTO_YES:-}" != "1" ]]; then
  read -r -p "Mit echtem Deploy fortfahren? [yes/NO] " resp
  [[ "$resp" == "yes" ]] || { red "Abgebrochen."; exit 0; }
fi

# ─── Schritt 3: Backup ─────────────────────────────────────────────────────────
bold "▸ 3/6 — Server-Backup"
$SSH "$SSH_USER@$SSH_HOST" "cp -a '$REMOTE_DIR' '$REMOTE_DIR'-bak-\$(date +%Y%m%d-%H%M%S)"
green "✓ Backup angelegt"

# ─── Schritt 4: rsync (echt) ───────────────────────────────────────────────────
bold "▸ 4/6 — rsync"
rsync -avz --relative -e "ssh" \
  "${FILES_TO_DEPLOY[@]/#/$LOCAL_DIR/./}" \
  "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"
green "✓ Files kopiert"

# ─── Schritt 5: Token setzen (falls fehlt) + pm2 restart ──────────────────────
bold "▸ 5/6 — Token + Restart"
$SSH "$SSH_USER@$SSH_HOST" "cd '$REMOTE_DIR' && \
  if grep -q '^EXTERNAL_API_TOKEN=' .env 2>/dev/null; then \
    echo 'TOKEN: bereits gesetzt — bleibt unverändert'; \
  else \
    T=\$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))'); \
    printf '\n# Externe Buchungs-API v1\nEXTERNAL_API_TOKEN=%s\n' \"\$T\" >> .env; \
    echo \"TOKEN_SET=\$T\"; \
  fi && \
  pm2 restart $PM2_NAME >/dev/null && echo 'pm2 restarted'"
green "✓ Token geprüft/gesetzt + Service neugestartet"

# ─── Schritt 6: Healthcheck ────────────────────────────────────────────────────
bold "▸ 6/6 — Healthcheck"
sleep 2
SPEC=$(curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_BASE/api/v1/openapi.json")
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_BASE/api/v1/catalog")
echo "  openapi.json : HTTP $SPEC  (erwartet 200)"
echo "  catalog ohne Token : HTTP $NOAUTH  (erwartet 401)"
if [[ "$SPEC" == "200" && "$NOAUTH" == "401" ]]; then
  green "═══ Deploy erfolgreich ═══"
  echo "  Doku:  $PUBLIC_BASE/api/v1/docs"
  echo "  Buchen: POST $PUBLIC_BASE/api/v1/bookings"
  yellow "  → Token oben (TOKEN_SET=...) der externen Software geben. Falls 'bereits gesetzt': bestehenden Token verwenden."
else
  red "✗ Healthcheck unerwartet — prüfe: $SSH $SSH_USER@$SSH_HOST 'pm2 logs $PM2_NAME --lines 30'"
  exit 1
fi
