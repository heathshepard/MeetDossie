"""
queue-finished-videos.py — Dossie / Realtor Finished Video Uploader

Watch-folder scanner for Heath's weekly recording kit (docs/WEEKLY-RECORDING-KIT.md).
Any new .mp4 dropped in one of two folders gets ingested automatically:

  Media/finished-videos/            -> Dossie clips (target_owner='dossie')
  Media/finished-videos/realtor/    -> Heath's realtor-page clips (target_owner='heath-realtor')
  (the top-level scan does NOT recurse, so realtor/ never leaks into the
  Dossie pipeline — this is the kit doc's own stated convention)

For each new file:
  1. Classify type/platforms/target_owner from its folder + filename
     (see classify_video()).
  2. Caption comes ONLY from docs/WEEKLY-RECORDING-KIT.md's own
     "Post caption:" line for that script (see parse_kit_captions()) --
     NEVER a template string / auto-generated caption. A file with no
     matching script ships with an EMPTY caption and a Telegram flag
     instead of a stale CTA.
  3. Video quality gate (Heath's standing rule 2026-09-15 --
     feedback_every-video-needs-scroll-stopping-hook.md /
     docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md), BLOCKING and brand-agnostic
     (Dossie, Rust, realtor all go through the same gate): extracts a cover
     frame, runs scripts/check-video-quality-cli.js (real ffprobe/ffmpeg
     measurable checks + vision-model hook/caption checks -- see
     api/_lib/verify-video-quality.js for the rule list). A file that fails
     ships with status='quality_hold' instead of 'approved', the specific
     failed rules recorded on the row, and ONE Telegram alert naming them --
     it is never silently approved and never silently dropped.
  4. Uploads video (and, on a pass, the cover image) to Supabase Storage
     bucket 'videos' at path video-library/{filename}.
  5. Upserts a row into video_library with status='approved' (quality pass)
     or 'quality_hold' (quality fail).

Idempotent: video_library.id = the file's stem (filename w/o extension --
unique per week via its date suffix). A stem already present in
video_library is skipped on every re-run (the filename IS the ledger).

Run: python scripts/queue-finished-videos.py

Test overrides (used by scripts/regression-queue-finished-videos.js, never
set in production):
  QUEUE_VIDEOS_DIR  -- override Media/finished-videos/
  WEEKLY_KIT_PATH   -- override docs/WEEKLY-RECORDING-KIT.md
"""

import json
import os
import re
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

FINISHED_DIR = Path(os.environ["QUEUE_VIDEOS_DIR"]).expanduser() if os.environ.get("QUEUE_VIDEOS_DIR") else (REPO / "Media" / "finished-videos")
REALTOR_DIR = FINISHED_DIR / "realtor"
KIT_DOC_PATH = Path(os.environ["WEEKLY_KIT_PATH"]).expanduser() if os.environ.get("WEEKLY_KIT_PATH") else (REPO / "docs" / "WEEKLY-RECORDING-KIT.md")

STORAGE_BUCKET = "videos"
STORAGE_PREFIX = "video-library"

# Default platforms per lane. Meet Dossie's FB Page is a real channel, so
# selfie clips go to all three (2026-09-10 fix -- previously defaulted to
# tiktok+instagram only, silently dropping Facebook every week). Heath's
# realtor "Brokerage" Zernio profile only has facebook + instagram connected
# today (see docs/PIPELINE.md) -- no tiktok, so we don't default to a
# platform that will just fail at post time.
DOSSIE_SELFIE_PLATFORMS = ["facebook", "instagram", "tiktok"]
REALTOR_SELFIE_PLATFORMS = ["facebook", "instagram"]


# ── Filename / topic-slug helpers ─────────────────────────────────────────────

def slugify_stem(stem: str) -> str:
    """
    Strip date suffix, -vN suffix, and type/owner markers from a filename
    stem to get the topic slug used both for classification and for
    matching against the kit doc's caption list.

    'tc-went-dark-selfie-2026-09-14'               -> 'tc-went-dark'
    'option-period-waive-realtor-selfie-2026-09-14' -> 'option-period-waive'
    """
    topic = stem.lower()
    topic = re.sub(r'-\d{4}-\d{2}-\d{1,2}[a-z]?$', '', topic)
    topic = re.sub(r'-v\d+$', '', topic)
    # Strip the trailing type/owner marker as ONE suffix run, not anywhere
    # in the string — a topic slug can legitimately contain the word
    # "realtor" itself (e.g. 'ask-a-realtor-earnest-money'), so a blind
    # `.replace('-realtor', '')` corrupts it. Only the marker copy right
    # before -selfie/-mobile/-desktop is the naming-convention suffix.
    topic = re.sub(r'(-realtor)?-(selfie|mobile|desktop)$', '', topic)
    topic = topic.strip('-')
    return topic


