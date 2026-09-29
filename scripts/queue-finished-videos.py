"""
queue-finished-videos.py — Dossie / Realtor / Rust Finished Video Uploader

Watch-folder scanner for Heath's weekly recording kit (docs/WEEKLY-RECORDING-KIT.md).
Any new .mp4 dropped in one of three folders gets ingested automatically:

  Media/finished-videos/            -> Dossie clips (target_owner='dossie')
  Media/finished-videos/realtor/    -> Heath's realtor-page clips (target_owner='heath-realtor')
  Media/finished-videos/rust/       -> Rust (rustfitness.app) clips (target_owner='rust'), added 2026-09-16
  (the top-level scan does NOT recurse, so realtor/ and rust/ never leak into
  the Dossie pipeline — this is the kit doc's own stated convention)

For each new file:
  1. Classify type/platforms/target_owner from its folder + filename
     (see classify_video()).
  2. Caption: Dossie/realtor come ONLY from docs/WEEKLY-RECORDING-KIT.md's own
     "Post caption:" line for that script (see parse_kit_captions()); Rust
     (no kit-doc entries) comes ONLY from a `{stem}.caption.txt` sidecar
     staged next to the video. NEVER a template string / auto-generated
     caption either way. A file with no matching caption ships with an
     EMPTY caption and a Telegram flag instead of a stale CTA. Rust captions
     are additionally checked for a premature app-store/download CTA
     (memory rust-app-store-submission-state.md) and held, not shipped, if
     found.
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
# Rust (rustfitness.app) clips, added 2026-09-16 (RUST-OWNER-WIRING) --
# same top-level-scan-plus-one-subfolder convention as realtor/, so a Rust
# drop never leaks into the Dossie glob either.
RUST_DIR = FINISHED_DIR / "rust"
KIT_DOC_PATH = Path(os.environ["WEEKLY_KIT_PATH"]).expanduser() if os.environ.get("WEEKLY_KIT_PATH") else (REPO / "docs" / "WEEKLY-RECORDING-KIT.md")

STORAGE_BUCKET = "videos"
STORAGE_PREFIX = "video-library"

# Default platforms per lane. Meet Dossie's FB Page is a real channel, so
# selfie clips go to all three (2026-09-10 fix -- previously defaulted to
# tiktok+instagram only, silently dropping Facebook every week). Heath's
# realtor "Brokerage" Zernio profile only has facebook + instagram connected
# today (see docs/PIPELINE.md) -- no tiktok, so we don't default to a
# platform that will just fail at post time.
#
# 'youtube' added to the Dossie vertical lanes 2026-09-16 (Carter,
# fix(video-pipeline): YouTube attach-path). cron-post-videos.js and
# zernio_accounts/posting_schedule were fixed live the same day (78c1c876)
# so Pipeline B CAN post to youtube, but nothing upstream ever tagged a
# video_library row with 'youtube' -- this file is that upstream. YouTube
# Shorts wants the same 1080x1920 vertical asset tiktok/instagram already
# get from build-shortform-video.py, so it rides the same selfie/skit/mobile
# lanes. Desktop (landscape) screen recordings stay off youtube -- Shorts is
# vertical-only. Not added to REALTOR_SELFIE_PLATFORMS: Heath's realtor
# Zernio profile has a youtube destination wired but explicitly "no content
# plan" (docs/PIPELINE.md) -- don't originate realtor content for it.
DOSSIE_SELFIE_PLATFORMS = ["facebook", "instagram", "tiktok", "youtube"]
REALTOR_SELFIE_PLATFORMS = ["facebook", "instagram"]
# Rust (rustfitness.app), added 2026-09-16 (RUST-OWNER-WIRING). Matches the
# two Zernio accounts actually connected and verified live for the 'rust'
# owner (zernio_accounts, 20260916d_rust_owner_wiring.sql) -- no facebook/
# tiktok/youtube row exists for rust today, so we don't default to a
# platform that will just fail account resolution at post time.
RUST_PLATFORMS = ["instagram", "twitter"]


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


def reads_as_heath_clone_voice(file_path: Path) -> bool:
    """
    AI-disclosure fact for THIS specific video (Quinn QA follow-up,
    2026-09-17, on 20260916d_rust_owner_wiring.sql): does its narration use
    Heath's ElevenLabs voice clone (i41TA0Q36AUrp4axERi3)? That is the only
    voice this pipeline treats as requiring YouTube/TikTok synthetic-media
    disclosure (heath-voice-clone-usage-scope.md; Dossie's Luna and any
    non-clone Rust coach voice never trigger it). This is a fact about the
    content, so it is declared by whoever produced the video -- an optional
    `{stem}.voice.txt` sidecar (same convention as `{stem}.caption.txt`,
    added 2026-09-16) naming the speaker. Case-insensitive; only the literal
    name "heath" resolves true. No sidecar -> False (the file's producer
    didn't declare a clone voice, so none is assumed).
    """
    sidecar = file_path.with_suffix(".voice.txt")
    if not sidecar.exists():
        return False
    return sidecar.read_text(encoding="utf-8").strip().lower() == "heath"


def classify_video(file_path: Path, owner: str) -> dict:
    """
    Detect type, platforms, target_owner, and the AI-disclosure fact
    (uses_cloned_voice) from the file's folder + name. `owner` is 'dossie'
    (top-level FINISHED_DIR), 'heath-realtor' (REALTOR_DIR), or 'rust'
    (RUST_DIR) -- set by the caller from which folder the file was found in
    (see main()).
    Returns {"type": str, "platforms": list[str], "topic": str,
             "target_owner": str, "uses_cloned_voice": bool}
    """
    stem = file_path.stem.lower()
    topic = slugify_stem(stem)

    # ── The generator's own `{stem}.meta.json` wins over any inference ──────
    #
    # Everything below this block guesses from a FILENAME. That is fine for a
    # clip a person dropped in the folder, and wrong for one a generator
    # produced -- the generator knows. Two real defects this closes, both found
    # on the first scheduled D1 render (2026-09-17):
    #
    #   * type: "dossie-d1-cap7-2026-09-17.mp4" matched no naming lane and fell
    #     through to the selfie default, so a screen recording was filed as a
    #     selfie.
    #   * uses_cloned_voice: the Dossie lane hardcoded False on the belief that
    #     "Dossie always speaks as Luna." scripts/_lib/shortform-brands.json is
    #     narrower than that -- Heath's clone may speak AS HEATH in Dossie
    #     instructional content, and D1 is exactly that. False would have sent
    #     a clone-voiced video to YouTube/TikTok with NO AI disclosure
    #     (20260917b_ai_disclosure_content_property.sql). This is a property of
    #     the content, and only the thing that rendered the audio knows it.
    #
    # Each field is validated; a junk value is ignored rather than trusted.
    meta = read_meta_sidecar(file_path)
    overrides = {}
    if isinstance(meta.get("type"), str) and meta["type"].strip():
        overrides["type"] = meta["type"].strip()
    if isinstance(meta.get("platforms"), list) and all(isinstance(p, str) for p in meta["platforms"]) and meta["platforms"]:
        overrides["platforms"] = list(meta["platforms"])
    if isinstance(meta.get("uses_cloned_voice"), bool):
        overrides["uses_cloned_voice"] = meta["uses_cloned_voice"]
    # target_owner is NOT overridable: it is decided by which watch folder the
    # file was found in, and letting a sidecar move a clip between owners would
    # let it reach the wrong Zernio account.

    if owner == "heath-realtor":
        # Every realtor clip today is a selfie script (see kit doc); no
        # Dossie CTA, brokerage name comes from the kit's own caption.
        # uses_cloned_voice=True unconditionally: this lane is Heath's own
        # cloned-voice narration by design (heath-voice-clone-usage-scope.md)
        # -- matches the disclosure this pipeline has always sent for this
        # owner (20260917b_ai_disclosure_content_property.sql backfills the
        # same value for every pre-existing row).
        return {
            "type": "selfie",
            "platforms": list(REALTOR_SELFIE_PLATFORMS),
            "topic": topic,
            "target_owner": "heath-realtor",
            "uses_cloned_voice": True,
            **overrides,
        }

    if owner == "rust":
        # Rust's format library (coach-conversation clips, readiness-check
        # skits, etc.) doesn't map onto Dossie's selfie/skit/mobile/desktop
        # naming convention -- every rust/ drop is one type and platform set
        # until Rust has its own naming lanes. Unlike heath-realtor, Rust
        # coaches speak in a MIX of voices (Heath's clone for some, Marcus's
        # own non-clone voice for others, per scripts/_lib/
        # shortform-brands.json's rust.voices.allowed_speaker_voices) -- so
        # there is no safe owner-level default here. See
        # reads_as_heath_clone_voice() above.
        return {
            "type": "coach_conversation",
            "platforms": list(RUST_PLATFORMS),
            "topic": topic,
            "target_owner": "rust",
            "uses_cloned_voice": reads_as_heath_clone_voice(file_path),
            **overrides,
        }

    if "selfie" in stem:
        vtype, platforms = "selfie", list(DOSSIE_SELFIE_PLATFORMS)
    elif stem.startswith("skit-"):
        vtype, platforms = "skit", ["tiktok", "instagram", "youtube"]
    elif "-mobile-" in stem:
        vtype, platforms = "screen_recording", ["tiktok", "instagram", "youtube"]
    elif "-desktop-" in stem:
        vtype, platforms = "screen_recording", ["facebook", "twitter", "linkedin"]
    else:
        # Default: treat as selfie-style short-form
        vtype, platforms = "selfie", list(DOSSIE_SELFIE_PLATFORMS)

    # Dossie always speaks as Luna, never Heath's clone (forbidden_speaker_
    # voices in shortform-brands.json) as a DEFAULT only -- a generator that
    # narrated in Heath's clone says so in its meta sidecar, and that wins
    # (see the overrides block at the top of this function).
    return {
        "type": vtype,
        "platforms": platforms,
        "topic": topic,
        "target_owner": "dossie",
        "uses_cloned_voice": False,
        **overrides,
    }


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


def read_meta_sidecar(video_path: Path) -> dict:
    """`{stem}.meta.json` — what the generator knows about a render that cannot
    be recovered from the mp4 itself (its CTA URL, its format, its provenance).

    Optional by design: hand-dropped clips and every pre-2026-09-17 render have
    no sidecar and keep working exactly as before. Written by
    scripts/render-ask-dossie-video.js and scripts/listing-reel-trigger.js.
    A malformed sidecar is treated as absent rather than crashing ingestion.
    """
    p = video_path.with_suffix(".meta.json")
    try:
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception as ex:
        print(f"  WARN: unreadable meta sidecar {p.name}: {ex}")
    return {}


def run_quality_gate(video_path: Path, cover_path: Path | None, platforms: list[str] | None = None) -> dict | None:
    """
    Shells out to scripts/check-video-quality-cli.js (same subprocess pattern
    as compress_video()'s ffmpeg call) -- see that file for why this is a
    Node CLI rather than reimplemented in Python: the vision-model check
    reuses api/_lib/verify-video-quality.js's Anthropic call, the same path
    verify-image-match.js already uses.

    platforms (2026-09-17): the row's real platforms array, passed straight
    through to --platforms so the gate grades vertical (tiktok/instagram)
    rows against 9:16/Reels rules and horizontal (facebook/twitter/linkedin/
    youtube) rows against 16:9/feed rules -- see classifyOrientation() in
    verify-video-quality.js. Omitting it defaults to the original vertical-
    only behavior, so always pass info["platforms"] here at the real call
    site.

    Returns the parsed {pass, rules, failedRules, detail} dict, or None if
    the CLI itself couldn't be run at all (missing node, crashed, etc.) --
    callers MUST treat None as a hard failure (fail-closed), never as "skip
    the gate."
    """
    cmd = ["node", str(QUALITY_GATE_CLI), "--video", str(video_path)]
    if cover_path:
        cmd += ["--cover", str(cover_path)]
    # CTA-URL resolve (added 2026-09-17). The gate CLI only runs the
    # `cta_url_resolves` rule when it is TOLD which URL the end card carries --
    # it cannot read a URL out of an mp4. Generators that know their CTA drop a
    # `{stem}.meta.json` sidecar next to the mp4; when one is present the link
    # is checked for real (DNS + HTTP < 400) before the row is ever written.
    # A CTA that is a sentence rather than a link ("Text me for a private
    # showing") is reported as skipped by the rule, not as a pass.
    cta_url = read_meta_sidecar(video_path).get("cta_url")
    if cta_url:
        cmd += ["--cta-url", str(cta_url)]
    if platforms:
        cmd += ["--platforms", ",".join(platforms)]
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

    # Top-level scan only (no recursion) — Media/finished-videos/realtor/ and
    # /rust/ are scanned separately below, by design (kit doc convention:
    # keeps realtor/rust clips from ever entering the Dossie glob).
    dossie_paths = sorted(FINISHED_DIR.glob("*.mp4"))
    realtor_paths = sorted(REALTOR_DIR.glob("*.mp4")) if REALTOR_DIR.exists() else []
    rust_paths = sorted(RUST_DIR.glob("*.mp4")) if RUST_DIR.exists() else []

    print(f"\nFound {len(dossie_paths)} Dossie .mp4 file(s) in {FINISHED_DIR}")
    print(f"Found {len(realtor_paths)} Realtor .mp4 file(s) in {REALTOR_DIR}")
    print(f"Found {len(rust_paths)} Rust .mp4 file(s) in {RUST_DIR}")

    all_paths = (
        [(p, "dossie") for p in dossie_paths]
        + [(p, "heath-realtor") for p in realtor_paths]
        + [(p, "rust") for p in rust_paths]
    )

    new_files = []
    for video_path, owner in all_paths:
        stem = video_path.stem
        if stem in existing_ids:
            print(f"  SKIP (already in DB): {video_path.name}")
        else:
            new_files.append((video_path, owner))

    if not new_files:
        print("\nNo new videos to queue. Nothing to do.")
        return

    print(f"\nParsing captions from {KIT_DOC_PATH}...")
    kit_captions = parse_kit_captions(KIT_DOC_PATH)
    print(f"  {len(kit_captions)} script caption(s) loaded from kit doc")

    print(f"\nQueueing {len(new_files)} new video(s):")

    results = {"queued": [], "failed": [], "flagged_no_caption": [], "quality_held": []}

    for video_path, owner in new_files:
        filename = video_path.name
        stem = video_path.stem
        print(f"\n{'─'*55}")
        print(f"  Processing: {filename} ({owner})")

        # 1. Classify
        info = classify_video(video_path, owner)
        print(f"  Type: {info['type']} | Platforms: {info['platforms']} | Topic: {info['topic']} | Owner: {info['target_owner']} | ClonedVoice: {info['uses_cloned_voice']}")

        # 2. Caption — a human-written kit-doc script, or a sidecar written by
        # the generator that produced the video. Still never a template or an
        # auto-generated filler string.
        #
        # SIDECAR (<stem>.caption.txt, added 2026-09-16): the kit doc is the
        # right source for a video Heath RECORDS from a written script. It is
        # the wrong source for the generated formats in
        # docs/CONTENT-FORMAT-LIBRARY.md, whose copy does not and must not
        # exist before render: R1's listing copy is written from a LIVE MLS
        # read in the same atomic run (a kit-doc caption would be a cached
        # price, which is the exact defect that killed cron-daily-listing-posts
        # on 2026-09-11), and D1's copy is built around a real sourced question.
        # Rust has no kit-doc entries at all, so it always fell through to the
        # sidecar even before generated formats existed. Without this, every
        # generated video queued with an empty caption. The sidecar is
        # authored by the generator that already ran the brand copy gate over
        # that text, so it is not an unchecked string.
        caption = kit_captions.get(info["topic"], "")
        caption_src = "kit doc"
        sidecar = video_path.with_suffix(".caption.txt")
        if not caption and sidecar.exists():
            caption = sidecar.read_text(encoding="utf-8").strip()
            caption_src = f"sidecar {sidecar.name}"

        if caption:
            print(f"  Caption ({len(caption)} chars, from {caption_src}): {caption}")
        else:
            source = "a staged .caption.txt sidecar" if owner == "rust" else "WEEKLY-RECORDING-KIT.md or a staged .caption.txt sidecar"
            warn = (f"Video pipeline: {filename} has no matching caption in "
                     f"{source} (topic slug '{info['topic']}') — "
                     f"queued with an EMPTY caption. Write one before approving.")
            print(f"  WARN: {warn}")
            send_telegram_alert(warn)
            results["flagged_no_caption"].append(stem)

        # 2b. Rust content rule (Heath, 2026-09-16): no store link/"download
        # now" language while iOS/Android aren't both live (memory
        # rust-app-store-submission-state.md). CTA is always the waitlist at
        # rustfitness.app. Same "hold, don't ship" pattern as the empty-
        # caption case above.
        if owner == "rust" and caption:
            lowered = caption.lower()
            if re.search(r"\b(download( it)? now|get it on|app store|google play|available now on)\b", lowered):
                warn = (f"Video pipeline: {filename} (rust) caption references a store/download CTA "
                        f"before iOS/Android are live: \"{caption[:80]}\" — held.")
                print(f"  QUALITY HOLD (content rule): {warn}")
                send_telegram_alert(warn)
                results["failed"].append(stem)
                continue

        # 3. Video quality gate (BLOCKING, brand-agnostic — Heath's standing
        # rule 2026-09-15). Cover frame extracted + gate run against the
        # ORIGINAL file, before any lossy compression. A missing/failed cover
        # or gate CLI failure is fail-closed, never a silent pass.
        cover_local = extract_cover_frame(video_path)
        gate_result = run_quality_gate(video_path, cover_local, platforms=info["platforms"])

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
            "uses_cloned_voice": info["uses_cloned_voice"],
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
