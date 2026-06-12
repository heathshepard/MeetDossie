#!/usr/bin/env bash
# Sage's overnight bite batch — sequential to avoid Playwright webm race conditions.
# Each bite is recorded, voiceover'd, merged, uploaded, and inserted.

set +e

cd "$(dirname "$0")/.."

LOG="Media/tutorial-videos/sage-overnight-$(date +%Y%m%d-%H%M%S).log"
mkdir -p Media/tutorial-videos

BITES=(
  "switch-between-dossiers"
  "take-the-60-second-tour"
  "use-the-mobile-app"
  "set-notification-preferences"
  "visibility-see-every-deal-at-a-glance"
  "control-never-miss-a-deadline-again"
  "speed-dossie-handles-followups-while-youre-at-a-showing"
  "cost-comparison-400-per-file-vs-29-per-month"
)

echo "[sage-batch] Starting $(date)" | tee -a "$LOG"
echo "[sage-batch] $(( ${#BITES[@]} )) bites in queue" | tee -a "$LOG"

PASS=0
FAIL=0
FAILED_SLUGS=()

for slug in "${BITES[@]}"; do
  echo "" | tee -a "$LOG"
  echo "[sage-batch] ==== START: $slug ($(date +%H:%M:%S)) ====" | tee -a "$LOG"
  node scripts/record-tutorial-bite.js --slug "$slug" 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  if [ "$rc" = "0" ]; then
    PASS=$((PASS+1))
    echo "[sage-batch] ==== PASS: $slug ====" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1))
    FAILED_SLUGS+=("$slug")
    echo "[sage-batch] ==== FAIL ($rc): $slug ====" | tee -a "$LOG"
  fi
done

echo "" | tee -a "$LOG"
echo "[sage-batch] Done $(date)" | tee -a "$LOG"
echo "[sage-batch] PASS=$PASS  FAIL=$FAIL" | tee -a "$LOG"
if [ "$FAIL" -gt 0 ]; then
  echo "[sage-batch] Failed slugs: ${FAILED_SLUGS[*]}" | tee -a "$LOG"
fi
echo "$LOG"
