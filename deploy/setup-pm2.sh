#!/usr/bin/env bash
#
# Run circleftp-jellyfin under pm2, surviving reboots — without root.
#
#   bash deploy/setup-pm2.sh
#
# Uses a systemd *user* unit rather than pm2's own `pm2 startup`, which writes a
# system unit and needs sudo. A user unit only survives logout and reboot when
# lingering is enabled for the account; this script checks that and tells you
# the one command that does need root if it is not.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="pm2-circleftp-jellyfin.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$SERVICE"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------------------
say "Checking prerequisites"

[[ $EUID -ne 0 ]] || die "Run this as your normal user, not root — pm2 state lives in \$HOME."

command -v node >/dev/null || die "node is not on PATH."
command -v pm2 >/dev/null || die "pm2 is not installed. Install it with: npm install -g pm2"

NODE_BIN_DIR="$(dirname "$(command -v node)")"
PM2_BIN="$(command -v pm2)"
ok "node $(node -v) at $NODE_BIN_DIR"
ok "pm2 $(pm2 -v) at $PM2_BIN"

[[ -f "$REPO_DIR/packages/server/.env" ]] \
  || die "Missing packages/server/.env — copy .env.example and set SESSION_SECRET."
grep -qE '^SESSION_SECRET=.{16,}' "$REPO_DIR/packages/server/.env" \
  || die "SESSION_SECRET is unset or too short in packages/server/.env."
[[ -f "$REPO_DIR/packages/server/dist/index.js" ]] \
  || die "Not built. Run: npm run build"
ok "Build present and .env configured"

# --------------------------------------------------------------------------
# The media directory is owned by the web user's group. If this account's
# membership of that group was granted *after* the current login session began,
# processes inherit a group set without it and downloads fail with EACCES — a
# trap that cost real debugging time on this host once already.
say "Checking write access to the media directory"

MEDIA_ROOT="$(grep -E '^MEDIA_ROOT=' "$REPO_DIR/packages/server/.env" | cut -d= -f2- | tr -d '"' || true)"
MEDIA_ROOT="${MEDIA_ROOT:-/var/nextcloud-data/ncadmin/files/Movies}"

if [[ -d "$MEDIA_ROOT" ]]; then
  MEDIA_GROUP="$(stat -c '%G' "$MEDIA_ROOT")"
  MEDIA_GID="$(stat -c '%g' "$MEDIA_ROOT")"

  if id -nG | tr ' ' '\n' | grep -qx "$MEDIA_GROUP"; then
    ok "You are a member of '$MEDIA_GROUP'"
  else
    die "You are not in the '$MEDIA_GROUP' group, which owns $MEDIA_ROOT.
    Fix with:  sudo usermod -aG $MEDIA_GROUP $USER   (then log out and back in)"
  fi

  # The group set of the systemd --user manager is what services actually
  # inherit, and it is fixed at login — being in the group is not enough.
  MANAGER_PID="$(pgrep -u "$USER" -f 'systemd --user' | head -1 || true)"
  if [[ -n "$MANAGER_PID" ]] && ! grep -E '^Groups:' "/proc/$MANAGER_PID/status" | grep -qw "$MEDIA_GID"; then
    warn "Your systemd --user manager does NOT carry gid $MEDIA_GID ($MEDIA_GROUP)."
    warn "It started before you joined that group, so services cannot write to $MEDIA_ROOT."
    warn "Reboot (or 'sudo loginctl terminate-user $USER' and log back in), then re-run this."
    die "Refusing to continue — downloads would fail with a permission error."
  fi
  ok "The systemd user manager carries gid $MEDIA_GID, so services can write there"

  if [[ "$(stat -c '%a' "$MEDIA_ROOT")" != "2775" ]]; then
    warn "$MEDIA_ROOT is mode $(stat -c '%a' "$MEDIA_ROOT"); 2775 (setgid) is wanted so new"
    warn "files inherit the group and stay readable by the media server."
  fi
else
  warn "$MEDIA_ROOT does not exist yet; it is created on the first download."
fi

# --------------------------------------------------------------------------
say "Starting the app under pm2"

cd "$REPO_DIR"
# startOrReload is idempotent: first run starts, later runs pick up config edits.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
ok "Process list saved to \$PM2_HOME/dump.pm2"

# --------------------------------------------------------------------------
say "Installing the systemd user unit"

mkdir -p "$UNIT_DIR"
[[ -f "$UNIT" ]] && cp -a "$UNIT" "$UNIT.bak.$(date +%Y%m%d%H%M%S)"

cat > "$UNIT" <<EOF
[Unit]
Description=pm2 process manager (circleftp-jellyfin)
Documentation=https://github.com/muztahiddurjoy/circleftp-jellyfin
After=network-online.target
Wants=network-online.target

[Service]
Type=forking

# pm2 resurrect re-reads \$PM2_HOME/dump.pm2, so whatever "pm2 save" last
# recorded is what comes back after a reboot. Re-run "pm2 save" after changes.
Environment=PM2_HOME=%h/.pm2
# node lives under nvm, which is not on a service's default PATH. This pins a
# node version — re-run deploy/setup-pm2.sh after switching node with nvm.
Environment=PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PIDFile=%h/.pm2/pm2.pid

ExecStart=$PM2_BIN resurrect
ExecReload=$PM2_BIN reload all
ExecStop=$PM2_BIN kill

Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE" >/dev/null
ok "Enabled $SERVICE"

# --------------------------------------------------------------------------
# A user unit dies at logout unless the account lingers. This is the one thing
# that genuinely needs root, and only once.
say "Checking boot persistence"

if [[ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" == "yes" ]]; then
  ok "Lingering is enabled — the app starts at boot without anyone logging in"
else
  warn "Lingering is NOT enabled for $USER."
  warn "Without it the app stops when you log out and does not start at boot."
  warn "Enable it once with:   sudo loginctl enable-linger $USER"
fi

# --------------------------------------------------------------------------
say "Verifying"

PORT="$(grep -E '^PORT=' "$REPO_DIR/packages/server/.env" | cut -d= -f2- || true)"
PORT="${PORT:-7070}"

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "Health check passed on port $PORT"
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || die "The app is not answering on port $PORT. Check: pm2 logs circleftp-jellyfin"

cat <<EOF

  Status    pm2 status
  Logs      pm2 logs circleftp-jellyfin
  Restart   pm2 restart circleftp-jellyfin
  Service   systemctl --user status $SERVICE

  After deploying new code:
    git pull && npm install && npm run build && pm2 restart circleftp-jellyfin

EOF
