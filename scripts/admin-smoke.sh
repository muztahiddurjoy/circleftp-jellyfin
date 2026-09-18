#!/usr/bin/env bash
#
# Live smoke test of the account and admin surface.
#
#   bash scripts/admin-smoke.sh <admin-email> <admin-password>
#
# Creates a throwaway user, exercises every admin action against it, then
# removes it. Does not touch the calling admin's own account.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:7070/api}"
ORIGIN="${ORIGIN:-http://127.0.0.1:7070}"
EMAIL="${1:?usage: admin-smoke.sh <admin-email> <admin-password>}"
PASSWORD="${2:?usage: admin-smoke.sh <admin-email> <admin-password>}"

JAR=$(mktemp); VICTIM_JAR=$(mktemp)
H='X-Requested-With: circleftp-jellyfin'
TEST_EMAIL="smoke-$$@example.com"
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
cleanup() { rm -f "$JAR" "$VICTIM_JAR" /tmp/as.$$.*; }
trap cleanup EXIT

# Read a dotted path out of JSON on stdin, e.g. `jget user.id`.
# The path is passed as argv so its quoting cannot collide with the shell's.
jget() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    if value is None:
        break
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else value)
' "$1" 2>/dev/null
}

echo "=== account + admin smoke ==="

code=$(curl -s -o /tmp/as.$$.login -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -c "$JAR" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "signed in as admin" || { no "login -> $code"; exit 1; }

# --- users list ----------------------------------------------------------
curl -s -b "$JAR" "$BASE/admin/users" > /tmp/as.$$.users
python3 -c "
import json
d=json.load(open('/tmp/as.$$.users'))
me=[u for u in d['users'] if u['isSelf']][0]
print('  admin row:', me['email'], '| role', me['role'], '| sessions', me['sessionCount'])
assert me['role']=='ADMIN'
" && ok "user list marks the caller's own row" || no "user list"

# --- create a throwaway user --------------------------------------------
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$TEST_EMAIL\",\"role\":\"USER\"}" \
  "$BASE/admin/users" > /tmp/as.$$.created
NEW_ID=$(jget user.id < /tmp/as.$$.created)
NEW_PW=$(jget generatedPassword < /tmp/as.$$.created)
[ -n "$NEW_ID" ] && [ ${#NEW_PW} -ge 20 ] && ok "created user with a generated password" || { no "create user: $(cat /tmp/as.$$.created)"; exit 1; }

# The generated password must actually work.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -c "$VICTIM_JAR" -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$NEW_PW\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "new user can sign in" || no "new user login -> $code"

# A regular user must not reach admin endpoints.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$VICTIM_JAR" "$BASE/admin/users")
[ "$code" = 403 ] && ok "non-admin refused admin endpoints (403)" || no "non-admin got $code"

# --- self-service password change ---------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -b "$VICTIM_JAR" -d "{\"currentPassword\":\"wrong-one-entirely\",\"newPassword\":\"changed-by-user-pw\"}" \
  "$BASE/account/password")
[ "$code" = 400 ] && ok "password change rejects a wrong current password" || no "wrong current -> $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -b "$VICTIM_JAR" -c "$VICTIM_JAR" \
  -d "{\"currentPassword\":\"$NEW_PW\",\"newPassword\":\"changed-by-user-pw\"}" "$BASE/account/password")
[ "$code" = 200 ] && ok "password change succeeds" || no "password change -> $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"changed-by-user-pw\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "new password works" || no "new password -> $code"

# --- profile -------------------------------------------------------------
curl -s -X PATCH -H "$H" -H 'Content-Type: application/json' -b "$VICTIM_JAR" \
  -d '{"name":"Renamed Smoke"}' "$BASE/account/profile" > /tmp/as.$$.profile
[ "$(jget user.name < /tmp/as.$$.profile)" = "Renamed Smoke" ] \
  && ok "display name updated" || no "profile update"

# --- admin-issued reset link --------------------------------------------
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"expiresInHours":24}' "$BASE/admin/users/$NEW_ID/reset-link" > /tmp/as.$$.reset
RESET_URL=$(jget url < /tmp/as.$$.reset)
TOKEN=$(printf '%s' "$RESET_URL" | sed 's/.*token=//')
[ ${#TOKEN} -ge 20 ] && ok "reset link issued ($ORIGIN$RESET_URL)" || { no "reset link: $(cat /tmp/as.$$.reset)"; }

curl -s "$BASE/account/reset/check?token=$TOKEN" > /tmp/as.$$.check
[ "$(jget valid < /tmp/as.$$.check)" = "True" ] \
  && ok "reset link validates before use" || no "reset check: $(cat /tmp/as.$$.check)"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"newPassword\":\"reset-link-password\"}" "$BASE/account/reset")
[ "$code" = 200 ] && ok "reset link redeemed" || no "redeem -> $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"newPassword\":\"second-attempt-pw\"}" "$BASE/account/reset")
[ "$code" = 400 ] && ok "reset link is single-use" || no "reuse -> $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"reset-link-password\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "password from the reset link works" || no "post-reset login -> $code"

# --- lock-out protection on the real admin account ----------------------
MY_ID=$(python3 -c "
import json
d=json.load(open('/tmp/as.$$.users'))
print([u for u in d['users'] if u['isSelf']][0]['id'])
")
ADMINS=$(python3 -c "
import json
d=json.load(open('/tmp/as.$$.users'))
print(len([u for u in d['users'] if u['role']=='ADMIN' and not u['disabled']]))
")
if [ "$ADMINS" = "1" ]; then
  code=$(curl -s -o /tmp/as.$$.demote -w '%{http_code}' -X PATCH -H "$H" -H 'Content-Type: application/json' \
    -b "$JAR" -d '{"role":"USER"}' "$BASE/admin/users/$MY_ID")
  if [ "$code" = 409 ]; then
    ok "refuses to demote the only admin (409 last_admin)"
  else
    no "demoting the only admin returned $code — should be 409"
  fi
else
  echo "  SKIP  demote-last-admin (there are $ADMINS active admins)"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -H 'Content-Type: application/json' \
  -b "$JAR" -d '{"disabled":true}' "$BASE/admin/users/$MY_ID")
[ "$code" = 400 ] && ok "refuses to disable your own account" || no "self-disable -> $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$H" -b "$JAR" "$BASE/admin/users/$MY_ID")
[ "$code" = 400 ] && ok "refuses to delete your own account" || no "self-delete -> $code"

# --- disable / enable the throwaway user --------------------------------
curl -s -o /dev/null -X PATCH -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"disabled":true}' "$BASE/admin/users/$NEW_ID"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"reset-link-password\"}" "$BASE/auth/login")
[ "$code" = 403 ] && ok "a disabled account cannot sign in" || no "disabled login -> $code"

