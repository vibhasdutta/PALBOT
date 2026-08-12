#!/usr/bin/env bash
# scripts/setup-caddy.sh — installs Caddy as a TLS reverse proxy in front
# of the bot's web server. Run on the VM after the bot's .env is set.
#
# Usage:
#   bash scripts/setup-caddy.sh yourname.duckdns.org [--force]
#
# What it does:
#   1. Checks if setup is already complete (skips unless --force / -f is passed)
#   2. Installs Caddy (if not already installed)
#   3. Writes /etc/caddy/Caddyfile to reverse-proxy to localhost:WEB_PORT
#   4. Opens firewall ports 80 + 443 (ufw)
#   5. Restarts Caddy
#   6. Updates the bot's .env WEB_HOST to the domain
#
# Prerequisites:
#   - A DNS record pointing the domain at this VM's public IP
#   - The bot's .env already has DISCORD_TOKEN, DISCORD_CLIENT_ID, etc.
#   - Run as root or with sudo

set -euo pipefail

DOMAIN=""
FORCE=false

for arg in "$@"; do
  case "$arg" in
    -f|--force)
      FORCE=true
      ;;
    *)
      if [ -z "$DOMAIN" ]; then
        DOMAIN="$arg"
      fi
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$BOT_DIR/.env"

# --- Validation ---

if [ -z "$DOMAIN" ]; then
  echo ""
  echo "Usage: bash scripts/setup-caddy.sh <domain> [--force]"
  echo ""
  echo "Example with DuckDNS (free, 2 minutes):"
  echo "  1. Go to https://www.duckdns.org, sign in with Discord"
  echo "  2. Pick a subdomain, point it at this VM's public IP"
  echo "  3. Run: bash scripts/setup-caddy.sh yourname.duckdns.org"
  echo ""
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Set up the bot's .env first."
  exit 1
fi

# Read WEB_PORT from .env (default 8090)
WEB_PORT=$(grep -E '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')
WEB_PORT="${WEB_PORT:-8090}"

# Read current WEB_HOST from .env
CURRENT_WEB_HOST=$(grep -E '^WEB_HOST=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || true)

# --- Check if setup is already done ---

if [ "$FORCE" = false ] && [ "$CURRENT_WEB_HOST" = "$DOMAIN" ] && [ -f /etc/caddy/Caddyfile ] && grep -q "$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
  echo ""
  echo "[✓] Caddy setup for domain '$DOMAIN' is ALREADY COMPLETE!"
  echo "    - .env WEB_HOST: $CURRENT_WEB_HOST"
  echo "    - /etc/caddy/Caddyfile contains: $DOMAIN"
  echo ""
  echo "To re-run or overwrite this setup, pass the --force flag:"
  echo "  bash scripts/setup-caddy.sh $DOMAIN --force"
  echo ""
  exit 0
fi

echo ""
echo "=== Caddy TLS Setup ==="
echo "Domain:   $DOMAIN"
echo "Proxy to: localhost:$WEB_PORT"
echo ""

# --- 1. Install Caddy ---

if command -v caddy &>/dev/null; then
  echo "[✓] Caddy already installed: $(caddy version)"
else
  echo "[1/5] Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update >/dev/null 2>&1
  sudo apt-get install -y caddy >/dev/null 2>&1
  echo "[✓] Caddy installed: $(caddy version)"
fi

# --- 2. Write Caddyfile ---

echo "[2/5] Writing /etc/caddy/Caddyfile..."
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    reverse_proxy localhost:$WEB_PORT
}
EOF
echo "[✓] Caddyfile written"

# --- 3. Open firewall ports ---

echo "[3/5] Opening firewall ports 80, 443..."
if command -v ufw &>/dev/null; then
  sudo ufw allow 80/tcp >/dev/null 2>&1 || true
  sudo ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "[✓] ufw: ports 80, 443 open"
else
  echo "[!] ufw not found — make sure ports 80 and 443 are open in your cloud firewall"
fi

# --- 4. Restart Caddy ---

echo "[4/5] Restarting Caddy..."
sudo systemctl enable caddy >/dev/null 2>&1
sudo systemctl restart caddy
echo "[✓] Caddy running"

# --- 5. Update bot .env ---

echo "[5/5] Updating bot .env WEB_HOST..."
if grep -qE '^WEB_HOST=' "$ENV_FILE"; then
  sed -i "s/^WEB_HOST=.*/WEB_HOST=$DOMAIN/" "$ENV_FILE"
else
  echo "WEB_HOST=$DOMAIN" >> "$ENV_FILE"
fi
echo "[✓] WEB_HOST=$DOMAIN in .env"

# --- Done ---

echo ""
echo "================================================"
echo "  Caddy is live! HTTPS is automatic."
echo "================================================"
echo ""
echo "Dashboard:  https://$DOMAIN/dashboard"
echo "Health:     https://$DOMAIN/health"
echo ""
echo "--- Things you still need to do ---"
echo ""
echo "1. Agent .env — set BOT_WS_URL:"
echo "   BOT_WS_URL=wss://$DOMAIN/agent/connect"
echo ""
echo "2. Discord Developer Portal — add OAuth2 redirect:"
echo "   https://$DOMAIN/dashboard/callback"
echo "   (Settings → OAuth2 → Redirects → Add)"
echo ""
echo "3. Azure/cloud firewall — open inbound ports 80, 443"
echo "   if not already done in the network security group."
echo ""
echo "4. Restart the bot:"
echo "   pm2 restart palworld-bot"
echo ""
echo "5. Verify:"
echo "   curl https://$DOMAIN/health"
echo ""