def classify_video(file_path: Path, is_realtor: bool) -> dict:
    """
    Detect type, platforms, and target_owner from the file's folder + name.
    Returns {"type": str, "platforms": list[str], "topic": str, "target_owner": str}
    """
    stem = file_path.stem.lower()
    topic = slugify_stem(stem)

    if is_realtor:
        # Every realtor clip today is a selfie script (see kit doc); no
        # Dossie CTA, brokerage name comes from the kit's own caption.
        return {
            "type": "selfie",
            "platforms": list(REALTOR_SELFIE_PLATFORMS),
            "topic": topic,
            "target_owner": "heath-realtor",
        }

    if "selfie" in stem:
        vtype, platforms = "selfie", list(DOSSIE_SELFIE_PLATFORMS)
    elif stem.startswith("skit-"):
        vtype, platforms = "skit", ["tiktok", "instagram"]
    elif "-mobile-" in stem:
        vtype, platforms = "screen_recording", ["tiktok", "instagram"]
    elif "-desktop-" in stem:
        vtype, platforms = "screen_recording", ["facebook", "twitter", "linkedin"]
    else:
        # Default: treat as selfie-style short-form
        vtype, platforms = "selfie", list(DOSSIE_SELFIE_PLATFORMS)

    return {"type": vtype, "platforms": platforms, "topic": topic, "target_owner": "dossie"}


# ── Caption sourcing — from the kit doc itself, never a template ─────────────

def parse_kit_captions(kit_path: Path) -> dict:
    """
    Parse docs/WEEKLY-RECORDING-KIT.md for a topic-slug -> caption map.

    Convention (documented in the kit itself): 7 scripts in a fixed order
    (4 Meet Dossie, then 3 Realtor), each with exactly one
    "Post caption: `...`" line, and the "## FILE NAMING" section lists the
    matching filenames in that SAME order (Dossie bullets first, Realtor
    bullets second). Zip position-for-position.

    Returns {} (safe-empty) if the doc doesn't match that shape. Callers
    MUST treat a miss as "flag it, don't ship a stale caption" -- never
    guess at a mapping.
    """
    if not kit_path.exists():
        print(f"  WARN: kit doc not found at {kit_path} -- no captions available")
        return {}

    text = kit_path.read_text(encoding="utf-8")

    # 1. Every "Post caption:" line, in document order.
    captions = re.findall(r'^Post caption:\s*`([^`]*)`', text, flags=re.M)

    # 2. The FILE NAMING section, split into its Dossie list and Realtor list.
    naming_match = re.search(r'^## FILE NAMING(.*?)(?=^## |\Z)', text, flags=re.M | re.S)
    if not naming_match:
        print("  WARN: '## FILE NAMING' section not found in kit doc -- captions will NOT be auto-matched")
        return {}
    naming_block = naming_match.group(1)

    realtor_split = re.search(r'^Realtor clips go in', naming_block, flags=re.M)
    dossie_block = naming_block[:realtor_split.start()] if realtor_split else naming_block
    realtor_block = naming_block[realtor_split.start():] if realtor_split else ""

    dossie_files = re.findall(r'`([\w.-]+\.mp4)`', dossie_block)
    realtor_files = re.findall(r'`([\w.-]+\.mp4)`', realtor_block)

    dossie_slugs = [slugify_stem(Path(f).stem) for f in dossie_files]
    realtor_slugs = [slugify_stem(Path(f).stem) for f in realtor_files]
    slug_order = dossie_slugs + realtor_slugs

    if not slug_order or len(captions) != len(slug_order):
        print(f"  WARN: kit doc shape mismatch -- {len(captions)} 'Post caption:' lines vs "
              f"{len(dossie_slugs)} Dossie + {len(realtor_slugs)} Realtor filenames in FILE NAMING. "
              f"Captions will NOT be auto-matched this run.")
        return {}

    return {slug: caption.strip() for slug, caption in zip(slug_order, captions)}


# ── Telegram flag (unmatched caption) ─────────────────────────────────────────

