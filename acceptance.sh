#!/bin/bash
set -uo pipefail
BASE="http://10.0.1.60:3430"
PASS=$(awk 'NR==2{print $3}' /root/.family-guardian-credentials)
COOKIES=$(mktemp); SIBCOOKIES=$(mktemp); GC=$(mktemp)
res(){ curl -s -w "\n--> HTTP %{http_code}" "${@}"; }

echo "=== A1: register w/o join code (expect 400) ==="
res -c "$GC" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"email":"no-code@test.com","password":"Pass1234!","name":"No Code"}'; echo

echo "=== A2: guardian login + /me ==="
LOGIN=$(curl -s -c "$COOKIES" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"email":"admin@juelzs.com","password":"'"$PASS"'"}')
echo "login: $LOGIN"
ME=$(curl -s -b "$COOKIES" "$BASE/api/auth/me")
echo "me: ${ME:0:200}"

echo "=== A3: /join-codes POST unauth (expect 401) ==="
res -o /dev/null -X POST "$BASE/api/auth/join-codes" -H "Content-Type: application/json" -d '{"role":"adult"}'; echo

echo "=== A4: guardian creates join code (expect 201) ==="
CREATE=$(curl -s -b "$COOKIES" -w "\n%{http_code}" -X POST "$BASE/api/auth/join-codes" -H "Content-Type: application/json" -d '{"role":"adult"}')
echo "create: $CREATE"
CODE=$(echo "$CREATE" | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("code",""))' 2>/dev/null)
echo "CODE=$CODE"

echo "=== A5: register w/ valid code (expect 201) ==="
res -c "$SIBCOOKIES" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"email":"sibling@family.com","password":"Pass1234!","name":"Sibling","joinCode":"'"$CODE"'"}'; echo

echo "=== A6: reuse same code (expect 400 used) ==="
res -o /dev/null -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"email":"dup@family.com","password":"Pass1234!","name":"Dup","joinCode":"'"$CODE"'"}'; echo

echo "=== A7: non-guardian /join-codes (expect 403) ==="
res -o /dev/null -b "$SIBCOOKIES" -X POST "$BASE/api/auth/join-codes" -H "Content-Type: application/json" -d '{"role":"adult"}'; echo

echo "=== A8: avatar wrong type (expect 400) ==="
res -o /dev/null -b "$SIBCOOKIES" -X POST "$BASE/api/auth/avatar" -H "Content-Type: application/json" -d '{"dataUrl":"data:image/gif;base64,SGVsbG8="}'; echo

echo "=== A9: avatar valid 1x1 PNG (expect 201) ==="
B64=$(python3 - <<'PY'
import base64
img=bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8c30000000300000154a259600000000049454e44ae426082')
print(base64.b64encode(img).decode())
PY
)
res -o /dev/null -b "$SIBCOOKIES" -X POST "$BASE/api/auth/avatar" -H "Content-Type: application/json" -d '{"dataUrl":"data:image/png;base64,'"$B64"'"}'; echo

echo "=== A10: sibling GET avatar bytes ==="
res -o /tmp/sib-avatar.png -b "$SIBCOOKIES" "$BASE/api/auth/avatar"; echo
echo "avatar file bytes: $(stat -c %s /tmp/sib-avatar.png 2>/dev/null)"

echo "=== A11: guardian lists members + codes ==="
MEM=$(curl -s -b "$COOKIES" "$BASE/api/auth/members"; echo)
echo "members: $(echo "$MEM" | head -c 300)"
res -o /dev/null -b "$COOKIES" -X GET "$BASE/api/auth/join-codes"; echo

echo "=== A12: avatars dir + survival across force-recreate ==="
AVDIR=$(curl -s -b "$SIBCOOKIES" "$BASE/api/auth/me" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("avatarPath",""))' 2>/dev/null)
echo "avatarPath=$AVDIR"
docker compose -p family -f /root/devvy/worktrees/WO-FAMDOTS-004/deployment/family/compose.coolify.yml up -d --force-recreate 2>&1 | tail -3
sleep 2
G2=$(curl -s -o /tmp/sib-avatar2.png -b "$SIBCOOKIES" -w "%{http_code}" "$BASE/api/auth/avatar")
echo "post-recreate GET avatar: HTTP $G2 bytes $(stat -c %s /tmp/sib-avatar2.png 2>/dev/null)"
cmp -s /tmp/sib-avatar.png /tmp/sib-avatar2.png && echo "AVATAR SURVIVES: yes" || echo "AVATAR SURVIVES: NO"

echo "=== DONE ==="
rm -f "$GC" "$COOKIES" "$SIBCOOKIES"
