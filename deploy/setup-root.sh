#!/usr/bin/env bash
#
# One-time root setup for circleftp-jellyfin.
#
#   sudo bash deploy/setup-root.sh
#
# Installs the systemd unit and (optionally) the nginx vhost for the public
# hostname. Safe to re-run: every step is idempotent and existing files are
# backed up before being replaced.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-muz-server}"
SERVICE_NAME="circleftp-jellyfin"
PUBLIC_HOST="${PUBLIC_HOST:-request.foliolab.app}"
INSTALL_NGINX="${INSTALL_NGINX:-yes}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must run as root:  sudo bash deploy/setup-root.sh" >&2
  exit 1
fi

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }

# --------------------------------------------------------------------------
say "Checking prerequisites"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User $APP_USER does not exist." >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/packages/server/.env" ]]; then
  echo "Missing $REPO_DIR/packages/server/.env" >&2
  echo "Copy .env.example to it and set SESSION_SECRET before running this." >&2
  exit 1
fi

if ! grep -qE '^SESSION_SECRET=.{16,}' "$REPO_DIR/packages/server/.env"; then
  echo "SESSION_SECRET is unset or too short in packages/server/.env." >&2
  echo "Generate one with:" >&2
  echo "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/packages/server/dist/index.js" ]]; then
  echo "The app is not built. Run 'npm run build' as $APP_USER first." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not on root's PATH." >&2
  exit 1
fi
ok "node $("$NODE_BIN" -v), build present, .env configured"

# The media directory must be group-writable with setgid, or files land with the
# wrong group and Jellyfin (running as another uid) cannot read them.
MEDIA_ROOT="$(grep -E '^MEDIA_ROOT=' "$REPO_DIR/packages/server/.env" | cut -d= -f2- | tr -d '"')"
MEDIA_ROOT="${MEDIA_ROOT:-/var/nextcloud-data/ncadmin/files/Movies}"

if [[ -d "$MEDIA_ROOT" ]]; then
  PERMS="$(stat -c '%a' "$MEDIA_ROOT")"
  if [[ "$PERMS" != "2775" ]]; then
    warn "Media dir is mode $PERMS; setting 2775 so new files inherit the group"
    chmod 2775 "$MEDIA_ROOT"
  fi
  ok "Media dir $MEDIA_ROOT is $(stat -c '%U:%G %a' "$MEDIA_ROOT")"

  if ! id -nG "$APP_USER" | tr ' ' '\n' | grep -qx "$(stat -c '%G' "$MEDIA_ROOT")"; then
    warn "$APP_USER is not in the $(stat -c '%G' "$MEDIA_ROOT") group — downloads will fail"
  fi
else
  warn "Media dir $MEDIA_ROOT does not exist yet; it will be created on first download"
fi

# --------------------------------------------------------------------------
say "Installing the systemd unit"

UNIT_SRC="$REPO_DIR/deploy/$SERVICE_NAME.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"

if [[ -f "$UNIT_DST" ]]; then
  cp -a "$UNIT_DST" "$UNIT_DST.bak.$(date +%Y%m%d%H%M%S)"
  ok "Backed up the existing unit"
fi

# Rewrite the hard-coded paths in case the repo lives somewhere else.
sed -e "s#/home/muz-server/circleftp-jellyfin#$REPO_DIR#g" \
    -e "s#^User=.*#User=$APP_USER#" \
    -e "s#^Group=.*#Group=$APP_USER#" \
    -e "s#/usr/bin/node#$NODE_BIN#g" \
    "$UNIT_SRC" > "$UNIT_DST"
chmod 644 "$UNIT_DST"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "$SERVICE_NAME is running"
else
  echo "Service failed to start. Recent log:" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
  exit 1
fi

PORT="$(grep -E '^PORT=' "$REPO_DIR/packages/server/.env" | cut -d= -f2- || echo 7070)"
PORT="${PORT:-7070}"
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  ok "Health check passed on port $PORT"
else
  warn "Health check on port $PORT did not answer yet"
fi

# --------------------------------------------------------------------------
if [[ "$INSTALL_NGINX" == "yes" ]] && command -v nginx >/dev/null; then
  say "Installing the nginx vhost for $PUBLIC_HOST"

  VHOST_DST="/etc/nginx/sites-available/$SERVICE_NAME"
  if [[ -f "$VHOST_DST" ]]; then
    cp -a "$VHOST_DST" "$VHOST_DST.bak.$(date +%Y%m%d%H%M%S)"
  fi

  sed -e "s#request\.foliolab\.app#$PUBLIC_HOST#g" \
      -e "s#127\.0\.0\.1:7070#127.0.0.1:$PORT#g" \
      "$REPO_DIR/deploy/nginx-$SERVICE_NAME.conf" > "$VHOST_DST"

  ln -sfn "$VHOST_DST" "/etc/nginx/sites-enabled/$SERVICE_NAME"

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "nginx reloaded; $PUBLIC_HOST proxies to 127.0.0.1:$PORT"
  else
    warn "nginx config test failed — leaving the vhost in place but NOT reloading"
    nginx -t || true
  fi
else
  say "Skipping nginx (INSTALL_NGINX=$INSTALL_NGINX)"
fi

# --------------------------------------------------------------------------
say "Done"
cat <<EOF

  Service     systemctl status $SERVICE_NAME
  Logs        journalctl -u $SERVICE_NAME -f
  Local       http://127.0.0.1:$PORT
  Tailscale   http://\$(hostname).tail7c2a6.ts.net:$PORT

  Still to do by hand (Cloudflare's ingress is dashboard-managed, and there is
  no API token on this host):

    1. Zero Trust → Networks → Tunnels → your tunnel → Public Hostnames
       Add:  $PUBLIC_HOST  →  http://localhost:$PORT
    2. Make sure the DNS record for $PUBLIC_HOST is PROXIED (orange cloud).
       Check with:  dig +short $PUBLIC_HOST @1.1.1.1
       Cloudflare anycast IPs = good. A bare *.cfargotunnel.com CNAME means the
       record is grey-clouded and the hostname will not resolve publicly.

  Create your first account (as $APP_USER, not root):
    cd $REPO_DIR && npm run user:create -- --email you@example.com --admin

EOF