def send_telegram_alert(text: str):
    token = os.environ.get("TELEGRAM_MARKETING_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "7874782923")
    if not token:
        print(f"  WARN: no TELEGRAM_MARKETING_BOT_TOKEN/TELEGRAM_BOT_TOKEN configured -- cannot send alert: {text}")
        return
    payload = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    except Exception as ex:
        print(f"  WARN: Telegram alert failed: {ex}")


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


# ── Video quality gate (blocking) ─────────────────────────────────────────────
# docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md — every video needs a scroll-stopping
# hook, a cover, and burned captions before it can queue. Brand-agnostic:
# applies identically whether target_owner is 'dossie' or 'heath-realtor'.

COVER_STORAGE_BUCKET = "social-cards"  # already public, image/png+jpeg (docs CLAUDE.md §21)
COVER_STORAGE_PREFIX = "video-covers"
QUALITY_GATE_CLI = REPO / "scripts" / "check-video-quality-cli.js"


def extract_cover_frame(video_path: Path) -> Path | None:
    """
    Extract the frame at t=0 as the video's explicit cover asset via ffmpeg.
    Every video needs one (playbook §3) -- the quality gate fails outright
    without it. Returns a temp PNG path (caller cleans it up), or None if
    ffmpeg can't produce one.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    cmd = ["ffmpeg", "-y", "-ss", "0", "-i", str(video_path), "-frames:v", "1", str(tmp_path)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size == 0:
            print(f"  WARN: cover frame extraction failed: {result.stderr[-300:]}")
            tmp_path.unlink(missing_ok=True)
            return None
        return tmp_path
    except Exception as ex:
        print(f"  WARN: cover frame extraction threw: {ex}")
        tmp_path.unlink(missing_ok=True)
        return None


def upload_cover_to_storage(cover_path: Path, filename_stem: str) -> str | None:
    """Upload the cover PNG to Storage. Returns public URL, or None on failure."""
    storage_path = f"{COVER_STORAGE_PREFIX}/{filename_stem}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/{COVER_STORAGE_BUCKET}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "image/png",
        "x-upsert": "true",
    }
    req = urllib.request.Request(url, data=cover_path.read_bytes(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        return f"{SUPABASE_URL}/storage/v1/object/public/{COVER_STORAGE_BUCKET}/{storage_path}"
    except urllib.error.HTTPError as e:
        print(f"  ERROR cover upload HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
        return None
    except Exception as ex:
        print(f"  ERROR cover upload: {ex}")
        return None


def run_quality_gate(video_path: Path, cover_path: Path | None) -> dict | None:
    """
    Shells out to scripts/check-video-quality-cli.js (same subprocess pattern
    as compress_video()'s ffmpeg call) -- see that file for why this is a
    Node CLI rather than reimplemented in Python: the vision-model check
    reuses api/_lib/verify-video-quality.js's Anthropic call, the same path
    verify-image-match.js already uses.

    Returns the parsed {pass, rules, failedRules, detail} dict, or None if
    the CLI itself couldn't be run at all (missing node, crashed, etc.) --
    callers MUST treat None as a hard failure (fail-closed), never as "skip
    the gate."
    """
    cmd = ["node", str(QUALITY_GATE_CLI), "--video", str(video_path)]
    if cover_path:
        cmd += ["--cover", str(cover_path)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except Exception as ex:
        print(f"  ERROR: quality gate CLI threw: {ex}")
        return None
    try:
        # The CLI prints exactly one JSON line to stdout.
        line = [l for l in result.stdout.strip().splitlines() if l.strip()][-1]
        return json.loads(line)
    except Exception:
        print(f"  ERROR: quality gate CLI produced no parseable JSON.\n"
              f"  stdout: {result.stdout[:400]}\n  stderr: {result.stderr[:400]}")
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
    print("  Dossie / Realtor Finished Video Queue Scanner")
    print("=" * 65)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        sys.exit(1)

    # Get list of videos already in DB — this IS the idempotency ledger:
    # a filename (stem) already present in video_library is never re-queued.
    print("\nFetching existing video_library IDs...")
    existing_ids = get_existing_video_ids()
    print(f"  {len(existing_ids)} videos already in DB")

    if not FINISHED_DIR.exists():
        print(f"ERROR: Directory not found: {FINISHED_DIR}")
        sys.exit(1)

    # Top-level scan only (no recursion) — Media/finished-videos/realtor/ is
    # scanned separately below, by design (kit doc convention: keeps realtor
    # clips from ever entering the Dossie glob).
    dossie_paths = sorted(FINISHED_DIR.glob("*.mp4"))
    realtor_paths = sorted(REALTOR_DIR.glob("*.mp4")) if REALTOR_DIR.exists() else []

    print(f"\nFound {len(dossie_paths)} Dossie .mp4 file(s) in {FINISHED_DIR}")
    print(f"Found {len(realtor_paths)} Realtor .mp4 file(s) in {REALTOR_DIR}")

    all_paths = [(p, False) for p in dossie_paths] + [(p, True) for p in realtor_paths]

    new_files = []
    for video_path, is_realtor in all_paths:
        stem = video_path.stem
        if stem in existing_ids:
            print(f"  SKIP (already in DB): {video_path.name}")
        else:
            new_files.append((video_path, is_realtor))

    if not new_files:
        print("\nNo new videos to queue. Nothing to do.")
        return

    print(f"\nParsing captions from {KIT_DOC_PATH}...")
    kit_captions = parse_kit_captions(KIT_DOC_PATH)
    print(f"  {len(kit_captions)} script caption(s) loaded from kit doc")

    print(f"\nQueueing {len(new_files)} new video(s):")

    results = {"queued": [], "failed": [], "flagged_no_caption": [], "quality_held": []}

    for video_path, is_realtor in new_files:
        filename = video_path.name
        stem = video_path.stem
        print(f"\n{'─'*55}")
        print(f"  Processing: {filename} ({'realtor' if is_realtor else 'dossie'})")

        # 1. Classify
        info = classify_video(video_path, is_realtor)
        print(f"  Type: {info['type']} | Platforms: {info['platforms']} | Topic: {info['topic']} | Owner: {info['target_owner']}")

        # 2. Caption — kit doc only, never a template/auto-generated string.
        caption = kit_captions.get(info["topic"], "")
        if caption:
            print(f"  Caption ({len(caption)} chars, from kit doc): {caption}")
        else:
            warn = (f"Video pipeline: {filename} has no matching script in "
                     f"WEEKLY-RECORDING-KIT.md (topic slug '{info['topic']}') — "
                     f"queued with an EMPTY caption. Write one before approving.")
            print(f"  WARN: {warn}")
            send_telegram_alert(warn)
            results["flagged_no_caption"].append(stem)

        # 3. Video quality gate (BLOCKING, brand-agnostic — Heath's standing
        # rule 2026-09-15). Cover frame extracted + gate run against the
        # ORIGINAL file, before any lossy compression. A missing/failed cover
        # or gate CLI failure is fail-closed, never a silent pass.
        cover_local = extract_cover_frame(video_path)
        gate_result = run_quality_gate(video_path, cover_local)

        if gate_result is None:
            print(f"  ERROR: quality gate could not run for {filename} — failing closed, not approving")
            send_telegram_alert(f"Video pipeline: quality gate CLI failed to run for {filename} — held, needs manual check.")
            if cover_local:
                cover_local.unlink(missing_ok=True)
            results["failed"].append(stem)
            continue

        quality_passed = bool(gate_result.get("pass"))
        failed_rules = gate_result.get("failedRules") or []
        quality_status_value = "passed" if quality_passed else "held"

        if not quality_passed:
            rule_notes = "; ".join(
                f"{r}: {(gate_result.get('rules') or {}).get(r, {}).get('note', '')}" for r in failed_rules
            )
            warn = (f"Video HELD (quality gate): {filename} failed: {', '.join(failed_rules)}\n{rule_notes[:600]}")
            print(f"  QUALITY HOLD: {warn}")
            send_telegram_alert(warn)

        # 4. Upload cover (if we made one) — needed regardless of pass/fail so
        # Heath can actually see a held video's cover/frame in the DB row.
        cover_url = None
        if cover_local:
            cover_url = upload_cover_to_storage(cover_local, stem)
            cover_local.unlink(missing_ok=True)

        # 5. Auto-compress if file is larger than 48 MB
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

        # 6. Upsert into video_library. status is 'approved' ONLY on a
        # quality-gate pass -- a held video ships as 'quality_hold' so
        # cron-post-videos.js's own defense-in-depth gate (which cannot
        # re-run ffmpeg on Vercel, see api/_lib/verify-video-quality.js) has
        # nothing to accidentally queue for review or post.
        row = {
            "id": stem,
            "topic": info["topic"],
            "type": info["type"],
            "status": "approved" if quality_passed else "quality_hold",
            "platforms": info["platforms"],
            "caption": caption,
            "supabase_url": public_url,
            "cover_url": cover_url,
            "quality_status": quality_status_value,
            "quality_failed_rules": failed_rules,
            "quality_detail": gate_result,
            "quality_checked_at": datetime.datetime.utcnow().isoformat() + "Z",
            "target_owner": info["target_owner"],
            "produced_date": datetime.date.today().isoformat(),
            "created_at": datetime.datetime.utcnow().isoformat() + "Z",
        }

        ok = upsert_video_library(row)
        if not ok:
            results["failed"].append(stem)
        elif quality_passed:
            results["queued"].append(stem)
        else:
            results["quality_held"].append(stem)

    # Summary
    print(f"\n{'='*65}")
    print("  SUMMARY")
    print(f"{'='*65}")
    print(f"  Queued ({len(results['queued'])}): {', '.join(results['queued']) or 'none'}")
    print(f"  Quality-held ({len(results['quality_held'])}): {', '.join(results['quality_held']) or 'none'}")
    print(f"  Flagged, no caption match ({len(results['flagged_no_caption'])}): {', '.join(results['flagged_no_caption']) or 'none'}")
    print(f"  Failed ({len(results['failed'])}): {', '.join(results['failed']) or 'none'}")
    if results["failed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
