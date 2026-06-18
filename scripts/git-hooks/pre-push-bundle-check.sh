#!/bin/bash
# Pre-push hook: verify that all workspace-*.js bundles referenced in HTML are tracked in git
# Prevents blank-screen 404s from untracked bundle files

# Extract all workspace-*.js filenames from app.html and workspace.html
REFS=$(grep -oh 'workspace-[A-Za-z0-9_-]*\.js' app.html workspace.html 2>/dev/null | sort -u)

if [ -z "$REFS" ]; then
  # No bundles referenced yet
  exit 0
fi

FAILED=0
for ref in $REFS; do
  if ! git ls-files "assets/$ref" | grep -q "$ref"; then
    echo "ERROR: $ref referenced in HTML but not tracked in git"
    echo "Run: git add assets/$ref"
    FAILED=1
  fi
done

if [ $FAILED -eq 1 ]; then
  echo ""
  echo "PUSH REJECTED: All workspace-*.js bundles must be tracked before push."
  exit 1
fi

exit 0
