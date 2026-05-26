"""
upload-video.py — Upload a finished video to Supabase Storage and update video_library.

Usage:
  python scripts/upload-video.py Media/finished-videos/skit-breakup-2026-05-26.mp4

Steps:
  1. Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local / .env.production.local
  2. Derives the video_library id from the filename stem
  3. Looks up the row in video_library to confirm it exists
  4. Uploads the video file to Supabase Storage bucket 'videos'
  5. Updates video_library.supabase_url with the public URL
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ── Load env files ────────────────────────────────────────────────────────────

def load_env_file(path: Path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)

REPO = Path(__file__).parent.parent
load_env_file(REPO / ".env.production.local")
load_env_file(REPO / ".env.local")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET       = "videos"

# ── Helpers ───────────────────────────────────────────────────────────────────

def sb_request(method: str, path: str, data: bytes = None, extra_headers: dict = None) -> tuple:
    """Make a Supabase REST or Storage API call. Returns (status, body_dict)."""
    url = f"{SUPABASE_URL}{path}"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        body = e.read()
        status = e.code
    try:
        parsed = json.loads(body)
    except Exception:
        parsed = body.decode("utf-8", "replace")
    return status, parsed


def lookup_video_library(video_id: str) -> dict | None:
    status, data = sb_request(
        "GET",
        f"/rest/v1/video_library?id=eq.{video_id}&limit=1",
        extra_headers={"Content-Type": "application/json"},
    )
    if status == 200 and isinstance(data, list) and len(data) > 0:
        return data[0]
    return None


def upload_to_storage(video_path: Path, remote_name: str) -> str:
    """Upload video to Supabase Storage. Returns public URL."""
    data = video_path.read_bytes()
    size_mb = len(data) / 1024 / 1024
    print(f"  Uploading {size_mb:.1f} MB to bucket '{BUCKET}/{remote_name}'...")

    status, body = sb_request(
        "POST",
        f"/storage/v1/object/{BUCKET}/{remote_name}",
        data=data,
        extra_headers={
            "Content-Type": "video/mp4",
            "x-upsert": "true",
        },
    )
    if status not in (200, 201):
        raise RuntimeError(f"Storage upload failed ({status}): {body}")

    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{remote_name}"
    print(f"  OK uploaded. Public URL: {public_url}")
    return public_url


def update_supabase_url(video_id: str, public_url: str):
    payload = json.dumps({"supabase_url": public_url}).encode("utf-8")
    status, body = sb_request(
        "PATCH",
        f"/rest/v1/video_library?id=eq.{video_id}",
        data=payload,
        extra_headers={
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    if status not in (200, 204):
        raise RuntimeError(f"Failed to update video_library.supabase_url ({status}): {body}")
    print(f"  OK video_library.supabase_url updated for id={video_id}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/upload-video.py <path-to-video.mp4>")
        sys.exit(1)

    if not SUPABASE_URL or not SERVICE_KEY:
        print("ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env.local")
        sys.exit(1)

    video_path = Path(sys.argv[1])
    if not video_path.is_absolute():
        video_path = REPO / video_path

    if not video_path.exists():
        print(f"ERROR: File not found: {video_path}")
        sys.exit(1)

    video_id = video_path.stem  # filename without extension
    print(f"Video path:  {video_path}")
    print(f"Video ID:    {video_id}")

    # Look up video_library row
    print(f"\nLooking up video_library row id='{video_id}'...")
    row = lookup_video_library(video_id)
    if not row:
        print(f"WARNING: No video_library row found for id='{video_id}'")
        print("Proceeding with upload anyway — supabase_url will be returned but not saved.")
    else:
        print(f"  Found: status={row.get('status')}, platforms={row.get('platforms')}")

    # Upload to Storage
    remote_name = video_path.name  # keep the original filename in the bucket
    try:
        public_url = upload_to_storage(video_path, remote_name)
    except RuntimeError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    # Update video_library if row exists
    if row:
        try:
            update_supabase_url(video_id, public_url)
        except RuntimeError as e:
            print(f"ERROR updating video_library: {e}")
            sys.exit(1)

    print(f"\nDone. Public URL:\n{public_url}")


if __name__ == "__main__":
    main()
