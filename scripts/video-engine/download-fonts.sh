#!/usr/bin/env bash
# download-fonts.sh — installs the two brand fonts the video engine burns
# into captions/end-cards (Plus Jakarta Sans, Cormorant Garamond) into the
# user's local fontconfig dir. Neither ships with this machine by default
# (confirmed via `fc-list` 2026-09-21) — without this, libass silently
# falls back to a generic font and captions no longer match Heath's
# approved trial_02 look. Not committed (font files, not source); run once
# per machine, same pattern as download-models.sh.
set -euo pipefail
FONTDIR="$HOME/.local/share/fonts"
mkdir -p "$FONTDIR"
CSS=$(curl -sL -A "Mozilla/5.0" "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700;800&family=Cormorant+Garamond:wght@400;600;700&display=swap")
echo "$CSS" | grep -oE "https://fonts.gstatic.com/[^)]+\.ttf" | sort -u | while read -r url; do
  name=$(echo "$url" | md5sum | cut -c1-8)
  curl -sL --max-time 20 -o "$FONTDIR/dossie-video-$name.ttf" "$url"
done
fc-cache -f "$FONTDIR"
echo "Installed:"
fc-list | grep -iE "jakarta|garamond" || echo "WARNING: fonts did not register — check fc-cache output above."
