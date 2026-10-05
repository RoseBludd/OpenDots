#!/bin/bash
set -euo pipefail
BASE=https://family.geniuzs.com
API=$BASE/api/auth
PASS=$(awk -F' / ' '{print $NF}' /root/.family-guardian-credentials)
FAILED=0
pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; FAILED=1; }
check(){ local n="$1"; local code="$2"; if [ "$code" = "$3" ]; then pass "$n -> $code"; else fail "$n expected $3 got $code"; fi; }

# 1. register w/o code -> 400
r=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/register -d '{"name":"NoCode","email":"nocode-acceptance-test@family.geniuzs.com","password":"x","joinCode":""}')
check "register no code" "$r" "400"

# 2. get guardian session
session=$(curl -s -c /tmp/curlcookies -X POST $API/login -d '{"email":"admin@juelzs.com","password":"'$PASS'"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session'])")
echo "guardian session: ${session:0:32}..."

# 3. /join-codes unauth -> 401
check "join-codes unauth" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/auth/join-codes)" "401"

# 4. /join-codes non-guardian -> 403
check "join-codes non-guardian" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$session" $BASE/api/auth/join-codes?filter=mine)" "403"

# 5. create sibling guardian then non-guardian 403 on /join-codes POST
sib=$(curl -s -c /tmp/sibcookies -X POST $API/register -d '{"name":"Sibling","email":"sibling-acceptance@family.geniuzs.com","password":"x","joinCode":""}')
sibcode=$(echo $sib | python3 -c "import sys,json;print(json.load(sys.stdin)['session'])")
check "sibling join-codes POST non-guardian" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$sibcode" -X POST $BASE/api/auth/join-codes -d '{"role":"adult","expiresInHours":""}')" "403"

# 6. guardian creates code
rcode=$(curl -s -H "Cookie: session=$session" -X POST $API/join-codes -d '{"role":"adult","expiresInHours":""}' | python3 -c "import sys,json;print(d.get('code',''))" d="$(curl -s -H "Cookie: session=$session" -X POST $API/join-codes -d '{"role":"adult","expiresInHours":""}')")
echo "generated code: $rcode"
if [ -z "$rcode" ]; then fail "join code empty"; fi
check "guardian create code 201" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$session" -X POST $API/join-codes -d '{"role":"adult","expiresInHours":""}')" "201"

# 7. join sibling with valid code -> 201
rid=$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/joincookies -X POST $API/register -d '{"name":"JoinTest Adult","email":"join-test-adult@family.geniuzs.com","password":"x","joinCode":"'$rcode'"}')
check "join valid code -> 201" "$rid" "201"
jcode=$(curl -s -c /tmp/joincookies -X POST $API/register -d '{"name":"JoinTest Adult","email":"join-test-adult@family.geniuzs.com","password":"x","joinCode":"'$rcode'"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session'])")

# 8. same code reused -> 400
check "join reused code -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/register -d '{"name":"JoinTest Adult","email":"join-test-adult@family.geniuzs.com","password":"x","joinCode":"'$rcode'"}')" "400"

# 9. expired code -> 400
ex=$(curl -s -H "Cookie: session=$session" -X POST $API/join-codes -d '{"role":"kid","expiresInHours":"0.001"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
check "expired code -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/register -d '{"name":"KidJoin","email":"kidjoin@family.geniuzs.com","password":"x","joinCode":"'$ex'"}')" "400"

# 10. invalid code -> 400
check "invalid code -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/register -d '{"name":"BadJoin","email":"badjoin@family.geniuzs.com","password":"x","joinCode":"ZZZZZZZZ"}')" "400"

# 11. avatar: wrong type -> 400
check "avatar gif type -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$jcode" -X POST $API/avatar -d '{"dataUrl":"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}')" "400"

# 12. valid avatar -> 201
png=$(base64 -w0 /root/devvy/preview/acceptance-test-avatar.png 2>/dev/null || printf '%s' "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
check "avatar valid PNG -> 201" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$jcode" -X POST $API/avatar -d '{"dataUrl":"data:image/png;base64,'$png'"}')" "201"

# 13. avatar GET serves bytes
auid=$(curl -s -H "Cookie: session=$jcode" $API/me | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
a=$(curl -s -o /tmp/avatar.png -w '%{http_code}' -H "Cookie: session=$jcode" $BASE/api/auth/avatar?userId=$auid)
if [ -s /tmp/avatar.png ]; then pass "avatar GET -> bytes saved, $(wc -c < /tmp/avatar.png)B"; else fail "avatar GET empty, code=$a"; fi

# 14. guardian sees member in /members
mc=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: session=$session" $API/members)
mem=$(curl -s -H "Cookie: session=$session" $API/members | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
check "guardian /members list" "$mc" "200"
echo "members count: $mem"
if [ "$mem" -ge 2 ]; then pass "guardian sees sibling+join-test members"; else fail "members count $mem < 2"; fi

# 15. /config reads
cfg=$(curl -s -o /dev/null -w '%{http_code}' $API/config)
mode=$(curl -s $API/config | python3 -c "import sys,json;print(json.load(sys.stdin)['mode'])")
check "/config reads" "$cfg" "200"
echo "config mode: $mode"

exit $FAILED
