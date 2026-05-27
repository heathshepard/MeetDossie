"""
queue-finished-videos.py — Dossie Finished Video Uploader

Scans Media/finished-videos/ for .mp4 files not yet in video_library.
For each new file:
  1. Detects type + platforms from filename
  2. Generates a caption via Claude Haiku
  3. Uploads to Supabase Storage bucket 'videos' at path video-library/{filename}
  4. Gets the public URL
  5. Upserts a row into video_library with status='approved'

Run: python scripts/queue-finished-videos.py
"""

import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import urllib.parse
import datetime
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

# SUPABASE_URL is intentionally empty in .env.local (Vercel-managed).
# Fall back to NEXT_PUBLIC_SUPABASE_URL which has the real value locally.
_sb_url = os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'")
if not _sb_url:
    _sb_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").strip().strip('"').strip("'")
SUPABASE_URL         = _sb_url
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip().strip('"').strip("'")
ANTHROPIC_API_KEY    = os.environ.get("ANTHROPIC_API_KEY", "").strip().strip('"').strip("'")

FINISHED_DIR = REPO / "Media" / "finished-videos"
STORAGE_BUCKET = "videos"
STORAGE_PREFIX = "video-library"

# ── Filename classification ───────────────────────────────────────────────────

def classify_video(filename: str) -> dict:
    """
    Detect type and platforms from filename.
    Returns {"type": str, "platforms": list[str], "topic": str}
    """
    stem = Path(filename).stem.lower()

    if "selfie" in stem:
        vtype = "selfie"
        platforms = ["tiktok", "instagram"]
    elif stem.startswith("skit-"):
        vtype = "skit"
        platforms = ["tiktok", "instagram"]
    elif "-mobile-" in stem:
        vtype = "screen_recording"
        platforms = ["tiktok", "instagram"]
    elif "-desktop-" in stem:
        vtype = "screen_recording"
        platforms = ["facebook", "twitter", "linkedin"]
    else:
        # Default: treat as selfie-style short-form
        vtype = "selfie"
        platforms = ["tiktok", "instagram"]

    # Derive topic from stem: strip dates and type markers
    topic = stem
    # Remove common date patterns like -2026-05-25 or -2026-05-2
    import re
    topic = re.sub(r'-\d{4}-\d{2}-\d{1,2}[a-z]?$', '', topic)
    topic = re.sub(r'-v\d+$', '', topic)
    topic = topic.replace('-selfie', '').replace('-mobile', '').replace('-desktop', '')
    topic = topic.strip('-')

    return {"type": vtype, "platforms": platforms, "topic": topic}


# ── Claude Haiku caption generator ───────────────────────────────────────────

def generate_caption(filename: str, vtype: str, topic: str) -> str:
    """
    Generate a warm Dossie-brand caption via Claude Haiku.
    Falls back to a generic caption if API unavailable.
    """
    if not ANTHROPIC_API_KEY:
        print("  WARN: No ANTHROPIC_API_KEY — using fallback caption")
        return f"Dossie handles your transactions so you can focus on what matters. meetdossie.com/founding"

    prompt = f"""Generate a social media caption for a Dossie video.

Video filename: {filename}
Video type: {vtype}
Topic slug: {topic}

Dossie is an AI transaction coordinator for Texas real estate agents. Brand voice: warm, capable, never corporate. She handles deadlines, documents, and follow-ups.

Requirements:
- 1-2 sentences maximum
- Warm, direct tone (not hype)
- Reference the specific topic if identifiable from the filename
- End with: meetdossie.com/founding
- Max 150 characters total (including URL)
- No em-dashes, no curly quotes, plain ASCII only
- Do not start with "I"

Return ONLY the caption text. No quotes, no commentary."""

    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        caption = resp["content"][0]["text"].strip()
        # Enforce 150 char limit
        if len(caption) > 150:
            # Truncate but keep the URL
            url = "meetdossie.com/founding"
            if url not in caption:
                caption = caption[:120] + "... " + url
            else:
                caption = caption[:150]
        print(f"  Caption ({len(caption)} chars): {caption}")
        return caption
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"  WARN: Anthropic {e.code}: {body[:200]} — using fallback caption")
    except Exception as e:
        print(f"  WARN: Caption generation failed ({e}) — using fallback caption")

    return f"Your transactions, handled. meetdossie.com/founding"


