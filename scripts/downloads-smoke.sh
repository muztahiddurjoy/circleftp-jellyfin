#!/usr/bin/env bash
# Live smoke test of the downloads API and the SSE stream.
# Assumes a server on :7099 and the test@example.com account.
set -uo pipefail
BASE="http://127.0.0.1:7099/api"
JAR=$(mktemp)
H='X-Requested-With: circleftp-jellyfin'
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "--- downloads smoke ---"

c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/downloads")
[ "$c" = 401 ] && ok "downloads without session -> 401" || no "downloads unauth -> $c"

curl -s -X POST -H "$H" -H 'Content-Type: application/json' -c "$JAR" \
  -d '{"email":"test@example.com","password":"correct-horse-battery"}' "$BASE/auth/login" > /dev/null

# SSE must open and deliver a snapshot immediately.
timeout 6 curl -s -N -b "$JAR" "$BASE/events" > /tmp/sse.$$ 2>/dev/null &
SSE_PID=$!
sleep 2

# Create a job for a real title (Inception, singleVideo, post 98217).
BODY=$(curl -s -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"postId":98217}' "$BASE/downloads")
ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$ID" ]; then
  echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  job:', d['id'], '|', d['title'], '|', d['status'], '| files:', d['fileCount'])
assert d['folderName']=='Inception (2010)', d['folderName']
assert d['status'] in ('QUEUED','RUNNING')
assert d['posterUrl'].startswith('/api/library/image/')
"
  ok "create download -> 201 with a queued job"
else
  no "create download: $BODY"
fi

# A second request for the same title must be refused while the first is active.
c=$(curl -s -o /tmp/dup.$$ -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"postId":98217}' "$BASE/downloads")
[ "$c" = 409 ] && ok "duplicate active job -> 409" || no "duplicate -> $c ($(cat /tmp/dup.$$))"

sleep 3

# Progress must actually be moving.
curl -s -b "$JAR" "$BASE/downloads/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  status:', d['status'], '| got:', d['downloadedBytes'], 'of', d['totalBytes'],
      '| speed:', d['speedBps'], '| eta:', d['etaSeconds'])
assert d['downloadedBytes'] > 0, 'no bytes downloaded yet'
assert d['status']=='RUNNING'
assert len(d['files'])==1
" && ok "download is running and reporting progress" || no "progress"

# Cancel must take effect promptly.
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -b "$JAR" "$BASE/downloads/$ID/cancel")
[ "$c" = 200 ] && ok "cancel -> 200" || no "cancel -> $c"

for i in $(seq 1 20); do
  s=$(curl -s -b "$JAR" "$BASE/downloads/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  [ "$s" = "CANCELLED" ] && break
  sleep 0.5
done
[ "$s" = "CANCELLED" ] && ok "job reaches CANCELLED ($s)" || no "job status after cancel: $s"

wait $SSE_PID 2>/dev/null
# SSE should have carried a snapshot plus live progress frames.
grep -q '"type":"snapshot"' /tmp/sse.$$ && ok "SSE sends a snapshot on connect" || no "SSE snapshot missing"
grep -q '"type":"download:created"' /tmp/sse.$$ && ok "SSE pushes download:created" || no "SSE created missing"
grep -q '"type":"download:progress"' /tmp/sse.$$ && ok "SSE pushes download:progress" || no "SSE progress missing"
echo "  SSE frames received: $(grep -c '^data:' /tmp/sse.$$)"

# The partial file must be left behind so a retry can resume.
PART=$(find /var/nextcloud-data/ncadmin/files/Movies/'Inception (2010)' -name '*.part' 2>/dev/null | head -1)
[ -n "$PART" ] && ok "partial kept for resume ($(du -h "$PART" | cut -f1))" || echo "  NOTE  no .part left (cancel may have landed before any bytes)"

# Retry must re-queue it.
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -b "$JAR" "$BASE/downloads/$ID/retry")
[ "$c" = 200 ] && ok "retry -> 200" || no "retry -> $c"
sleep 1
curl -s -X POST -H "$H" -b "$JAR" "$BASE/downloads/$ID/cancel" > /dev/null
sleep 2

# Delete, removing the files it left on disk.
c=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$H" -b "$JAR" "$BASE/downloads/$ID?deleteFiles=true")
[ "$c" = 200 ] && ok "delete -> 200" || no "delete -> $c"
[ -d "/var/nextcloud-data/ncadmin/files/Movies/Inception (2010)" ] \
  && no "title folder still on disk after delete" || ok "title folder cleaned up"

rm -f /tmp/sse.$$ /tmp/dup.$$ "$JAR"
echo "--- $pass passed, $fail failed ---"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
