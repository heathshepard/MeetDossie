#!/usr/bin/env python3
"""
dry-run-video-routing.py — prints, for a set of representative filenames,
EXACTLY where queue-finished-videos.py would route them: which owner(s),
which platform(s), whether a cross-post row gets created, and why.

Read-only, zero network/DB access, zero writes. Imports classify_video()
directly from scripts/queue-finished-videos.py and calls it against fake
Path objects for filenames that were never dropped on disk — nothing here
touches Media/finished-videos/, Supabase, or Zernio.

Run: python3 scripts/dry-run-video-routing.py
"""

from pathlib import Path
import importlib.util

# Module filename has a hyphen (not a valid Python identifier) — load it
# directly from its file path rather than a normal import.
spec = importlib.util.spec_from_file_location("queue_finished_videos", Path(__file__).parent / "queue-finished-videos.py")
qfv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qfv)


CASES = [
    ("Media/finished-videos/dossie-founder-selfie-2026-10-01.mp4", "dossie"),
    ("Media/finished-videos/skit-onboarding-demo-2026-10-01.mp4", "dossie"),
    ("Media/finished-videos/app-walkthrough-mobile-2026-10-01.mp4", "dossie"),
    ("Media/finished-videos/quarterly-recap-desktop-2026-10-01.mp4", "dossie"),
    ("Media/finished-videos/realtor/trec-p8-disclosure-realtor-selfie-2026-10-01.mp4", "heath-realtor"),
    ("Media/finished-videos/rust/readiness-check-2026-10-01.mp4", "rust"),
]

print("=" * 78)
print("  VIDEO ROUTING DRY RUN — config/video-routing.json as loaded right now")
print("=" * 78)
print()
print(f"  Routing config source: config/video-routing.json "
      f"({'LOADED' if (Path(__file__).parent.parent / 'config' / 'video-routing.json').exists() else 'MISSING — using built-in fallback'})")
print()

for rel_path, owner in CASES:
    fake_path = Path(rel_path)
    info = qfv.classify_video(fake_path, owner)
    print(f"  FILE: {rel_path}")
    print(f"    type={info['type']}  target_owner={info['target_owner']}  uses_cloned_voice={info['uses_cloned_voice']}")
    print(f"    PRIMARY ROW  -> owner={info['target_owner']:<14} platforms={info['platforms']}")
    if info.get("cross_post"):
        cp = info["cross_post"]
        print(f"    CROSS-POST   -> owner={cp['owner']:<14} platforms={cp['platforms']}  (same uploaded asset, new video_library row, id suffix '-{cp['owner'].split('-')[0]}')")
    else:
        print(f"    CROSS-POST   -> none")
    print()

print("=" * 78)
print("  Real accountId resolution for each (platform, owner) above is done at")
print("  PUBLISH time by api/cron-post-videos.js's resolveZernioAccountId(),")
print("  reading the live zernio_accounts table — this script only shows the")
print("  INGESTION-TIME routing decision (which owner/platform rows get")
print("  created), not the publish-time account-id lookup.")
print("=" * 78)
