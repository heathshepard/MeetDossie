#!/bin/bash
#
# pre-commit guard: vercel.json can never be committed with more than
# Vercel's 100-cron cap.
#
# WHY THIS EXISTS
#   vercel.json's cron count broke production deploys twice:
#     - 2026-08-23
#     - 2026-08-25, commit afce811f
#   Both times the overage was only caught at push/deploy time. This hook
#   catches it at commit time instead, before it can even land on a branch.
#
# CAP
#   Vercel's own validation error reads:
#     "crons" should NOT have more than 100 items
#   That means 100 is allowed; 101+ is rejected. This hook fails the commit
#   on 101+, matching Vercel's real behavior exactly (not a stricter local
#   guess).
#
# WHAT IT CHECKS
#   Only runs when vercel.json is part of the commit (staged). Reads the
#   STAGED version of the file (git show :vercel.json), not the working-tree
#   copy, so it validates exactly what would be committed.
#
# TO SKIP (should not normally be needed - fix the cron count instead)
#   git commit --no-verify

# Only act if vercel.json is actually part of this commit.
if ! git diff --cached --name-only | grep -qx "vercel.json"; then
  exit 0
fi

staged_content=$(git show :vercel.json 2>/dev/null)
if [ -z "$staged_content" ]; then
  echo "pre-commit: WARNING - could not read staged vercel.json; skipping cron cap check." >&2
  exit 0
fi

result=$(echo "$staged_content" | node -e '
  let input = "";
  process.stdin.on("data", d => input += d);
  process.stdin.on("end", () => {
    let json;
    try {
      json = JSON.parse(input);
    } catch (e) {
      console.log("PARSE_ERROR:" + e.message);
      return;
    }
    const crons = Array.isArray(json.crons) ? json.crons : [];
    console.log("COUNT:" + crons.length);
  });
' 2>/dev/null)

if [[ "$result" == PARSE_ERROR:* ]]; then
  echo "pre-commit: WARNING - staged vercel.json is not valid JSON (${result#PARSE_ERROR:}); skipping cron cap check." >&2
  exit 0
fi

count="${result#COUNT:}"

if [ -z "$count" ]; then
  echo "pre-commit: WARNING - could not determine cron count from staged vercel.json; skipping cron cap check." >&2
  exit 0
fi

CAP=100

if [ "$count" -gt "$CAP" ]; then
  echo "" >&2
  echo "  COMMIT BLOCKED - vercel.json has $count cron entries, cap is $CAP" >&2
  echo "" >&2
  echo "  Vercel rejects deploys past this with:" >&2
  echo "    \"crons\" should NOT have more than 100 items" >&2
  echo "" >&2
  echo "  This has broken production deploys twice (2026-08-23, 2026-08-25)." >&2
  echo "  Consolidate or remove $((count - CAP)) cron entr$([ $((count - CAP)) -eq 1 ] && echo y || echo ies) before committing" >&2
  echo "  (or move the overflow job to cron-job.org, per CLAUDE.md - the" >&2
  echo "  Vercel cron cap has already been hit at 20/20 before)." >&2
  echo "" >&2
  exit 1
fi

exit 0
