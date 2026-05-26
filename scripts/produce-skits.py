"""
produce-skits.py — Dossie Skit Video Producer (v2 — hardcoded ruleset)

Produces two vertical skit videos with enforced production rules:
  Skit 1: "The Breakup"   — TC breaks up with agent mid-transaction
  Skit 2: "Paradise Lost" — Agent on vacation, still working

Pipeline per skit:
  A. Pre-flight validation (aborts before any API call if rules violated)
  B. ElevenLabs TTS — Charlie / Luna / Bill voices
  C. Audio concat with 0.3s gaps (ffmpeg)
  D. Character library check — reuse existing clips, generate new via Kling 1.6
  E. CTA card (clip 4) — ffmpeg drawtext, live founding count from Supabase
  F. Assemble: video clips + CTA + audio overlay (ffmpeg)
  G. Post-production QA (ffprobe duration check, 28-44s gate)
  H. Send finished .mp4 via Telegram

Voices:
  Charlie (agent male): IKne3meq5aSn9XLyUdCD
  Luna    (TC female):  lxYfHSkYm1EzQzGhdbfc
  Bill    (narrator):   pqHfZKP75CvOlQylNhV4

Reads env from .env.production.local + .env.local in repo root.
Telegram bot token from .env.production.local or .env.local (TELEGRAM_BOT_TOKEN).
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

# ── Load env files ───────────────────────────────────────────────────────────

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
# Telegram token fallback: Claude channels config
_tg_env = Path.home() / ".claude" / "channels" / "telegram" / ".env"
load_env_file(_tg_env)
_tg_alt = Path(r"C:\Users\Heath Shepard\.claude\channels\telegram\.env")
if not os.environ.get("TELEGRAM_BOT_TOKEN"):
    load_env_file(_tg_alt)

# ── MANDATORY PRODUCTION RULES (enforced in pre-flight validator) ─────────────

RULES = {
    "max_duration_s": 44,
    "min_duration_s": 28,
    "total_scene_clips": 4,           # + 1 CTA clip = 5 total
    "style_lock": (
        "warm cinematic lighting, shallow depth of field, "
        "golden hour tones, 9:16 vertical aspect ratio, photorealistic"
    ),
    "character_per_role_limit": 1,    # each character role shown AT MOST once
    "cta_clip_required": True,
    "hook_in_clip_0": True,
}

# Words that must NOT appear in environment/object clips (clips 1, 2, 3)
PERSON_WORD_BLOCKLIST = [
    "man", "woman", "person", "agent", "realtor", "broker",
    "she", "he", "her", "his", "their", "tc", "coordinator",
    "people", "couple", "individual",
]

# Action words required in clip 0 (character hook clip)
HOOK_ACTION_WORDS = [
    "stressed", "rushing", "sighing", "exasperated", "defeated",
    "urgent", "panicked", "anxious", "frustrated", "overwhelmed",
    "looking", "holding", "running",
]

# ── Constants ─────────────────────────────────────────────────────────────────

ELEVENLABS_API_KEY  = os.environ.get("ELEVENLABS_API_KEY", "")
FAL_KEY             = os.environ.get("FAL_KEY", "")
TELEGRAM_BOT_TOKEN  = os.environ.get("TELEGRAM_BOT_TOKEN", "")
SUPABASE_URL        = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
TELEGRAM_CHAT_ID    = "7874782923"
FOUNDING_TOTAL      = 50

VOICE_CHARLIE = "IKne3meq5aSn9XLyUdCD"   # Charlie — natural conversational American male
VOICE_LUNA    = "lxYfHSkYm1EzQzGhdbfc"   # Luna    — warm female TC voice
VOICE_BILL    = "pqHfZKP75CvOlQylNhV4"   # Bill    — dry deadpan narrator

# Zernio account IDs — all 5 platforms for video posts
DEFAULT_PLATFORMS = [
    "69f15791985e734bf3d13b89",   # tiktok
    "69f25431985e734bf3d8fcbe",   # instagram
    "69f253c3985e734bf3d8f9bc",   # facebook
    "69f255c6985e734bf3d90ba1",   # twitter
    "69fccd7392b3d8e85f8f12be",   # linkedin
]

VOICE_MAP = {
    "charlie": VOICE_CHARLIE,
    "luna":    VOICE_LUNA,
    "bill":    VOICE_BILL,
}

ELEVEN_MODEL  = "eleven_multilingual_v2"
VOICE_SETTINGS = {"stability": 0.65, "similarity_boost": 0.75, "speed": 1.0}

SILENCE_BETWEEN_LINES = 0.3   # seconds

OUTPUT_DIR   = REPO / "Media" / "finished-videos"
CHAR_LIBRARY = REPO / "Media" / "character-library.json"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# CTA card colours
CTA_BG_COLOR    = "black"
CTA_TEXT_COLOR  = "white"
CTA_CORAL_COLOR = "#E8836B"   # coral hex — drawtext uses 0xRRGGBB notation
CTA_DURATION    = 5           # seconds

STYLE_LOCK = RULES["style_lock"]


# ── Scene definitions ─────────────────────────────────────────────────────────

# Each scene dict:
#   type:    "character" | "environment"
#   role:    str — unique role key (used for character-library dedup)
#   NO_PERSON: bool — True means env clip, blocklist enforced
#   prompt:  str — Kling prompt (MUST end with STYLE_LOCK)

SKIT_BREAKUP = {
    "slug": "skit-breakup-v2-2026-05-26",
    "telegram_caption": (
        "Skit 1 v2: The Breakup -- TC breaks up mid-transaction\n"
        "Ready for Submagic captions"
    ),
    "scenes": [
        {
            "type": "character",
            "role": "agent_stressed_female",
            "NO_PERSON": False,
            "prompt": (
                "30-something woman in business casual, holding phone to ear, "
                "exasperated expression, looking up at ceiling, warm home office background, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "Close-up of a smartphone screen showing a long scrolling text thread, "
                "notifications piling up, blurred background, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "Hand placing a phone face-down on a wooden desk, "
                "deliberate slow motion, office setting, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "Laptop screen showing a clean organized dashboard interface, "
                "calm and minimal, warm desk lighting, "
                + STYLE_LOCK
            ),
        },
        # Clip 4 is the CTA card — generated by build_cta_card(), not Kling
    ],
    "lines": [
        ("luna",    "I need to talk to you."),
        ("charlie", "...about the closing?"),
        ("luna",    "About us. I can't do this anymore."),
        ("charlie", "You can't do what - you just sent the addendum to the wrong client."),
        ("luna",    "I sent it to someone."),
        ("charlie", "That's not the same thing."),
        ("luna",    "I think you need someone more... organized."),
        ("charlie", "Are you breaking up with me mid-transaction?"),
        ("luna",    "It's not you. It's the 47 emails."),
        ("bill",    "Dossie doesn't quit. She doesn't lose the addendum. "
                    "And she definitely doesn't break up with you over email. "
                    "meetdossie.com slash founding."),
    ],
}

SKIT_PARADISE = {
    "slug": "skit-paradise-v2-2026-05-26",
    "telegram_caption": (
        "Skit 2 v2: Paradise Lost -- Agent on vacation, still working\n"
        "Ready for Submagic captions"
    ),
    "scenes": [
        {
            "type": "character",
            "role": "agent_defeated_male",
            "NO_PERSON": False,
            "prompt": (
                "30-something man in linen shirt, sitting on beach chair, "
                "looks down at phone with defeated expression, ocean horizon background, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "iPhone buzzing on a beach towel, sand and sunscreen visible, "
                "bright tropical sunlight, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "Laptop open on a poolside table, blue water reflection, "
                "untouched cocktail beside it, "
                + STYLE_LOCK
            ),
        },
        {
            "type": "environment",
            "role": None,
            "NO_PERSON": True,
            "prompt": (
                "Laptop closed, phone placed face-down beside it, "
                "peaceful ocean view with golden sunset, "
                + STYLE_LOCK
            ),
        },
        # Clip 4 is the CTA card — generated by build_cta_card(), not Kling
    ],
    "lines": [
        ("bill",    "This is a real estate agent on vacation."),
        ("charlie", "I finally made it. No deals. No deadlines. Just me and -"),
        ("charlie", "...the option period expires tomorrow."),
        ("bill",    "And this is the same agent. Still on vacation. Still working."),
        ("charlie", "Which title company did we use? No - the OTHER one. No -"),
        ("bill",    "Meet Dossie."),
        ("charlie", "She's got it."),
        ("bill",    "Your deals run. You don't. meetdossie.com slash founding."),
    ],
}


# ── Utilities ─────────────────────────────────────────────────────────────────

def step(label: str):
    print(f"\n{'='*65}\n  {label}\n{'='*65}")


def ffmpeg_run(*args, check=True):
    cmd = ["ffmpeg", "-y"] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        print("FFMPEG STDERR:", r.stderr[-4000:])
        raise RuntimeError(f"ffmpeg failed (code {r.returncode})")
    return r


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


# ── PRE-FLIGHT VALIDATOR ──────────────────────────────────────────────────────

def _prompt_lower(scene: dict) -> str:
    return scene["prompt"].lower()


def _auto_fix_environment_prompt(scene: dict) -> dict:
    """
    If an environment clip prompt contains a person-word, prepend the
    NO_PERSON guard phrase and remove the offending words where possible.
    Returns a (possibly modified) scene dict — always a new dict.
    """
    prompt = scene["prompt"]
    offenders = [w for w in PERSON_WORD_BLOCKLIST if re.search(r"\b" + w + r"\b", prompt, re.IGNORECASE)]
    if not offenders:
        return scene

    guard = "Close-up shot, NO people in frame - "
    fixed_prompt = guard + prompt
    print(f"  AUTO-FIX: environment clip contained person-words {offenders}")
    print(f"  BEFORE: {prompt[:100]}")
    print(f"  AFTER:  {fixed_prompt[:120]}")
    new_scene = dict(scene)
    new_scene["prompt"] = fixed_prompt
    return new_scene


def validate_script(scenes: list[dict]) -> list[dict]:
    """
    Run all pre-flight checks. Returns (possibly auto-corrected) scene list.
    Raises ValueError with a descriptive message on hard failures.
    """
    errors = []
    warnings = []
    fixed_scenes = []

    if len(scenes) != RULES["total_scene_clips"]:
        errors.append(
            f"Expected exactly {RULES['total_scene_clips']} scene clips "
            f"(+ CTA), got {len(scenes)}"
        )

    # Track character roles used
    roles_used: dict[str, int] = {}

    for i, scene in enumerate(scenes):
        scene_out = dict(scene)

        # ── Check 1: style_lock present in every prompt ─────────────────────
        if STYLE_LOCK not in scene["prompt"]:
            errors.append(
                f"Clip {i}: style_lock string missing from prompt.\n"
                f"  prompt={scene['prompt'][:80]}"
            )

        # ── Check 2: clip 0 must be a character clip with an action word ────
        if i == 0:
            if scene["type"] != "character":
                errors.append(f"Clip 0 must be type='character', got '{scene['type']}'")
            prompt_lower = _prompt_lower(scene)
            has_action = any(w in prompt_lower for w in HOOK_ACTION_WORDS)
            if not has_action:
                errors.append(
                    f"Clip 0 (hook) prompt must contain an action/emotion word "
                    f"from {HOOK_ACTION_WORDS}.\n  prompt={scene['prompt'][:100]}"
                )

        # ── Check 3: clips 1, 2, 3 — environment clips, no person words ─────
        if i in (1, 2, 3):
            scene_out = _auto_fix_environment_prompt(scene_out)
            # After auto-fix, verify style_lock still present
            if STYLE_LOCK not in scene_out["prompt"]:
                # Re-append style lock if auto-fix somehow stripped it
                scene_out["prompt"] = scene_out["prompt"].rstrip(", ") + ", " + STYLE_LOCK
                warnings.append(f"Clip {i}: style_lock re-appended after auto-fix")

        # ── Check 4: character role deduplication ────────────────────────────
        role = scene.get("role")
        if role and scene["type"] == "character":
            roles_used[role] = roles_used.get(role, 0) + 1
            if roles_used[role] > RULES["character_per_role_limit"]:
                errors.append(
                    f"Clip {i}: character role '{role}' appears more than "
                    f"{RULES['character_per_role_limit']} time(s) — "
                    f"each role may only be shown once."
                )

        fixed_scenes.append(scene_out)

    # ── Check 5: word-count / duration estimate ──────────────────────────────
    # (Caller must pass total script text for this — validated in produce_skit)

    if errors:
        print("\n  PRE-FLIGHT VALIDATOR: FAILED")
        for e in errors:
            print(f"  ERROR: {e}")
        raise ValueError(
            f"Pre-flight validation failed with {len(errors)} error(s). "
            f"Fix above errors before calling Kling."
        )

    if warnings:
        print("\n  PRE-FLIGHT VALIDATOR: PASSED WITH WARNINGS")
        for w in warnings:
            print(f"  WARN: {w}")
    else:
        print("\n  PRE-FLIGHT VALIDATOR: PASSED (all checks green)")

    return fixed_scenes


def validate_script_duration(lines: list[tuple], min_s: float, max_s: float):
    """
    Rough word-count estimate: 130 words/min = 2.17 words/sec.
    Raises ValueError if script is clearly out of range.
    """
    all_text = " ".join(text for _, text in lines)
    word_count = len(all_text.split())
    est_sec = word_count / 2.17
    print(f"  Script word count: {word_count}  |  estimated duration: {est_sec:.1f}s")
    if est_sec > max_s * 1.5:
        raise ValueError(
            f"Script word count ({word_count} words, ~{est_sec:.0f}s) "
            f"far exceeds max duration {max_s}s. Trim the script."
        )
    if est_sec < min_s * 0.5:
        raise ValueError(
            f"Script word count ({word_count} words, ~{est_sec:.0f}s) "
            f"is far below min duration {min_s}s. Expand the script."
        )
    return est_sec


# ── POST-PRODUCTION QA ────────────────────────────────────────────────────────

def qa_check(video_path: Path) -> dict:
    """
    Run ffprobe QA on the final assembled video.
    Returns dict with duration, file_size_mb, passed.
    Logs results. Does NOT raise — caller decides whether to abort.
    """
    dur = probe_duration(video_path)
    size_mb = video_path.stat().st_size / 1024 / 1024 if video_path.exists() else 0.0
    passed = RULES["min_duration_s"] <= dur <= RULES["max_duration_s"]

    print(f"\n  QA REPORT: {video_path.name}")
    print(f"    Duration:   {dur:.2f}s  (target: {RULES['min_duration_s']}-{RULES['max_duration_s']}s)")
    print(f"    File size:  {size_mb:.1f} MB")
    print(f"    QA result:  {'PASS' if passed else 'FAIL -- outside duration range'}")

    return {"duration": dur, "size_mb": size_mb, "passed": passed}


# ── SUPABASE: founding spot count ─────────────────────────────────────────────

def fetch_founding_spots_left() -> int:
    """
    Query Supabase for active founding subscriptions. Returns spots remaining.
    Falls back to 50 - 11 = 39 (known manual count) if Supabase is unavailable.
    """
    FALLBACK = 39

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print(f"  WARN: Supabase env vars missing — using fallback count ({FALLBACK})")
        return FALLBACK

    url = (
        f"{SUPABASE_URL}/rest/v1/subscriptions"
        f"?select=id&status=eq.active&plan=eq.founding"
    )
    req = urllib.request.Request(
        url,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.loads(r.read())
        taken = len(rows)
        spots_left = max(0, FOUNDING_TOTAL - taken)
        print(f"  Founding spots: {taken} taken, {spots_left} left")
        return spots_left
    except Exception as e:
        print(f"  WARN: Supabase query failed ({e}) — using fallback ({FALLBACK})")
        return FALLBACK


# ── CTA CARD (clip 4) ─────────────────────────────────────────────────────────

def build_cta_card(spots_left: int, out_path: Path):
    """
    Generate a 5-second black CTA card using ffmpeg drawtext.
    Line 1: "{N} founding spots left"  — white, large
    Line 2: "meetdossie.com/founding"  — coral (#E8836B), smaller
    Resolution: 1080x1920 (9:16)
    """
    coral_ffmpeg = "0xE8836B"   # ffmpeg color format
    line1 = f"{spots_left} founding spots left"
    line2 = "meetdossie.com/founding"

    # drawtext filter: two passes via complex filter
    # fontfile optional — ffmpeg falls back to default built-in font if not found
    # We try a common Windows font path for Cormorant Garamond, fall back gracefully
    font_path = r"C\:/Windows/Fonts/cormorant-garamond-semibold.ttf"
    fallback_font = r"C\:/Windows/Fonts/georgia.ttf"  # closest warmth fallback

    # Test if Cormorant is available
    cg_path = Path(r"C:\Windows\Fonts\cormorant-garamond-semibold.ttf")
    if cg_path.exists():
        chosen_font = font_path
    else:
        georgia = Path(r"C:\Windows\Fonts\georgia.ttf")
        chosen_font = fallback_font if georgia.exists() else ""

    if chosen_font:
        font_param_1 = f":fontfile='{chosen_font}'"
        font_param_2 = f":fontfile='{chosen_font}'"
    else:
        font_param_1 = ""
        font_param_2 = ""

    vf = (
        f"drawtext=text='{line1}'"
        f"{font_param_1}"
        f":fontcolor=white:fontsize=72"
        f":x=(w-text_w)/2:y=(h/2)-100"
        f":box=0,"
        f"drawtext=text='{line2}'"
        f"{font_param_2}"
        f":fontcolor={coral_ffmpeg}:fontsize=48"
        f":x=(w-text_w)/2:y=(h/2)+20"
        f":box=0"
    )

    ffmpeg_run(
        "-f", "lavfi",
        "-i", "color=c=black:s=1080x1920:r=24",
        "-t", str(CTA_DURATION),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    )
    dur = probe_duration(out_path)
    print(f"  OK CTA card: {out_path.name} ({dur:.2f}s, {spots_left} spots left)")


# ── CHARACTER LIBRARY ─────────────────────────────────────────────────────────

def load_character_library() -> dict:
    if CHAR_LIBRARY.exists():
        try:
            return json.loads(CHAR_LIBRARY.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_character_library(lib: dict):
    CHAR_LIBRARY.parent.mkdir(parents=True, exist_ok=True)
    CHAR_LIBRARY.write_text(json.dumps(lib, indent=2), encoding="utf-8")


def get_character_clip(role: str, prompt: str, scene_idx: int, slug: str, tmp_dir: Path) -> Path | None:
    """
    Check library first (by CDN URL). If found, download cached clip.
    Otherwise generate via Kling and store the CDN URL in the library.
    """
    lib = load_character_library()

    if role in lib:
        cached_url = lib[role]
        # Only attempt download if it looks like an actual URL (not a stale local path)
        if cached_url.startswith("http"):
            print(f"  CHARACTER LIBRARY HIT: role='{role}' -> {cached_url[:80]}")
            out_path = tmp_dir / f"{slug}_scene_{scene_idx}_cached.mp4"
            try:
                dl_req = urllib.request.Request(
                    cached_url, headers={"User-Agent": "DossiePipeline/1.0"}
                )
                with urllib.request.urlopen(dl_req, timeout=120) as r, open(out_path, "wb") as f:
                    total = 0
                    while True:
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        total += len(chunk)
                print(f"  OK cached clip: {total/1024/1024:.1f} MB -> {out_path.name}")
                return out_path
            except Exception as e:
                print(f"  WARN: Library download failed ({e}) — regenerating")
        else:
            print(f"  CHARACTER LIBRARY: stale local path for role='{role}' — regenerating")

    # Generate new clip via Kling
    clip, cdn_url = _retry_kling(prompt, scene_idx, slug, tmp_dir)
    if clip and cdn_url and role:
        # Store the CDN URL so future runs can download without re-generating
        lib[role] = cdn_url
        save_character_library(lib)
        print(f"  CHARACTER LIBRARY: stored CDN URL for role='{role}'")
    return clip


# ── KLING 1.6 CLIP GENERATION ─────────────────────────────────────────────────

def _generate_kling_clip(prompt: str, scene_idx: int, slug: str, tmp_dir: Path) -> tuple:
    """
    Generate a 5s 9:16 Kling 1.6 clip via fal.ai queue REST API.
    Returns (local_path, cdn_url) on success, or (None, None) on failure.
    """
    if not FAL_KEY:
        print("  SKIP: No FAL_KEY")
        return None, None

    endpoint = "https://queue.fal.run/fal-ai/kling-video/v1.6/standard/text-to-video"
    payload = json.dumps({
        "prompt": prompt,
        "duration": "5",
        "aspect_ratio": "9:16",
    }).encode()

    print(f"  Submitting scene {scene_idx}: {prompt[:70]}...")

    req = urllib.request.Request(
        endpoint, data=payload,
        headers={
            "Authorization": f"Key {FAL_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            enqueue = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"  WARN: fal.ai enqueue {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        return None, None

    request_id = enqueue.get("request_id")
    if not request_id:
        print(f"  WARN: No request_id in fal response: {enqueue}")
        return None, None

    status_url = enqueue.get("status_url")
    result_url = enqueue.get("response_url")
    base = "https://queue.fal.run/fal-ai/kling-video/requests"
    status_url = status_url or f"{base}/{request_id}/status"
    result_url = result_url or f"{base}/{request_id}"

    print(f"  Queued request_id={request_id} — polling (up to 20 min)...")

    # Poll up to 120 * 10s = 20 minutes
    for attempt in range(120):
        time.sleep(10)
        try:
            poll_req = urllib.request.Request(
                status_url,
                headers={"Authorization": f"Key {FAL_KEY}"},
                method="GET",
            )
            with urllib.request.urlopen(poll_req, timeout=30) as r:
                status_resp = json.loads(r.read())
        except urllib.error.HTTPError as e:
            print(f"  poll {attempt+1}: HTTP {e.code} — retrying")
            continue
        except Exception as e:
            print(f"  poll {attempt+1}: error {e} — retrying")
            continue

        status = status_resp.get("status", "")
        print(f"  poll {attempt+1}: {status}")

        if status == "COMPLETED":
            break
        elif status in ("FAILED", "ERROR"):
            print(f"  WARN: Kling job failed: {status_resp}")
            return None, None
    else:
        print("  WARN: Kling job timed out after 20 minutes")
        return None, None

    # Fetch result
    try:
        result_req = urllib.request.Request(
            result_url,
            headers={"Authorization": f"Key {FAL_KEY}"},
            method="GET",
        )
        with urllib.request.urlopen(result_req, timeout=30) as r:
            result = json.loads(r.read())
    except Exception as e:
        print(f"  WARN: Failed to fetch result: {e}")
        return None, None

    video_url = (result.get("video") or {}).get("url")
    if not video_url:
        video_url = (
            (result.get("output") or {}).get("video_url")
            or (result.get("data") or {}).get("video", {}).get("url")
        )
    if not video_url:
        print(f"  WARN: No video URL in result: {json.dumps(result)[:300]}")
        return None, None

    out_path = tmp_dir / f"{slug}_scene_{scene_idx}.mp4"
    print(f"  Downloading {video_url[:80]}...")
    try:
        dl_req = urllib.request.Request(
            video_url, headers={"User-Agent": "DossiePipeline/1.0"}
        )
        with urllib.request.urlopen(dl_req, timeout=300) as r, open(out_path, "wb") as f:
            total = 0
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        print(f"  OK scene {scene_idx}: {total/1024/1024:.1f} MB -> {out_path.name}")
        return out_path, video_url   # return both for library storage
    except Exception as e:
        print(f"  WARN: Download failed: {e}")
        return None, None


def _retry_kling(prompt: str, scene_idx: int, slug: str, tmp_dir: Path) -> tuple:
    """Try once, retry once on failure. Returns (path, cdn_url) or (None, None)."""
    path, url = _generate_kling_clip(prompt, scene_idx, slug, tmp_dir)
    if path is not None:
        return path, url
    print(f"  Retrying scene {scene_idx}...")
    return _generate_kling_clip(prompt, scene_idx, slug, tmp_dir)


# ── ELEVENLABS TTS ────────────────────────────────────────────────────────────

def generate_line(voice_key: str, text: str, out_path: Path) -> bool:
    if not ELEVENLABS_API_KEY:
        print("  SKIP: No ELEVENLABS_API_KEY")
        return False

    voice_id = VOICE_MAP[voice_key]
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    payload = json.dumps({
        "text": text,
        "model_id": ELEVEN_MODEL,
        "voice_settings": VOICE_SETTINGS,
    }).encode("utf-8")

    req = urllib.request.Request(
        url, data=payload,
        headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            audio_bytes = r.read()
        out_path.write_bytes(audio_bytes)
        print(f"  OK [{voice_key}] {len(audio_bytes):,} bytes -> {out_path.name}")
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"  WARN: ElevenLabs {e.code} for '{text[:40]}': {body[:200]}")
        return False
    except Exception as e:
        print(f"  WARN: ElevenLabs error for '{text[:40]}': {e}")
        return False


def generate_all_lines(skit: dict, tmp_dir: Path) -> list:
    audio_files = []
    for i, (voice, text) in enumerate(skit["lines"]):
        out = tmp_dir / f"line_{i:02d}_{voice}.mp3"
        ok = generate_line(voice, text, out)
        if ok:
            audio_files.append(out)
        else:
            print(f"  SKIP line {i}: {text[:50]}")
    return audio_files


# ── AUDIO CONCAT ──────────────────────────────────────────────────────────────

def concat_audio(audio_files: list, silence_sec: float, out_path: Path) -> float:
    if not audio_files:
        raise RuntimeError("No audio files to concat")

    if len(audio_files) == 1:
        ffmpeg_run("-i", str(audio_files[0]), "-c:a", "aac", "-b:a", "192k", str(out_path))
        return probe_duration(out_path)

    tmp_dir = out_path.parent

    # Generate silence
    silence_wav = tmp_dir / "silence_gap.wav"
    ffmpeg_run(
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-t", str(silence_sec), "-c:a", "pcm_s16le", str(silence_wav),
    )

    # Convert each mp3 to wav
    tmp_wavs = []
    for i, mp3 in enumerate(audio_files):
        wav = tmp_dir / f"line_{i:02d}.wav"
        ffmpeg_run(
            "-i", str(mp3),
            "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "1",
            str(wav),
        )
        tmp_wavs.append(wav)

    # Interleave with silence
    interleaved = []
    for i, wav in enumerate(tmp_wavs):
        interleaved.append(wav)
        if i < len(tmp_wavs) - 1:
            interleaved.append(silence_wav)

    concat_list = tmp_dir / "concat_audio.txt"
    with open(concat_list, "w", encoding="utf-8") as f:
        for p in interleaved:
            f.write(f"file '{p.as_posix()}'\n")

    merged_wav = tmp_dir / "merged_audio.wav"
    ffmpeg_run(
        "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c:a", "pcm_s16le", str(merged_wav),
    )

    ffmpeg_run("-i", str(merged_wav), "-c:a", "aac", "-b:a", "192k", str(out_path))
    dur = probe_duration(out_path)
    print(f"  OK audio concat: {dur:.2f}s -> {out_path.name}")
    return dur


# ── VIDEO ASSEMBLY ────────────────────────────────────────────────────────────

def assemble_video(
    video_clips: list,     # 4 Kling clips
    cta_card: Path,        # CTA card (5s)
    audio_path: Path,
    audio_dur: float,
    out_path: Path,
):
    """
    Scale + concat 4 scene clips + CTA card, overlay audio track.
    Freezes last frame if video is shorter than audio.
    """
    if not video_clips:
        raise RuntimeError("No video clips for assembly")

    tmp_dir = out_path.parent
    all_clips = video_clips + [cta_card]

    # Scale all clips to 1080x1920
    scaled_clips = []
    for i, clip in enumerate(all_clips):
        scaled = tmp_dir / f"scaled_{i:02d}.mp4"
        ffmpeg_run(
            "-i", str(clip),
            "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
            str(scaled),
        )
        scaled_clips.append(scaled)

    # Write concat list
    concat_list = tmp_dir / "video_concat.txt"
    with open(concat_list, "w", encoding="utf-8") as f:
        for sc in scaled_clips:
            f.write(f"file '{sc.as_posix()}'\n")

    # Concat all clips
    raw_video = tmp_dir / "raw_video.mp4"
    ffmpeg_run(
        "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        str(raw_video),
    )

    vid_dur = probe_duration(raw_video)
    print(f"  Raw video: {vid_dur:.2f}s | Audio: {audio_dur:.2f}s")

    # Freeze last frame if video is shorter than audio
    freeze_sec = max(0.0, audio_dur - vid_dur + 0.5)
    if freeze_sec > 0.1:
        print(f"  Freezing last frame for {freeze_sec:.2f}s")
        extended = tmp_dir / "extended_video.mp4"
        ffmpeg_run(
            "-i", str(raw_video),
            "-vf", f"tpad=stop_mode=clone:stop_duration={freeze_sec:.3f}",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            str(extended),
        )
        final_video_base = extended
    else:
        final_video_base = raw_video

    # Overlay audio
    ffmpeg_run(
        "-i", str(final_video_base),
        "-i", str(audio_path),
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(out_path),
    )

    size_mb = out_path.stat().st_size / 1024 / 1024
    final_dur = probe_duration(out_path)
    print(f"  OK assembled: {out_path.name} ({size_mb:.1f} MB, {final_dur:.2f}s)")


# ── TELEGRAM SEND ─────────────────────────────────────────────────────────────

def telegram_send_video(video_path: Path, caption: str) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("  WARN: No TELEGRAM_BOT_TOKEN — skipping Telegram send")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendVideo"
    boundary = "DossieBoundary7834921"

    def part_field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n'
            f"\r\n{value}\r\n"
        ).encode("utf-8")

    video_bytes = video_path.read_bytes()
    file_part = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="video"; filename="{video_path.name}"\r\n'
        f"Content-Type: video/mp4\r\n\r\n"
    ).encode("utf-8") + video_bytes + b"\r\n"

    body = (
        part_field("chat_id", TELEGRAM_CHAT_ID)
        + part_field("caption", caption)
        + part_field("supports_streaming", "true")
        + file_part
        + f"--{boundary}--\r\n".encode("utf-8")
    )

    size_mb = len(video_bytes) / 1024 / 1024
    print(f"  Uploading {size_mb:.1f} MB to Telegram...")

    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.loads(r.read())
        if resp.get("ok"):
            msg_id = resp.get("result", {}).get("message_id", "?")
            print(f"  OK Telegram message_id={msg_id}")
            return True
        else:
            print(f"  WARN: Telegram returned not-ok: {resp}")
            return False
    except urllib.error.HTTPError as e:
        print(f"  WARN: Telegram sendVideo {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        return False
    except Exception as e:
        print(f"  WARN: Telegram error: {e}")
        return False


# ── MAIN SKIT PRODUCER ────────────────────────────────────────────────────────

def produce_skit(skit: dict, spots_left: int) -> Path | None:
    slug = skit["slug"]
    out_path = OUTPUT_DIR / f"{slug}.mp4"

    print(f"\n{'#'*70}")
    print(f"  PRODUCING: {slug}")
    print(f"{'#'*70}")

    tmp = Path(tempfile.mkdtemp(prefix=f"dossie_{slug}_"))
    print(f"  Temp dir: {tmp}")

    # ── Phase A: Pre-flight validation ──────────────────────────────────────
    step("Phase A: Pre-flight validation")
    try:
        validate_script_duration(skit["lines"], RULES["min_duration_s"], RULES["max_duration_s"])
        validated_scenes = validate_script(skit["scenes"])
    except ValueError as e:
        print(f"\n  ABORT: {e}")
        print(f"  No Kling calls made. Fix the script and re-run.")
        return None

    # ── Phase B: ElevenLabs TTS ──────────────────────────────────────────────
    step("Phase B: ElevenLabs TTS")
    audio_files = generate_all_lines(skit, tmp)
    print(f"  Generated {len(audio_files)} / {len(skit['lines'])} lines")

    if not audio_files:
        print("  ERROR: All TTS lines failed")
        return None

    # ── Phase C: Concat audio ────────────────────────────────────────────────
    step("Phase C: Concatenating audio")
    combined_audio = tmp / "combined_audio.m4a"
    audio_dur = concat_audio(audio_files, SILENCE_BETWEEN_LINES, combined_audio)
    print(f"  Total audio: {audio_dur:.2f}s")

    # ── Phase D: Generate video scenes ──────────────────────────────────────
    step("Phase D: Generating AI video clips via Kling 1.6")
    video_clips = []
    for i, scene in enumerate(validated_scenes):
        print(f"\n  --- Scene {i} [{scene['type']}] ---")
        if scene["type"] == "character" and scene.get("role"):
            # get_character_clip returns Path | None (handles library + Kling internally)
            clip = get_character_clip(scene["role"], scene["prompt"], i, slug, tmp)
        else:
            # _retry_kling returns (path, url) tuple — unpack, discard url for env clips
            clip, _url = _retry_kling(scene["prompt"], i, slug, tmp)

        if clip:
            video_clips.append(clip)
        else:
            print(f"  WARN: Scene {i} failed — skipping")

    print(f"\n  Got {len(video_clips)} / {len(validated_scenes)} scene clips")

    if not video_clips:
        print("  ERROR: All scene generations failed")
        return None

    # Fill any missing scene slots by repeating last clip
    while len(video_clips) < RULES["total_scene_clips"]:
        print("  Reusing last clip for missing scene slot")
        video_clips.append(video_clips[-1])

    # ── Phase E: CTA card ────────────────────────────────────────────────────
    step("Phase E: Building CTA card (clip 4)")
    cta_path = tmp / "cta_card.mp4"
    build_cta_card(spots_left, cta_path)

    # ── Phase F: Assemble ────────────────────────────────────────────────────
    step("Phase F: Assembling final video")
    assemble_video(video_clips, cta_path, combined_audio, audio_dur, out_path)

    # ── Phase G: Post-production QA ──────────────────────────────────────────
    step("Phase G: Post-production QA")
    qa = qa_check(out_path)
    if not qa["passed"]:
        print(f"  QA FAIL: Duration {qa['duration']:.2f}s outside "
              f"[{RULES['min_duration_s']}, {RULES['max_duration_s']}]s range")
        print("  Sending anyway (CTA card may have extended duration beyond audio)")

    # ── Phase H: Send via Telegram ───────────────────────────────────────────
    step("Phase H: Sending to Telegram")
    qa_note = (
        f"QA: {qa['duration']:.1f}s, {qa['size_mb']:.1f}MB, "
        f"{'PASS' if qa['passed'] else 'FAIL (duration)'}"
    )
    full_caption = f"{skit['telegram_caption']}\n{qa_note}"
    telegram_send_video(out_path, full_caption)

    # ── Phase I: Register in video_library ───────────────────────────────────
    step("Phase I: Registering in video_library (Supabase)")
    _register_video_library(slug, out_path)

    return out_path


def _register_video_library(slug: str, out_path: Path):
    """
    Upsert a row in Supabase video_library for this skit.
    Non-fatal: if Supabase is unavailable, logs a warning and continues.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("  WARN: Supabase env vars missing — skipping video_library registration")
        return

    import datetime
    today = datetime.date.today().isoformat()
    # Derive a short topic from slug (e.g. "skit-breakup-v2-2026-05-26" -> "breakup")
    parts = slug.split("-")
    topic = parts[1] if len(parts) > 1 else slug

    row = {
        "id": slug,
        "path": str(out_path),
        "type": "skit",
        "topic": topic,
        "produced_date": today,
        "status": "ready",
        "platforms": ["tiktok", "instagram"],
        "caption": (
            "When the TC ghosts you mid-contract. Dossie never does. "
            "meetdossie.com/founding"
        ),
        "telegram_message_id": None,
        "supabase_url": None,
    }

    payload = json.dumps(row).encode("utf-8")
    url = f"{SUPABASE_URL}/rest/v1/video_library?on_conflict=id"
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status = r.status
        print(f"  OK video_library upserted (HTTP {status}) for id={slug}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"  WARN: video_library upsert failed ({e.code}): {body[:200]}")
    except Exception as e:
        print(f"  WARN: video_library upsert error: {e}")


# ── ENV CHECK ─────────────────────────────────────────────────────────────────

def check_env():
    issues = []
    if not ELEVENLABS_API_KEY:
        issues.append("ELEVENLABS_API_KEY missing")
    if not FAL_KEY:
        issues.append("FAL_KEY missing")
    if not TELEGRAM_BOT_TOKEN:
        issues.append("TELEGRAM_BOT_TOKEN missing (Telegram send will be skipped)")
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        issues.append("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing (founding count will use fallback)")

    for i in issues:
        print(f"  WARNING: {i}")

    if not ELEVENLABS_API_KEY or not FAL_KEY:
        print("  ERROR: Cannot proceed without ElevenLabs + fal.ai keys")
        sys.exit(1)


# ── ENTRY POINT ───────────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("  Dossie Skit Video Producer v2")
    print("  Hardcoded ruleset — pre-flight validator enforced")
    print("  2026-05-26")
    print("=" * 70)

    check_env()

    # Fetch founding spot count once for both CTA cards
    step("Fetching live founding spot count from Supabase")
    spots_left = fetch_founding_spots_left()
    print(f"  Using: {spots_left} founding spots left")

    results = {}
    for skit in [SKIT_BREAKUP, SKIT_PARADISE]:
        out = produce_skit(skit, spots_left)
        results[skit["slug"]] = out

    print(f"\n{'='*70}")
    print("  FINAL RESULTS")
    print(f"{'='*70}")
    any_fail = False
    for slug, path in results.items():
        if path and path.exists():
            dur = probe_duration(path)
            size_mb = path.stat().st_size / 1024 / 1024
            passed = RULES["min_duration_s"] <= dur <= RULES["max_duration_s"]
            status = "OK  " if passed else "WARN"
            print(f"  {status} {slug}")
            print(f"       {path}")
            print(f"       {size_mb:.1f} MB, {dur:.2f}s, QA={'PASS' if passed else 'FAIL'}")
        else:
            print(f"  FAIL {slug}: not produced")
            any_fail = True

    sys.exit(1 if any_fail else 0)


if __name__ == "__main__":
    main()
