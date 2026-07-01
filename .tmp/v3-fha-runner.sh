#!/bin/bash
set -e
ENV_FILE='/c/Users/Heath Shepard/Desktop/MeetDossie/.env.local'
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  exit 1
fi
while IFS= read -r line; do
  key="${line%%=*}"
  val="${line#*=}"
  val="${val#\"}"
  val="${val%\"}"
  export "$key=$val"
done < <(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' "$ENV_FILE")
export DEMO_JWT=$(cat "/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp/dossie-sign-e2e-loop/jwt.txt")
cd "/c/Users/Heath Shepard/Desktop/MeetDossie/.tmp"
node v3-fha-verify.js
