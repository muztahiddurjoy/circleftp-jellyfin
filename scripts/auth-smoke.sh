#!/usr/bin/env bash
# Live smoke test of the auth flow against a running server.
set -uo pipefail
BASE="http://127.0.0.1:7099/api"
JAR=$(mktemp)
H='X-Requested-With: circleftp-jellyfin'
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}

code() { curl -s -o /tmp/body.$$ -w '%{http_code}' "$@"; }

echo "--- auth smoke ---"

c=$(code -b "$JAR" "$BASE/auth/me")
check "me without session -> 401" 401 "$c"

c=$(code -X POST -H "$H" -H 'Content-Type: application/json' -c "$JAR" \
  -d '{"email":"test@example.com","password":"wrong-password-here"}' "$BASE/auth/login")
check "login with wrong password -> 401" 401 "$c"

c=$(code -X POST -H 'Content-Type: application/json' -c "$JAR" \
  -d '{"email":"test@example.com","password":"correct-horse-battery"}' "$BASE/auth/login")
check "login without CSRF header -> 403" 403 "$c"

c=$(code -X POST -H "$H" -H 'Content-Type: application/json' -c "$JAR" \
  -d '{"email":"test@example.com","password":"correct-horse-battery"}' "$BASE/auth/login")
check "login with correct password -> 200" 200 "$c"
grep -q 'cfj_session' "$JAR" && echo "  PASS  session cookie set" && pass=$((pass+1)) \
  || { echo "  FAIL  session cookie not set"; fail=$((fail+1)); }
grep -q 'HttpOnly' <(curl -s -D- -o /dev/null -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"correct-horse-battery"}' "$BASE/auth/login") \
  && echo "  PASS  cookie is HttpOnly" && pass=$((pass+1)) \
  || { echo "  FAIL  cookie is not HttpOnly"; fail=$((fail+1)); }

c=$(code -b "$JAR" "$BASE/auth/me")
check "me with session -> 200" 200 "$c"
grep -q '"role":"ADMIN"' /tmp/body.$$ && echo "  PASS  me returns the account" && pass=$((pass+1)) \
  || { echo "  FAIL  me payload wrong: $(cat /tmp/body.$$)"; fail=$((fail+1)); }

c=$(code -X POST -H "$H" -H 'Content-Type: application/json' -b "$JAR" \
  -d '{"code":"NOPENOPENOPE","name":"x","email":"x@y.com","password":"averylongpassword"}' "$BASE/auth/redeem")
check "redeem bad invite -> 400" 400 "$c"

c=$(code -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","password":"x"}' "$BASE/auth/login")
check "login with invalid email -> 400" 400 "$c"

c=$(code -X POST -H "$H" -b "$JAR" -c "$JAR" "$BASE/auth/logout")
check "logout -> 200" 200 "$c"

c=$(code -b "$JAR" "$BASE/auth/me")
check "me after logout -> 401" 401 "$c"

rm -f /tmp/body.$$ "$JAR"
echo "--- $pass passed, $fail failed ---"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
