#!/bin/bash
# Atlas — runs after atlas-elevenlabs-signup-v2.js completes.
# Extracts API key from RESULT_JSON, pushes to Vercel env, triggers main-branch redeploy via empty commit,
# tests /api/speak.

set -e

LOG=/c/Users/HEATHS~1/AppData/Local/Temp/claude/C--Users-Heath-Shepard-Desktop-MeetDossie/e915d26a-8b79-4ca6-958f-4b7cd6c969f1/tasks/bj1snwkw3.output

# Wait for RESULT_JSON line
echo "Waiting for signup script to write RESULT_JSON..."
while ! grep -q 'RESULT_JSON:' "$LOG" 2>/dev/null; do
  sleep 5
done

RESULT=$(grep 'RESULT_JSON:' "$LOG" | tail -1 | sed 's/^.*RESULT_JSON://')
echo "Result: $RESULT"

OK=$(echo "$RESULT" | python -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
if [ "$OK" != "True" ]; then
  echo "Signup did not succeed. Aborting Vercel update."
  exit 1
fi

KEY=$(echo "$RESULT" | python -c "import json,sys; print(json.load(sys.stdin).get('api_key', ''))" 2>/dev/null || echo "")
if [ -z "$KEY" ] || [[ "$KEY" != sk_* ]]; then
  echo "No valid API key in result."
  exit 1
fi

echo ""
echo "Captured API key: ${KEY:0:14}..."

echo ""
echo "Updating local .env.local..."
cd /c/Users/Heath\ Shepard/Desktop/MeetDossie
sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=\"$KEY\"|" .env.local

echo "Updating Jarvis .env..."
sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=$KEY|" /c/Users/Heath\ Shepard/Desktop/Shepard-Ventures/products/jarvis-cole/.env

echo ""
echo "Updating Vercel ELEVENLABS_API_KEY (production)..."
# Remove old, add new
yes | vercel env rm ELEVENLABS_API_KEY production 2>&1 | tail -3 || true
printf '%s' "$KEY" | vercel env add ELEVENLABS_API_KEY production 2>&1 | tail -3

echo ""
echo "Triggering main-branch redeploy via empty commit..."
git checkout main 2>&1 | tail -1
git pull --rebase 2>&1 | tail -1
git commit --allow-empty -m "chore(env): rotate ELEVENLABS_API_KEY (new account heathshepard@meetdossie.com)" 2>&1 | tail -1
git push origin main 2>&1 | tail -3

echo ""
echo "Pushed. Vercel auto-deploy will pick up new env var. Waiting 60s for deploy..."
sleep 60

echo ""
echo "Testing /api/speak..."
RESP=$(curl -s -X POST 'https://meetdossie.com/api/speak' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Atlas online."}' \
  -D /tmp/speak-headers.txt -o /tmp/speak-body.bin \
  -w '%{http_code}')
PROVIDER=$(grep -i '^x-tts-provider:' /tmp/speak-headers.txt | cut -d' ' -f2 | tr -d '\r\n')
SIZE=$(stat -c '%s' /tmp/speak-body.bin 2>/dev/null || stat -f '%z' /tmp/speak-body.bin)
echo "  HTTP: $RESP, provider: $PROVIDER, size: $SIZE bytes"

if [ "$RESP" = "200" ] && [ "$PROVIDER" = "elevenlabs" ]; then
  echo "SUCCESS: Talk to Dossie is back on ElevenLabs."
else
  echo "WARN: /api/speak returned $RESP / provider=$PROVIDER. Investigate."
fi

# Telegram ping
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN' .env.local | cut -d'"' -f2)
curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
  -d "chat_id=7874782923" \
  -d "text=Atlas: ElevenLabs Mission 1 complete. New key live in Vercel. /api/speak HTTP $RESP, provider=$PROVIDER. Jarvis .env updated. Stand by for Jarvis launch instructions." > /dev/null

echo "DONE"
