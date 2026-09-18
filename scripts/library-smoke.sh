#!/usr/bin/env bash
# Live smoke test of the library proxy against the real Circle FTP API.
set -uo pipefail
BASE="http://127.0.0.1:7099/api"
JAR=$(mktemp)
H='X-Requested-With: circleftp-jellyfin'
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "--- library smoke (live upstream) ---"

# unauthenticated must be refused
c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/library/search?q=inception")
[ "$c" = 401 ] && ok "search without session -> 401" || no "search without session -> $c"

curl -s -X POST -H "$H" -H 'Content-Type: application/json' -c "$JAR" \
  -d '{"email":"test@example.com","password":"correct-horse-battery"}' "$BASE/auth/login" > /dev/null

# --- movie search ---
BODY=$(curl -s -b "$JAR" "$BASE/library/search?q=inception&kind=movie&limit=5")
echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
r=d['results']
assert len(r)>0, 'no results'
top=r[0]
print('  top result:', top['name'], top['year'], '|', top['kind'], '|', top['match'], '|', top['postId'])
assert top['kind']=='movie'
assert top['posterUrl'].startswith('/api/library/image/'), top['posterUrl']
assert all(x['kind']=='movie' for x in r), 'kind filter leaked'
print('  results:', len(r))
" && ok "movie search returns ranked, filtered, proxied results" || no "movie search"

# --- series search with enrichment ---
curl -s -b "$JAR" "$BASE/library/search?q=breaking+bad&kind=series&limit=3" | python3 -c "
import json,sys
d=json.load(sys.stdin)
r=d['results']
if not r:
    print('  (no series results for this query - skipping enrichment assert)')
else:
    top=r[0]
    print('  top series:', top['name'], '| seasons:', top.get('seasonCount'), '| eps:', top.get('episodeCount'))
    assert top['kind']=='series'
" && ok "series search works" || no "series search"

# --- title detail for a known singleVideo (Inception, post 98217) ---
curl -s -b "$JAR" "$BASE/library/title/98217" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  folder:', repr(d['folderName']))
print('  type:', d['type'], '| kind:', d['kind'], '| files:', len(d['files']))
print('  file[0]:', repr(d['files'][0]['relPath']))
assert d['folderName']=='Inception (2010)', d['folderName']
assert d['kind']=='movie'
assert len(d['files'])==1
assert d['alreadyQueued'] is False
assert d['totalSize'] is None  # not probed
" && ok "title detail builds the Jellyfin folder layout" || no "title detail"

# --- title detail with size probing ---
curl -s -b "$JAR" "$BASE/library/title/98217?probe=true" | python3 -c "
import json,sys
d=json.load(sys.stdin)
size=d['files'][0]['size']
print('  probed size:', size, 'bytes =', round((size or 0)/2**30,2), 'GiB')
assert size and size > 100*1024*1024, 'probe did not return a plausible size'
assert d['totalSize']==size
" && ok "size probing reaches the file host" || no "size probing"

# --- poster proxy ---
read -r code ctype < <(curl -s -b "$JAR" -o /tmp/poster.$$ -w '%{http_code} %{content_type}' \
  "$BASE/library/image/bf926ac8-2312-4e02-8f74-316e2f1893c8.jpeg")
bytes=$(stat -c%s /tmp/poster.$$ 2>/dev/null || echo 0)
echo "  poster: HTTP $code $ctype ${bytes}B"
{ [ "$code" = 200 ] && [ "$bytes" -gt 1000 ]; } && ok "poster proxy serves an image" || no "poster proxy"

# second fetch should come from the disk cache
curl -s -b "$JAR" -o /dev/null "$BASE/library/image/bf926ac8-2312-4e02-8f74-316e2f1893c8.jpeg"
find /home/muz-server/circleftp-jellyfin/packages/server/var/cache/posters -type f 2>/dev/null | head -2 | grep -q . \
  && ok "poster cached to disk" || no "poster not cached"

# --- path traversal must be refused ---
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/library/image/..%2f..%2f..%2fetc%2fpasswd")
[ "$c" = 400 ] || [ "$c" = 404 ] && ok "traversal in poster name refused ($c)" || no "traversal returned $c"

# --- bad input ---
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/library/search?q=")
[ "$c" = 400 ] && ok "empty query -> 400" || no "empty query -> $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/library/title/999999999")
[ "$c" = 404 ] && ok "unknown title -> 404" || no "unknown title -> $c"

rm -f /tmp/poster.$$ "$JAR"
echo "--- $pass passed, $fail failed ---"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
