#!/bin/bash
set -e
TOKEN=$(grep "TELEGRAM_BOT_TOKEN=" "/c/Users/Heath Shepard/.claude/channels/telegram/.env" | cut -d= -f2-)
CHAT_ID=7874782923
DIR="/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp/v3-fha-verify"

# Send opening text message
curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "text=ATLAS v3-FHA verification on staging — 4 PDFs from extract-form-fields(Opus 4.7) → fill-forms-batch. Bundle workspace-rvk6ZJHK.js live. extract returned: buyer=Heath Shepard, seller=Josh Sissam, sale=500000, FHA, HOA=Cibolo Canyons 145/200, built 1972." \
  > /dev/null

for FORM in resale-contract financing-addendum hoa-addendum lead-paint-addendum; do
  PDF="$DIR/$FORM.pdf"
  if [ -f "$PDF" ]; then
    SIZE=$(stat -c%s "$PDF" 2>/dev/null || stat -f%z "$PDF")
    echo "Sending $FORM ($SIZE bytes)..."
    curl -s "https://api.telegram.org/bot${TOKEN}/sendDocument" \
      -F "chat_id=${CHAT_ID}" \
      -F "document=@${PDF}" \
      -F "caption=${FORM}" \
      | head -c 200
    echo ""
    sleep 1
  fi
done

echo "All 4 PDFs sent."
