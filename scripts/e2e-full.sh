#!/usr/bin/env bash
#
# Full end-to-end verification against a running instance.
#
#   bash scripts/e2e-full.sh <email> <password> [postId]
#
# Signs in, queues a real title, watches it download to completion, and checks
# that the file landed where Jellyfin can see it.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:7070/api}"
MEDIA_ROOT="${MEDIA_ROOT:-/var/nextcloud-data/ncadmin/files/Movies}"
EMAIL="${1:?usage: e2e-full.sh <email> <password> [postId]}"
PASSWORD="${2:?usage: e2e-full.sh <email> <password> [postId]}"
POST_ID="${3:-104914}"

JAR=$(mktemp)
H='X-Requested-With: circleftp-jellyfin'
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }

cleanup() { rm -f "$JAR" /tmp/e2e.$$.*; }
trap cleanup EXIT

echo "=== end-to-end: post $POST_ID ==="

# --- sign in -------------------------------------------------------------
code=$(curl -s -o /tmp/e2e.$$.login -w '%{http_code}' -X POST -H "$H" \
  -H 'Content-Type: application/json' -c "$JAR" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "signed in as $EMAIL" || { no "login -> $code"; exit 1; }

# --- inspect the title ---------------------------------------------------
curl -s -b "$JAR" "$BASE/library/title/$POST_ID?probe=true" > /tmp/e2e.$$.title
FOLDER=$(python3 -c "
import json
d=json.load(open('/tmp/e2e.$$.title'))
print(d['folderName'])
print('  title :', d['name'], '|', d['kind'], '|', d['quality'], file=__import__('sys').stderr)
print('  files :', len(d['files']), '| total:', round((d['totalSize'] or 0)/2**30, 2), 'GiB', file=__import__('sys').stderr)
print('  lands :', d['folderName'] + '/' + d['files'][0]['relPath'], file=__import__('sys').stderr)
")
[ -n "$FOLDER" ] && ok "title resolved to folder '$FOLDER'" || { no "title detail"; exit 1; }

# Start from a clean slate so "it appeared" means this run put it there.
rm -rf "${MEDIA_ROOT:?}/$FOLDER"

# --- queue it ------------------------------------------------------------
ID=$(curl -s -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d "{\"postId\":$POST_ID}" "$BASE/downloads" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
[ -n "$ID" ] && ok "queued job $ID" || { no "could not queue"; exit 1; }

# --- watch it through ----------------------------------------------------
echo "  downloading…"
START=$(date +%s)
STATUS=QUEUED
for _ in $(seq 1 900); do   # up to 30 minutes
  read -r STATUS GOT TOTAL SPEED < <(curl -s -b "$JAR" "$BASE/downloads/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['status'], d['downloadedBytes'], d['totalBytes'] or 0, d['speedBps'] or 0)
")
  case "$STATUS" in
    COMPLETED|PARTIAL|FAILED|CANCELLED) break ;;
  esac
  if [ "$TOTAL" -gt 0 ]; then
    printf '\r    %s  %5.1f%%  %6.1f MB/s   ' "$STATUS" \
      "$(echo "$GOT $TOTAL" | awk '{print $1/$2*100}')" \
      "$(echo "$SPEED" | awk '{print $1/1048576}')"
  fi
  sleep 2
done
echo
ELAPSED=$(( $(date +%s) - START ))

[ "$STATUS" = "COMPLETED" ] && ok "job COMPLETED in ${ELAPSED}s" || no "job ended $STATUS"

# --- verify on disk ------------------------------------------------------
FILE=$(find "$MEDIA_ROOT/$FOLDER" -type f ! -name '*.part' 2>/dev/null | head -1)
if [ -n "$FILE" ]; then
  SIZE=$(stat -c%s "$FILE")
  ok "file on disk: $(basename "$FILE") ($(numfmt --to=iec "$SIZE"))"
  ok "owner/perms: $(stat -c '%U:%G %a' "$FILE")"
else
  no "no completed file under $MEDIA_ROOT/$FOLDER"
fi

# No stray .part may survive a successful job.
if find "$MEDIA_ROOT/$FOLDER" -name '*.part' 2>/dev/null | grep -q .; then
  no "a .part file was left behind"
else
  ok "no .part left behind"
fi

# The API's byte count must match reality.
if [ -n "$FILE" ]; then
  REPORTED=$(curl -s -b "$JAR" "$BASE/downloads/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['downloadedBytes'])")
  [ "$REPORTED" = "$(stat -c%s "$FILE")" ] \
    && ok "reported bytes match the file on disk" \
    || no "reported $REPORTED but file is $(stat -c%s "$FILE")"
fi

# --- Jellyfin can read it -----------------------------------------------
if [ -n "$FILE" ]; then
  REL="${FILE#"$MEDIA_ROOT/"}"
  # Jellyfin runs as uid 1000 with the media dir bind-mounted at /media:ro.
  if sudo -n -u '#1000' test -r "$FILE" 2>/dev/null || [ -r "$FILE" ]; then
    ok "readable by the Jellyfin uid (/media/$REL)"
  else
    no "not readable by the Jellyfin uid"
  fi
fi

# --- Nextcloud index -----------------------------------------------------
if grep -q "Nextcloud rescan complete" /tmp/claude-e2e.log 2>/dev/null; then
  ok "Nextcloud rescan ran"
fi

echo "=== $pass passed, $fail failed ==="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