# ── Supabase helpers ──────────────────────────────────────────────────────────

def supabase_request(method: str, path: str, body=None, extra_headers=None) -> dict:
    url = f"{SUPABASE_URL}{path}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp_text = r.read().decode("utf-8")
            return {"ok": True, "status": r.status, "data": json.loads(resp_text) if resp_text else None}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", "replace")
        return {"ok": False, "status": e.code, "error": body_text}
    except Exception as ex:
        return {"ok": False, "status": 0, "error": str(ex)}


def get_existing_video_ids() -> set:
    """Fetch all ids currently in video_library."""
    result = supabase_request("GET", "/rest/v1/video_library?select=id")
    if not result["ok"]:
        print(f"  WARN: Failed to fetch video_library ids: {result.get('error', '')[:200]}")
        return set()
    rows = result.get("data") or []
    return {r["id"] for r in rows if "id" in r}


def upload_to_storage(file_path: Path, filename: str) -> str | None:
    """
    Upload mp4 to Supabase Storage at video-library/{filename}.
    Returns public URL on success, None on failure.
    """
    storage_path = f"{STORAGE_PREFIX}/{filename}"
    url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{storage_path}"

    file_bytes = file_path.read_bytes()
    size_mb = len(file_bytes) / 1024 / 1024
    print(f"  Uploading {size_mb:.1f} MB to storage: {storage_path}")

    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "video/mp4",
        "x-upsert": "true",
    }
    req = urllib.request.Request(url, data=file_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.loads(r.read().decode("utf-8"))
        print(f"  OK upload: {resp}")
        public_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{storage_path}"
        return public_url
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"  ERROR upload HTTP {e.code}: {body[:300]}")
        return None
    except Exception as ex:
        print(f"  ERROR upload: {ex}")
        return None


