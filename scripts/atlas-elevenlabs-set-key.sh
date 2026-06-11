#!/bin/bash
# Atlas — set new ElevenLabs API key (manual completion path)
# Usage: ./atlas-elevenlabs-set-key.sh <NEW_KEY>

set -e

KEY="$1"
if [ -z "$KEY" ] || [[ "$KEY" != sk_* ]]; then
  echo "Usage: $0 sk_..."
  exit 1
fi

cd /c/Users/Heath\ Shepard/Desktop/MeetDossie

echo "Updating .env.local..."
sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=\"$KEY\"|" .env.local

echo "Updating Jarvis .env..."
sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=$KEY|" \
  /c/Users/Heath\ Shepard/Desktop/Shepard-Ventures/products/jarvis-cole/.env

echo "Removing old Vercel ELEVENLABS_API_KEY (production)..."
yes | vercel env rm ELEVENLABS_API_KEY production 2>&1 | tail -3 || true

echo "Adding new Vercel ELEVENLABS_API_KEY (production)..."
printf '%s' "$KEY" | vercel env add ELEVENLABS_API_KEY production 2>&1 | tail -3

echo "Triggering redeploy via empty commit on main..."
git checkout main 2>&1 | tail -1
git pull --rebase 2>&1 | tail -1 || true
git commit --allow-empty -m "chore(env): rotate ELEVENLABS_API_KEY (new account)" 2>&1 | tail -1
git push origin main 2>&1 | tail -3

echo "Waiting 60s for deploy..."
sleep 60

echo "Testing /api/speak..."
RESP=$(curl -s -X POST 'https://meetdossie.com/api/speak' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Atlas online."}' \
  -D /tmp/speak-headers.txt -o /tmp/speak-body.bin \
  -w '%{http_code}')
PROVIDER=$(grep -i '^x-tts-provider:' /tmp/speak-headers.txt | cut -d' ' -f2 | tr -d '\r\n')
SIZE=$(stat -c '%s' /tmp/speak-body.bin)

echo "HTTP: $RESP, provider: $PROVIDER, size: $SIZE bytes"

if [ "$RESP" = "200" ] && [ "$PROVIDER" = "elevenlabs" ]; then
  echo "SUCCESS"
else
  echo "WARN: not back on elevenlabs yet — Vercel may need another 30s"
fi