curl -s -o /dev/null -X PATCH -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"disabled":false}' "$BASE/admin/users/$NEW_ID"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"reset-link-password\"}" "$BASE/auth/login")
[ "$code" = 200 ] && ok "re-enabling restores access" || no "re-enabled login -> $code"

# --- invites -------------------------------------------------------------
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"role":"USER","expiresInDays":7,"note":"smoke test"}' "$BASE/admin/invites" > /tmp/as.$$.invite
INVITE_ID=$(jget invite.id < /tmp/as.$$.invite)
INVITE_CODE=$(jget invite.code < /tmp/as.$$.invite)
[ -n "$INVITE_CODE" ] && ok "invite created (code $INVITE_CODE)" || no "invite create"

curl -s -b "$JAR" "$BASE/admin/invites" | python3 -c "
import json,sys
d=json.load(sys.stdin)
inv=[i for i in d['invites'] if i['code']=='$INVITE_CODE'][0]
assert inv['status']=='pending', inv['status']
assert inv['note']=='smoke test'
print('  invite:', inv['code'], '|', inv['status'], '| by', inv['createdByName'])
" && ok "invite listed as pending" || no "invite list"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$H" -b "$JAR" "$BASE/admin/invites/$INVITE_ID")
[ "$code" = 200 ] && ok "invite revoked" || no "invite revoke -> $code"

# --- clean up ------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$H" -b "$JAR" "$BASE/admin/users/$NEW_ID")
[ "$code" = 200 ] && ok "throwaway user deleted" || no "delete throwaway -> $code"

echo "=== $pass passed, $fail failed ==="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