def compress_video(file_path: Path) -> Path | None:
    """
    Compress a video file with ffmpeg to reduce size for upload.
    Returns path to the compressed temp file, or None if ffmpeg fails.
    The caller is responsible for cleaning up the temp file.
    """
    size_before_mb = file_path.stat().st_size / 1024 / 1024
    print(f"  File is {size_before_mb:.1f} MB — compressing with ffmpeg...")

    # NamedTemporaryFile with delete=False so we control cleanup
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    cmd = [
        "ffmpeg", "-y",
        "-i", str(file_path),
        "-c:v", "libx264",
        "-crf", "28",
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "128k",
        str(tmp_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f"  ERROR: ffmpeg failed (exit {result.returncode}):")
            print(result.stderr[-500:])
            tmp_path.unlink(missing_ok=True)
            return None
        size_after_mb = tmp_path.stat().st_size / 1024 / 1024
        print(f"  Compressed: {size_before_mb:.1f} MB -> {size_after_mb:.1f} MB")
        return tmp_path
    except subprocess.TimeoutExpired:
        print("  ERROR: ffmpeg timed out after 5 minutes")
        tmp_path.unlink(missing_ok=True)
        return None
    except FileNotFoundError:
        print("  ERROR: ffmpeg not found — install ffmpeg and add it to PATH")
        tmp_path.unlink(missing_ok=True)
        return None
    except Exception as ex:
        print(f"  ERROR: ffmpeg threw: {ex}")
        tmp_path.unlink(missing_ok=True)
        return None


def upsert_video_library(row: dict) -> bool:
    """Upsert a row into video_library. Returns True on success."""
    result = supabase_request(
        "POST",
        "/rest/v1/video_library?on_conflict=id",
        body=row,
        extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    if result["ok"]:
        print(f"  OK upserted video_library: id={row['id']}")
        return True
    else:
        print(f"  ERROR upsert failed ({result['status']}): {result.get('error', '')[:200]}")
        return False


# ── Main scanner ──────────────────────────────────────────────────────────────

def main():
    print("=" * 65)
    print("  Dossie Finished Video Queue Scanner")
    print("=" * 65)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        sys.exit(1)

    # Get list of videos already in DB
    print("\nFetching existing video_library IDs...")
    existing_ids = get_existing_video_ids()
    print(f"  {len(existing_ids)} videos already in DB")

    # Scan finished-videos directory
    if not FINISHED_DIR.exists():
        print(f"ERROR: Directory not found: {FINISHED_DIR}")
        sys.exit(1)

    mp4_files = sorted(FINISHED_DIR.glob("*.mp4"))
    print(f"\nFound {len(mp4_files)} .mp4 files in {FINISHED_DIR.name}/")

    # Filter to only the 5 target videos
    TARGET_STEMS = {
        "still-an-agent-selfie-2026-05-25",
        "youre-the-tc-selfie-2026-05-25",
        "where-are-we-selfie-2026-05-2",
        "skit-breakup-v2-2026-05-26",
        "skit-paradise-v2-2026-05-26",
    }

    new_files = []
    for f in mp4_files:
        stem = f.stem
        if stem in TARGET_STEMS and stem not in existing_ids:
            new_files.append(f)
        elif stem in TARGET_STEMS and stem in existing_ids:
            print(f"  SKIP (already in DB): {f.name}")

    if not new_files:
        print("\nAll target videos already in video_library. Nothing to do.")
        return

    print(f"\nQueueing {len(new_files)} new video(s):")

    results = {"queued": [], "failed": []}

    for video_path in new_files:
        filename = video_path.name
        stem = video_path.stem
        print(f"\n{'─'*55}")
        print(f"  Processing: {filename}")

        # 1. Classify
        info = classify_video(filename)
        print(f"  Type: {info['type']} | Platforms: {info['platforms']} | Topic: {info['topic']}")

        # 2. Generate caption
        caption = generate_caption(filename, info["type"], info["topic"])

        # 3. Auto-compress if file is larger than 48 MB
        COMPRESS_THRESHOLD = 48 * 1024 * 1024  # 48 MB
        upload_path = video_path
        tmp_compressed: Path | None = None

        if video_path.stat().st_size > COMPRESS_THRESHOLD:
            tmp_compressed = compress_video(video_path)
            if tmp_compressed is None:
                print(f"  ERROR: Compression failed for {filename} — skipping")
                results["failed"].append(stem)
                continue
            upload_path = tmp_compressed

        # Upload to Supabase Storage
        public_url = upload_to_storage(upload_path, filename)

        # Clean up temp file if we compressed
        if tmp_compressed is not None:
            tmp_compressed.unlink(missing_ok=True)

        if not public_url:
            print(f"  ERROR: Upload failed for {filename} — skipping")
            results["failed"].append(stem)
            continue

        # 4. Upsert into video_library
        row = {
            "id": stem,
            "topic": info["topic"],
            "type": info["type"],
            "status": "approved",
            "platforms": info["platforms"],
            "caption": caption,
            "supabase_url": public_url,
            "produced_date": datetime.date.today().isoformat(),
            "created_at": datetime.datetime.utcnow().isoformat() + "Z",
        }

        ok = upsert_video_library(row)
        if ok:
            results["queued"].append(stem)
        else:
            results["failed"].append(stem)

    # Summary
    print(f"\n{'='*65}")
    print("  SUMMARY")
    print(f"{'='*65}")
    print(f"  Queued ({len(results['queued'])}): {', '.join(results['queued']) or 'none'}")
    print(f"  Failed ({len(results['failed'])}): {', '.join(results['failed']) or 'none'}")
    if results["failed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
