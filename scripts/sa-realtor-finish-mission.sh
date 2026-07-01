#!/bin/bash
# Run the merge + report scripts after the scrape ends.
# Called manually or by a monitor when the scraper process dies.

set -e
cd "C:/Users/Heath Shepard/Desktop/MeetDossie"

echo "[$(date -u +%FT%TZ)] === MERGE ==="
node scripts/sa-realtor-merge-final.js 2>&1 | tail -30

echo ""
echo "[$(date -u +%FT%TZ)] === REPORT ==="
node scripts/sa-realtor-mission-report.js 2>&1 | tail -80

echo ""
echo "[$(date -u +%FT%TZ)] === DONE ==="
