#!/bin/bash
# Loads .env.local + DEMO_JWT, then runs run-loop.js
set -e
ENV_FILE='/c/Users/Heath Shepard/Desktop/MeetDossie/.env.local'
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  exit 1
fi
# Export only the keys we need (strip surrounding double quotes)
while IFS= read -r line; do
  key="${line%%=*}"
  val="${line#*=}"
  # Strip leading/trailing double quotes if present
  val="${val#\"}"
  val="${val%\"}"
  export "$key=$val"
done < <(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|DOCUSEAL_API_KEY|CRON_SECRET)=' "$ENV_FILE")
if [ -z "$DEMO_JWT" ]; then
  if [ -f "/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp/dossie-sign-e2e-loop/jwt.txt" ]; then
    export DEMO_JWT=$(cat "/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp/dossie-sign-e2e-loop/jwt.txt")
  else
    echo "Missing DEMO_JWT and no jwt.txt"
    exit 1
  fi
fi
cd "/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp/dossie-sign-e2e-loop"
node run-loop.js
