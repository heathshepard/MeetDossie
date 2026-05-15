#!/bin/bash
SECRET="240fd4ebb0a46a61262a20e2000402bb4402dd9a7d426f00631e99c056b4bc8c"

echo "Waiting for Vercel deployment..."
for i in {1..20}; do
  RESULT=$(curl -s "https://meetdossie.com/api/update-facebook-cap?cap=2&secret=$SECRET" 2>&1)
  if echo "$RESULT" | grep -q '"ok"'; then
    echo "✅ STEP 1: Facebook cap increased to 2"
    echo "$RESULT"
    break
  fi
  echo "Attempt $i: Not ready yet..."
  sleep 5
done

echo ""
echo "Creating test post..."
TEST_RESULT=$(curl -s "https://meetdossie.com/api/create-test-post?secret=$SECRET")
echo "✅ STEP 2: Test post created and sent to Telegram"
echo "$TEST_RESULT"

echo ""
echo "✋ Waiting for Heath to approve in Telegram..."
echo "After approval, manually trigger: curl https://meetdossie.com/api/cron-publish-approved -H 'Authorization: Bearer $SECRET'"
