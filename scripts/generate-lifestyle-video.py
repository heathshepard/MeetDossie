"""Lifestyle marketing video pipeline for Dossie.

Composes a 30-45s marketing video out of:
  0:00-0:03  Hook text overlay on black
  0:03-0:18  Pexels b-roll lifestyle footage with Bill voiceover
  0:18-0:32  Screen-recording insert (the MP4 Heath dropped in screen-recordings/)
  0:32-0:38  Final CTA text "meetdossie.com/founding"
  0:38-end   Fade to black

Outputs both 1080x1920 vertical (Reels/TikTok) and 1080x1080 square (FB) under
MeetDossie/Media/finished-videos/.

Designed to be invoked by Claude Code from the DONE-reply handler. Claude Code
orchestrates the data fetching (today's content_calendar row) and passes the
relevant fields as CLI args, so this script doesn't need Supabase access.

Usage:
  python generate-lifestyle-video.py \
    --topic morning_brief \
    --hook "Your TC calls you at 8AM. Dossie texts you at 6." \
    --voiceover-script "This is your morning brief. Every deal..." \
    --screen-recording C:/.../monday-morning-brief-2026-05-04.mp4 \
    --output-prefix monday-morning-brief-2026-05-04 \
    --platform "TikTok + Instagram Reels"

  # Just probe Pexels and dump the response (run this first to verify the API
  # response shape before running a full render):
  python generate-lifestyle-video.py --topic morning_brief --probe

Env requirements:
  PEXELS_API_KEY     - https://www.pexels.com/api/
  ELEVENLABS_API_KEY - already set
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

# --------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------

ROOT = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
MEDIA = ROOT / "Media"
BROLL_DIR = MEDIA / "b-roll"
VOICEOVERS_DIR = MEDIA / "voiceovers"
FINISHED_DIR = MEDIA / "finished-videos"
SCREEN_RECORDINGS_DIR = MEDIA / "screen-recordings"
FONTS_DIR = MEDIA / "_fonts"
LOGO_PATH = MEDIA / "dossie-logo-d.png"
BG_MUSIC = MEDIA / "Music" / "joyinsound-corporate-motivational-background-music-403417.mp3"

# Brand
NAVY = (26, 26, 46)
CORAL = (232, 131, 107)
GOLD = (201, 169, 110)
BLUSH_LIGHT = (245, 230, 224)

# Timing (seconds). Total length is derived at runtime from the voiceover
# duration: total = voice_duration + TAIL_PAD. The hook card is fixed (3s);
# the remaining time is split 40/45/15 across b-roll / screen recording /
# CTA outro, with the outro never going below MIN_OUTRO seconds so the CTA
# stays readable. Earlier the script hardcoded 38s — that capped voiceover
# scripts to ~140 chars and they sounded clipped on a 38s canvas.
T_TITLE = 3.0           # fixed hook-card length
TAIL_PAD = 2.0          # fade headroom after voiceover ends
MIN_OUTRO = 4.0         # CTA card must be at least this long
T_FADE_OUT = 1.0        # final fade to black at the end of outro
SEGMENT_SHARES = {
    "broll": 0.40,
    "screen": 0.45,
    "outro": 0.15,
}

def derive_segment_durations(voice_duration: float) -> dict:
    """Compute per-segment durations from the voiceover length. Always returns
    a dict with t_title, t_broll, t_screen, t_outro, total. The voiceover
    starts at t_title (T_TITLE) and is allowed to run through into the
    screen-recording segment if it's longer than the b-roll segment alone."""
    total = voice_duration + TAIL_PAD
    remaining = max(0.0, total - T_TITLE)
    t_outro = max(MIN_OUTRO, remaining * SEGMENT_SHARES["outro"])
    # If outro hit the floor, claw back proportionally from broll/screen.
    leftover = max(0.0, remaining - t_outro)
    t_broll = leftover * (SEGMENT_SHARES["broll"] / (SEGMENT_SHARES["broll"] + SEGMENT_SHARES["screen"]))
    t_screen = leftover - t_broll
    # Recompute total from the sum to absorb any rounding drift.
    final_total = T_TITLE + t_broll + t_screen + t_outro
    return {
        "t_title": T_TITLE,
        "t_broll": t_broll,
        "t_screen": t_screen,
        "t_outro": t_outro,
        "total": final_total,
    }

# Audio mix
BG_VOLUME = 0.08
VOICE_VOLUME = 1.0
BG_FADE_IN = 1.0
BG_FADE_OUT = 2.0

# Pexels search keywords by topic. Be specific — generic "morning" or "coffee"
# pulls stock-feeling clips. Each topic gets 4-5 queries; we pull 8-10 candidate
# videos total per topic, save them with metadata, then pick the best 4 by
# duration (sweet spot ~6-9s).
TOPIC_KEYWORDS = {
    "morning_brief": [
        "businesswoman laptop morning",
        "professional woman morning routine",
        "businesswoman coffee laptop",
        "woman realtor working laptop",
        "female real estate agent office",
        "woman reviewing documents desk",
    ],
    "trec_deadlines": [
        "signing contract table",
        "real estate paperwork closeup",
        "agent reviewing documents desk",
        "signing legal documents",
        "contract signing pen",
    ],
    "draft_emails": [
        "woman typing laptop professional",
        "real estate agent phone",
        "businesswoman email laptop",
        "professional texting phone",
    ],
    "talk_to_dossie": [
        "woman driving car professional",
        "real estate agent car",
        "businesswoman phone call driving",
        "agent between appointments",
    ],
    "pipeline_view": [
        "real estate team meeting",
        "agent laptop dashboard",
        "professional reviewing screen",
        "businesswoman working desk",
    ],
}

# Pexels quality filters — picks portrait/square HD clips in the 5-12s range so
# they fit cleanly into the 15s b-roll segment without obvious looping or low-res
# artifacts.
BROLL_MIN_DURATION = 5
BROLL_MAX_DURATION = 12
BROLL_MIN_WIDTH = 1080
BROLL_CANDIDATES_PER_TOPIC = 10
BROLL_PICK_COUNT = 4
BROLL_IDEAL_DURATION = 7.5  # used to score candidates

# Topics that should skew toward clips with female subjects, matching the
# Dossie brand voice ("Your deals. Her job."). Scoring uses Pexels' page URL
# slug (e.g. "a-woman-using-her-laptop") as a heuristic — not a perfect signal
# but consistent enough to push male-coded clips below female ones.
FEMALE_SKEW_TOPICS = {"morning_brief", "draft_emails", "talk_to_dossie"}
FEMALE_TOKENS = {"woman", "women", "female", "businesswoman", "her", "she", "girl", "ladies"}
MALE_TOKENS = {"man", "men", "male", "businessman", "his", "he", "guy", "gentleman", "boys"}

# Persona → demo-account mapping. Gender-matched so the screen recording
# inserted into the lifestyle video shows a same-gender agent profile as the
# persona attributed to that day's row. Brenda + Patricia (female personas)
# share Sarah Whitley's demo. Victor (male persona) uses John Smith. The
# generate-lifestyle-video script doesn't sign in itself — it just surfaces
# this in the [content] log so Heath knows which account he should have been
# screen-recording when he picked up the brief.
PERSONA_DEMO_ACCOUNT = {
    "brenda":   {"name": "Sarah Whitley", "email": "demo@meetdossie.com"},
    "patricia": {"name": "Sarah Whitley", "email": "demo@meetdossie.com"},
    "victor":   {"name": "John Smith",    "email": "demo2@meetdossie.com"},
}

# Topic key (CLI arg) → content_calendar.feature column value. Single source
# of truth for the hook + voiceover_script; no hardcoded fallback. If a topic
# isn't in this map (or the DB row is missing) the render aborts with a clear
# error rather than synthesizing stale text.
TOPIC_TO_FEATURE = {
    "morning_brief": "Morning Brief live audio",
    "trec_deadlines": "New dossier TREC deadlines",
    "draft_emails": "Draft queue emails",
    "talk_to_dossie": "Talk to Dossie",
    "pipeline_view": "Full pipeline view",
}

# Public Supabase URL + anon key (same values shipped in founding.html — RLS
# is disabled on content_calendar so anon has SELECT). Not secrets.
SUPABASE_URL = "https://pgwoitbdiyubjugwufhk.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBn"
    "d29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4"
    "cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE"
)

# ElevenLabs Bill voice — same v4 settings as beta-recruit
ELEVENLABS_BILL = "pqHfZKP75CvOlQylNhV4"
ELEVENLABS_MODEL = "eleven_turbo_v2"
BILL_VOICE_SETTINGS = {
    "stability": 0.75,
    "similarity_boost": 0.75,
    "style": 0.2,
    "use_speaker_boost": True,
    "speed": 0.95,
}

# Tools
FFMPEG = shutil.which("ffmpeg") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"
FFPROBE = shutil.which("ffprobe") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffprobe.exe"


# --------------------------------------------------------------------------------------
# Pexels
# --------------------------------------------------------------------------------------

def pexels_search(api_key: str, query: str, *, orientation: str, per_page: int = 5,
                  min_duration: int = BROLL_MIN_DURATION,
                  max_duration: int = BROLL_MAX_DURATION) -> dict:
    """Call Pexels videos/search and return the parsed JSON. The spec asks us
    to print the actual response so we don't guess at the schema — callers can
    inspect what comes back."""
    params = urllib.parse.urlencode({
        "query": query,
        "per_page": per_page,
        "orientation": orientation,
        "min_duration": min_duration,
        "max_duration": max_duration,
    })
    url = f"https://api.pexels.com/videos/search?{params}"
    req = urllib.request.Request(url, headers={
        "Authorization": api_key,
        # Pexels' Cloudflare layer 403s requests with default urllib UA. Send a real
        # browser-shaped UA + standard Accept so the request gets through.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"Pexels HTTP {e.code}: {body}") from e


# --------------------------------------------------------------------------------------
# content_calendar lookup
# --------------------------------------------------------------------------------------

def fetch_content_calendar_row(topic: str, week: int, day: int) -> Optional[dict]:
    """Pull the row matching this topic/week/day from public.content_calendar.
    The voiceover_script + hook are *the* source of truth — the script must
    never substitute a hardcoded fallback (Heath's rule: 'Never use a
    hardcoded or cached script from a previous render.').

    Returns the row dict on hit, None on miss. Raises on transport error so
    the caller can surface a clear failure message."""
    feature = TOPIC_TO_FEATURE.get(topic)
    if not feature:
        raise RuntimeError(
            f"Unknown topic '{topic}'. Add it to TOPIC_TO_FEATURE so it maps "
            f"to a content_calendar.feature value."
        )
    params = urllib.parse.urlencode({
        "feature": f"eq.{feature}",
        "week_number": f"eq.{week}",
        "day_of_week": f"eq.{day}",
        "is_active": "eq.true",
        "select": "week_number,day_of_week,feature,hook,voiceover_script,recording_instructions,persona",
        "limit": "1",
    })
    url = f"{SUPABASE_URL}/rest/v1/content_calendar?{params}"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"content_calendar lookup HTTP {e.code}: {body}") from e
    if not data:
        return None
    return data[0]


def pick_video_file(video: dict, target_w: int, target_h: int) -> Optional[dict]:
    """Choose the best video_files entry for the target resolution. Filters
    out anything below BROLL_MIN_WIDTH; among the remaining, prefer the
    smallest file that still meets target on both dimensions, falling back to
    the largest HD-or-better file."""
    files = video.get("video_files") or []
    if not files:
        return None
    # Filter to HD-or-better
    hd_files = [f for f in files if (f.get("width") or 0) >= BROLL_MIN_WIDTH]
    if not hd_files:
        return None
    # Prefer files that meet/exceed target dimensions
    candidates = [f for f in hd_files if (f.get("width") or 0) >= target_w and (f.get("height") or 0) >= target_h]
    if candidates:
        candidates.sort(key=lambda f: (f.get("width") or 0) * (f.get("height") or 0))
        return candidates[0]
    # Fallback: largest HD file
    hd_files = sorted(hd_files, key=lambda f: (f.get("width") or 0) * (f.get("height") or 0), reverse=True)
    return hd_files[0]


def gather_broll_candidates(api_key: str, topic: str, *, target_w: int, target_h: int,
                            limit: int = BROLL_CANDIDATES_PER_TOPIC) -> list[dict]:
    """Run all of the topic's queries and assemble a deduped candidate list with
    metadata only (no downloads yet). Each candidate dict contains:
      { id, query, duration, width, height, preview_url, video_url, file_quality, is_portrait }
    Sorted by orientation match (portrait first) then closeness to BROLL_IDEAL_DURATION
    so the best clips bubble up. orientation=portrait is passed to every Pexels
    query, but we still post-filter on width<=height because Pexels' orientation
    flag is best-effort and occasionally returns the odd landscape result."""
    queries = TOPIC_KEYWORDS.get(topic, [topic.replace("_", " ")])
    want_portrait = target_h > target_w
    want_square = target_h == target_w
    orientation = "portrait" if want_portrait else ("square" if want_square else "landscape")
    seen: set = set()
    candidates: list[dict] = []
    landscape_fallback: list[dict] = []
    for q in queries:
        try:
            resp = pexels_search(api_key, q, orientation=orientation, per_page=8)
        except RuntimeError as e:
            print(f"[pexels] search '{q}' failed: {e}", file=sys.stderr)
            continue
        for v in resp.get("videos") or []:
            vid = v.get("id")
            if not vid or vid in seen:
                continue
            dur = v.get("duration") or 0
            if dur < BROLL_MIN_DURATION or dur > BROLL_MAX_DURATION:
                continue
            file_info = pick_video_file(v, target_w, target_h)
            if not file_info or not file_info.get("link"):
                continue
            file_w = file_info.get("width") or 0
            file_h = file_info.get("height") or 0
            is_portrait = file_h >= file_w
            cand = {
                "id": vid,
                "query": q,
                "duration": dur,
                "width": file_w,
                "height": file_h,
                "file_quality": file_info.get("quality"),
                "preview_url": v.get("url"),
                "image_thumb": v.get("image"),
                "video_url": file_info.get("link"),
                "is_portrait": is_portrait,
            }
            seen.add(vid)
            # When we asked for portrait/square, ditch landscape clips into a
            # fallback bucket. The render still uses top-anchor crop so they'd
            # be safe to use, but we only fall back if portrait runs out.
            if (want_portrait or want_square) and not is_portrait:
                landscape_fallback.append(cand)
            else:
                candidates.append(cand)
    # Annotate gender-skew score per candidate (lower = better, i.e. matches
    # the topic's preferred gender). Heuristic uses the Pexels slug/URL.
    skew_female = topic in FEMALE_SKEW_TOPICS
    for cand in candidates:
        cand["gender_score"] = score_gender_skew(cand, skew_female=skew_female)
    # Sort by gender skew first, then duration closeness — keeps the female-coded
    # clips up top while still preferring 7.5s-ish durations within each bucket.
    candidates.sort(key=lambda c: (c.get("gender_score", 0),
                                   abs((c["duration"] or 0) - BROLL_IDEAL_DURATION)))
    if len(candidates) < BROLL_PICK_COUNT and landscape_fallback:
        for cand in landscape_fallback:
            cand["gender_score"] = score_gender_skew(cand, skew_female=skew_female)
        landscape_fallback.sort(key=lambda c: (c.get("gender_score", 0),
                                               abs((c["duration"] or 0) - BROLL_IDEAL_DURATION)))
        need = BROLL_PICK_COUNT - len(candidates)
        print(f"[pexels] only {len(candidates)} portrait candidates passed filters — "
              f"falling back to {min(need, len(landscape_fallback))} landscape clip(s) "
              f"with top-anchor crop", file=sys.stderr)
        candidates.extend(landscape_fallback[:need])
    return candidates[:limit]


def score_gender_skew(cand: dict, *, skew_female: bool) -> int:
    """Return a small integer where lower = better fit. The Pexels slug carries
    the human-written caption ('a-woman-using-her-laptop'), which is good
    enough for a directional bias even if some clips slip through."""
    slug = (cand.get("preview_url") or "").lower() + " " + (cand.get("query") or "").lower()
    tokens = set(re.findall(r"[a-z]+", slug))
    has_f = bool(tokens & FEMALE_TOKENS)
    has_m = bool(tokens & MALE_TOKENS)
    if skew_female:
        # 0 = female only, 1 = neutral, 2 = mixed, 3 = male only
        if has_f and not has_m: return 0
        if not has_f and not has_m: return 1
        if has_f and has_m: return 2
        return 3
    # No skew set — neutral
    return 0


def save_candidates_json(topic: str, candidates: list[dict], picks: list[dict]) -> Path:
    """Persist the candidate list + which 4 we picked so Heath can review."""
    out_dir = BROLL_DIR / topic
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "candidates.json"
    payload = {
        "topic": topic,
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "ideal_duration_s": BROLL_IDEAL_DURATION,
        "min_width": BROLL_MIN_WIDTH,
        "min_duration_s": BROLL_MIN_DURATION,
        "max_duration_s": BROLL_MAX_DURATION,
        "picked_ids": [p["id"] for p in picks],
        "candidates": candidates,
    }
    out_path.write_text(json.dumps(payload, indent=2))
    return out_path


def download_pexels_clip(candidate: dict, out_dir: Path) -> Optional[Path]:
    """Download one candidate clip into the topic's b-roll cache."""
    out_dir.mkdir(parents=True, exist_ok=True)
    local = out_dir / f"pexels-{candidate['id']}-{candidate.get('file_quality','x')}.mp4"
    if local.exists() and local.stat().st_size > 0:
        return local
    try:
        dl_req = urllib.request.Request(candidate["video_url"], headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "video/mp4,*/*;q=0.5",
        })
        with urllib.request.urlopen(dl_req, timeout=60) as r, open(local, "wb") as out:
            shutil.copyfileobj(r, out)
        return local
    except Exception as e:
        print(f"[pexels] download {candidate['id']} failed: {e}", file=sys.stderr)
        if local.exists():
            local.unlink()
        return None


def fetch_broll(api_key: str, topic: str, *, target_w: int, target_h: int,
                count: int = BROLL_PICK_COUNT, out_dir: Path = None) -> list[Path]:
    """End-to-end: gather candidates, save manifest, download the top N picks."""
    out_dir = out_dir or (BROLL_DIR / topic)
    candidates = gather_broll_candidates(api_key, topic, target_w=target_w, target_h=target_h)
    if not candidates:
        print(f"[pexels] WARN: no candidates passed quality filters for topic={topic}", file=sys.stderr)
        return []
    picks = candidates[:count]
    save_candidates_json(topic, candidates, picks)
    downloaded: list[Path] = []
    for c in picks:
        local = download_pexels_clip(c, out_dir)
        if local:
            downloaded.append(local)
    return downloaded


# --------------------------------------------------------------------------------------
# ElevenLabs voiceover
# --------------------------------------------------------------------------------------

def synth_voiceover(api_key: str, script_text: str, out_path: Path) -> Path:
    """Generate Bill voiceover. Add SSML <break time="0.4s"/> between sentences
    so the voice has natural pacing. eleven_turbo_v2 honors break tags inline.

    Hard-fails on any error: an empty MP3, a 4xx/5xx, or a network timeout.
    A silent video is worse than no video — better to abort the render."""
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY missing — refuse to render a silent video.")
    sentences = re.split(r'(?<=[.!?])\s+', script_text.strip())
    augmented = ' <break time="0.4s"/> '.join(s for s in sentences if s)
    body = {
        "text": augmented,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": BILL_VOICE_SETTINGS,
    }
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_BILL}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            audio_bytes = r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {body}") from e
    except Exception as e:
        raise RuntimeError(f"ElevenLabs request failed: {e}") from e
    if not audio_bytes or len(audio_bytes) < 1024:
        raise RuntimeError(f"ElevenLabs returned empty/tiny payload ({len(audio_bytes)} bytes)")
    out_path.write_bytes(audio_bytes)
    return out_path


# --------------------------------------------------------------------------------------
# Text-overlay frames
# --------------------------------------------------------------------------------------

def render_text_card(text: str, *, width: int, height: int, out_png: Path,
                     bg_color=(0, 0, 0), text_color=(255, 255, 255), max_font_size: int = 72) -> Path:
    """Render a single text card as a PNG using PIL with Cormorant Garamond
    SemiBold. Wraps long text. Used for the 0-3s hook card and the 32-38s CTA."""
    from PIL import Image, ImageDraw, ImageFont  # lazy import — Pillow already a dep
    img = Image.new("RGB", (width, height), bg_color)
    font_path = FONTS_DIR / "CormorantGaramond-SemiBold.ttf"
    if not font_path.exists():
        # Fallback to Times if our font isn't cached yet
        font_path = Path(r"C:\Windows\Fonts\timesbd.ttf")
    # Auto-size: shrink font until text fits in 80% of the canvas
    avail_w = int(width * 0.85)
    avail_h = int(height * 0.7)
    font_size = max_font_size
    draw = ImageDraw.Draw(img)
    while font_size > 18:
        font = ImageFont.truetype(str(font_path), font_size)
        wrapped = wrap_text(draw, text, font, avail_w)
        bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=10, align="center")
        if (bbox[2] - bbox[0]) <= avail_w and (bbox[3] - bbox[1]) <= avail_h:
            break
        font_size -= 4
    bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=10, align="center")
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (width - tw) // 2 - bbox[0]
    y = (height - th) // 2 - bbox[1]
    draw.multiline_text((x, y), wrapped, font=font, fill=text_color, spacing=10, align="center")
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png, "PNG")
    return out_png


def wrap_text(draw, text: str, font, max_width: int) -> str:
    words = text.split()
    lines = []
    cur = []
    for w in words:
        candidate = (" ".join(cur + [w])).strip()
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if (bbox[2] - bbox[0]) <= max_width or not cur:
            cur.append(w)
        else:
            lines.append(" ".join(cur))
            cur = [w]
    if cur:
        lines.append(" ".join(cur))
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# Zernio media upload
# --------------------------------------------------------------------------------------

ZERNIO_BASE = "https://zernio.com/api/v1"

def zernio_upload_local_file(api_key: str, local_path: Path,
                             content_type: str = "video/mp4") -> dict:
    """Upload a local file to Zernio in two steps:
      1) POST /api/v1/media/presign with {fileName, fileType} → uploadUrl + publicUrl
      2) PUT the bytes to uploadUrl with the matching Content-Type
    Returns {ok, publicUrl, uploadUrl, expires, status, error}.

    Per docs.zernio.com/guides/media-uploads: uploadUrl is a presigned GCS
    URL (no auth on the PUT); publicUrl is what you reference in
    /api/v1/posts as mediaItems: [{url, type}]."""
    if not api_key:
        return {"ok": False, "error": "ZERNIO_API_KEY missing — cannot upload locally"}
    if not local_path.exists():
        return {"ok": False, "error": f"file not found: {local_path}"}

    # Step 1: presign
    presign_body = json.dumps({
        "fileName": local_path.name,
        "fileType": content_type,
    }).encode("utf-8")
    presign_req = urllib.request.Request(
        f"{ZERNIO_BASE}/media/presign",
        data=presign_body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(presign_req, timeout=60) as r:
            presign_resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return {"ok": False, "step": "presign", "status": e.code, "error": body}
    except Exception as e:
        return {"ok": False, "step": "presign", "error": str(e)}

    upload_url = presign_resp.get("uploadUrl")
    public_url = presign_resp.get("publicUrl")
    if not upload_url or not public_url:
        return {"ok": False, "step": "presign", "error": "no uploadUrl/publicUrl in response",
                "raw": presign_resp}

    # Step 2: PUT the file bytes
    file_bytes = local_path.read_bytes()
    put_req = urllib.request.Request(
        upload_url,
        data=file_bytes,
        headers={"Content-Type": content_type},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(put_req, timeout=300) as r:
            put_status = r.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return {"ok": False, "step": "put", "status": e.code, "error": body,
                "publicUrl": public_url, "uploadUrl": upload_url}
    except Exception as e:
        return {"ok": False, "step": "put", "error": str(e),
                "publicUrl": public_url, "uploadUrl": upload_url}

    return {
        "ok": True,
        "publicUrl": public_url,
        "uploadUrl": upload_url,
        "expires": presign_resp.get("expires"),
        "put_status": put_status,
        "size_bytes": len(file_bytes),
    }


def zernio_create_post(api_key: str, account_id: str, content: str,
                       media_items: list[dict], schedule_iso: Optional[str] = None) -> dict:
    """Create a Zernio post with attached media. media_items elements are
    {url, type} where url is a publicUrl from zernio_upload_local_file()."""
    payload = {
        "content": content,
        "platforms": [{"accountId": account_id}],
        "mediaItems": media_items,
    }
    if schedule_iso:
        payload["scheduledFor"] = schedule_iso
    else:
        payload["publishNow"] = False  # default to draft, never auto-publish from a script
    req = urllib.request.Request(
        f"{ZERNIO_BASE}/posts",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return {"ok": True, "status": r.status, "body": json.loads(r.read().decode("utf-8"))}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return {"ok": False, "status": e.code, "error": body}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# --------------------------------------------------------------------------------------
# Video composition
# --------------------------------------------------------------------------------------

def duration(path: Path) -> float:
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def render_card_segment(png: Path, seconds: float, w: int, h: int, out_mp4: Path) -> Path:
    """Render a static PNG card as an N-second silent MP4."""
    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-i", str(png),
        "-t", f"{seconds}",
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,fade=t=in:st=0:d=0.4,fade=t=out:st={max(0, seconds - 0.4):.2f}:d=0.4",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-an",
        str(out_mp4),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out_mp4


def render_broll_segment(clips: list[Path], target_seconds: float, w: int, h: int,
                         logo: Optional[Path], out_mp4: Path) -> Path:
    """Concat clips, scale-and-crop each to fill (w, h), trim to target_seconds.
    Adds a small Dossie logo watermark in the bottom-right corner."""
    n = max(1, len(clips))
    per_clip = target_seconds / n

    inputs = []
    for c in clips:
        inputs += ["-i", str(c)]
    if logo and logo.exists():
        inputs += ["-i", str(logo)]
    parts = []
    labels = []
    # Top-anchor crop: y=0 keeps the top of the frame so subjects' heads are
    # never cut off when reframing landscape (or oversize portrait) into our
    # target aspect. Horizontal centering via x=(in_w-w)/2 since most subjects
    # are centered laterally.
    for i, _ in enumerate(clips):
        label_v = f"v{i}"
        parts.append(
            f"[{i}:v]trim=duration={per_clip:.3f},setpts=PTS-STARTPTS,"
            f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}:(in_w-{w})/2:0,"
            f"setsar=1,fps=30,format=yuv420p[{label_v}]"
        )
        labels.append(f"[{label_v}]")
    if labels:
        parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[concat]")
    else:
        # No clips — render a black background as fallback
        parts.append(
            f"color=c=black:size={w}x{h}:duration={target_seconds}:rate=30[concat]"
        )
    if logo and logo.exists():
        # Logo at 12% of width, bottom-right with margin
        logo_w = int(w * 0.12)
        margin = int(w * 0.04)
        parts.append(f"[{len(clips)}:v]scale={logo_w}:-1[logo]")
        parts.append(f"[concat][logo]overlay=W-w-{margin}:H-h-{margin}:format=auto,format=yuv420p[outv]")
    else:
        parts.append("[concat]copy[outv]")
    fc = ";".join(parts)
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", fc, "-map", "[outv]",
           "-t", f"{target_seconds}", "-c:v", "libx264", "-preset", "medium",
           "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-an", str(out_mp4)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out_mp4


def render_screen_segment(screen_rec: Path, target_seconds: float, w: int, h: int,
                          out_mp4: Path) -> Path:
    """Scale the screen recording to fit ~80% of the canvas, center, with a
    subtle drop shadow underneath."""
    inner_w = int(w * 0.86)
    inner_h = int(h * 0.5) if w == h else int(h * 0.5)  # leave headroom in vertical too
    # Filter chain: black bg -> recording scaled+padded -> over a darker shadow
    fc = (
        f"color=c=black:size={w}x{h}:duration={target_seconds}:rate=30[bg];"
        f"[0:v]trim=duration={target_seconds},setpts=PTS-STARTPTS,"
        f"scale={inner_w}:-2:force_original_aspect_ratio=decrease,setsar=1,fps=30[scaled];"
        f"[scaled]split=2[main][shadow_src];"
        f"[shadow_src]format=rgba,colorchannelmixer=aa=0.6,boxblur=12:1,format=yuva420p[shadow];"
        f"[bg][shadow]overlay=(W-w)/2+8:(H-h)/2+12[bg2];"
        f"[bg2][main]overlay=(W-w)/2:(H-h)/2,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st={max(0, target_seconds - 0.4):.2f}:d=0.4[outv]"
    )
    cmd = [FFMPEG, "-y", "-i", str(screen_rec), "-filter_complex", fc,
           "-map", "[outv]", "-t", f"{target_seconds}", "-c:v", "libx264",
           "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
           "-an", str(out_mp4)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out_mp4


def concat_segments(parts: list[Path], out_mp4: Path) -> Path:
    """ffmpeg concat demuxer — all parts must share codec/resolution/fps."""
    listfile = out_mp4.with_suffix(".concat.txt")
    listfile.write_text("\n".join(f"file '{p.as_posix()}'" for p in parts))
    cmd = [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
           "-c", "copy", str(out_mp4)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    listfile.unlink(missing_ok=True)
    return out_mp4


def render_mixed_audio(voiceover: Path, music: Path, total_seconds: float,
                       out_audio: Path, voice_start: float) -> Path:
    """Step 1 of the two-step mux: produce a clean voice+music m4a of exactly
    total_seconds. `voice_start` is when the voiceover begins (after the
    hook card). Doing audio in isolation (no video input in this graph)
    avoids the 'Queue input is backward in time' AAC corruption that bit us
    when amix lived in the same filter graph as a video stream."""
    bg_fade_out_start = max(0.0, total_seconds - BG_FADE_OUT)
    fc = (
        f"[0:a]adelay={int(voice_start * 1000)}|{int(voice_start * 1000)},"
        f"apad=whole_dur={total_seconds:.3f},"
        f"atrim=duration={total_seconds:.3f},asetpts=PTS-STARTPTS,"
        f"volume={VOICE_VOLUME}[voice];"
        f"[1:a]atrim=duration={total_seconds:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={BG_FADE_IN},"
        f"afade=t=out:st={bg_fade_out_start:.3f}:d={BG_FADE_OUT},"
        f"volume={BG_VOLUME}[bg];"
        f"[voice][bg]amix=inputs=2:duration=first:normalize=0[a]"
    )
    cmd = [FFMPEG, "-y", "-i", str(voiceover), "-i", str(music),
           "-filter_complex", fc, "-map", "[a]",
           "-c:a", "aac", "-b:a", "192k", "-t", f"{total_seconds}", str(out_audio)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        raise RuntimeError(f"ffmpeg audio-mix failed (exit {proc.returncode})")
    return out_audio


def mix_audio_with_video(video: Path, voiceover: Path, music: Path,
                         total_seconds: float, out_mp4: Path,
                         voice_start: float = T_TITLE) -> Path:
    """Two-step mux: pre-render the audio mix into an intermediate m4a, then
    combine with the silent video.

    Earlier the audio + video lived in the same filter_complex; ffmpeg 8.1
    triggered an AAC 'Queue input is backward in time' error and truncated
    audio to ~3s. Splitting audio and video into separate ffmpeg invocations
    eliminates the cross-stream PTS interaction that caused the bug."""
    audio_tmp = out_mp4.with_suffix(".audio.m4a")
    render_mixed_audio(voiceover, music, total_seconds, audio_tmp, voice_start=voice_start)
    audio_dur = audio_stream_duration(audio_tmp)
    if audio_dur is None or audio_dur < total_seconds - 1.0:
        raise RuntimeError(
            f"intermediate audio mix is only {audio_dur}s (expected ~{total_seconds}s)"
        )

    # Step 2: mux silent video + the pre-rendered audio. Video gets a tail
    # fade-out; audio gets stream-copied (already AAC, already correct length).
    fade_out_start = max(0, total_seconds - T_FADE_OUT)
    video_fc = f"[0:v]fade=t=out:st={fade_out_start:.2f}:d={T_FADE_OUT}[v]"
    cmd = [FFMPEG, "-y", "-i", str(video), "-i", str(audio_tmp),
           "-filter_complex", video_fc,
           "-map", "[v]", "-map", "1:a",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "copy", "-movflags", "+faststart",
           "-t", f"{total_seconds}", str(out_mp4)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        raise RuntimeError(f"ffmpeg mux failed (exit {proc.returncode})")
    audio_tmp.unlink(missing_ok=True)

    out_audio_dur = audio_stream_duration(out_mp4)
    if out_audio_dur is None or out_audio_dur < total_seconds - 1.0:
        debug_dir = ROOT / ".lifestyle-debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(video, debug_dir / "base.mp4")
        except Exception:
            pass
        (debug_dir / "ffmpeg-cmd.txt").write_text(" ".join(cmd))
        (debug_dir / "ffmpeg-stderr.txt").write_text(proc.stderr or "")
        raise RuntimeError(
            f"final mux produced only {out_audio_dur}s of audio "
            f"(expected ~{total_seconds}s) — refusing to ship a silent video. "
            f"Debug artifacts in {debug_dir}/"
        )
    return out_mp4


def audio_stream_duration(path: Path) -> Optional[float]:
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    out = (res.stdout or "").strip()
    if not out:
        return None
    try:
        return float(out)
    except ValueError:
        return None


# --------------------------------------------------------------------------------------
# Main render
# --------------------------------------------------------------------------------------

def render_aspect(aspect: str, *, broll: list[Path], screen_rec: Optional[Path],
                  hook_text: str, voiceover: Path, output_prefix: str,
                  workdir: Path, segs: dict) -> Path:
    """Render one aspect ratio. `segs` carries per-segment durations derived
    from the voiceover length (see derive_segment_durations)."""
    if aspect == "vertical":
        w, h = 1080, 1920
    elif aspect == "square":
        w, h = 1080, 1080
    else:
        raise ValueError(f"unknown aspect {aspect}")

    base = workdir / aspect
    base.mkdir(parents=True, exist_ok=True)

    # 1) Hook title card
    hook_png = render_text_card(hook_text, width=w, height=h, out_png=base / "title.png",
                                bg_color=(0, 0, 0), text_color=(255, 255, 255), max_font_size=84)
    title_mp4 = render_card_segment(hook_png, segs["t_title"], w, h, base / "01-title.mp4")

    # 2) B-roll segment with logo watermark
    broll_mp4 = render_broll_segment(broll, segs["t_broll"], w, h, LOGO_PATH, base / "02-broll.mp4")

    # 3) Screen recording insert (or fall back to b-roll filler)
    if screen_rec and screen_rec.exists():
        screen_mp4 = render_screen_segment(screen_rec, segs["t_screen"], w, h, base / "03-screen.mp4")
    else:
        # Fallback: extend b-roll by another t_screen seconds
        screen_mp4 = render_broll_segment(broll, segs["t_screen"], w, h, LOGO_PATH, base / "03-broll-fallback.mp4")

    # 4) Outro CTA
    outro_png = render_text_card("meetdossie.com/founding", width=w, height=h, out_png=base / "outro.png",
                                 bg_color=NAVY, text_color=BLUSH_LIGHT, max_font_size=80)
    outro_mp4 = render_card_segment(outro_png, segs["t_outro"], w, h, base / "04-outro.mp4")

    # 5) Concat
    base_mp4 = concat_segments([title_mp4, broll_mp4, screen_mp4, outro_mp4], base / "base.mp4")

    # 6) Mix audio (total = sum of segment durations)
    out_path = FINISHED_DIR / f"{output_prefix}-{aspect}.mp4"
    mix_audio_with_video(base_mp4, voiceover, BG_MUSIC, segs["total"], out_path,
                         voice_start=segs["t_title"])
    return out_path


def find_latest_screen_recording() -> Optional[Path]:
    if not SCREEN_RECORDINGS_DIR.exists():
        return None
    candidates = sorted(SCREEN_RECORDINGS_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def parse_screen_recording_library() -> list[dict]:
    """Parse the markdown table in Media/screen-recordings/LIBRARY.md.

    Returns a list of dicts:
      {filename, personas: [str], voice, demo_account, notes}

    Returns [] if LIBRARY.md is missing — callers should fall back to mtime
    selection in that case.
    """
    library_path = SCREEN_RECORDINGS_DIR / "LIBRARY.md"
    if not library_path.exists():
        return []
    entries: list[dict] = []
    in_table = False
    for raw in library_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("|") and "Filename" in line and "Persona" in line:
            in_table = True
            continue
        if in_table and line.startswith("|---"):
            continue
        if in_table and line.startswith("|"):
            cols = [c.strip() for c in line.strip("|").split("|")]
            if len(cols) < 4:
                continue
            entries.append({
                "filename": cols[0],
                "personas": [p.strip().lower() for p in cols[1].split("/") if p.strip()],
                "voice": cols[2],
                "demo_account": cols[3],
                "notes": cols[4] if len(cols) > 4 else "",
            })
        elif in_table and not line.startswith("|"):
            in_table = False  # left the table
    return entries


def select_screen_recording(topic: str, persona: Optional[str]) -> Optional[Path]:
    """Pick the right screen recording for (topic, persona) per LIBRARY.md.

    Match logic:
      1. Filename prefix == topic.replace("_", "-")
      2. Persona is in the recording's allowed-persona list (when persona is given)
      3. Newest filename (lexicographic descending — date-suffixed names sort right)

    If no LIBRARY.md, falls back to find_latest_screen_recording() so older
    workflows still work. If LIBRARY.md exists but no entry matches, returns
    None — the caller will fall back to b-roll filler rather than risk a
    persona-gender mismatch (e.g., Brenda voiceover over a male-agent recording).
    """
    library = parse_screen_recording_library()
    if not library:
        return find_latest_screen_recording()

    topic_slug = topic.replace("_", "-")
    candidates = [e for e in library if e["filename"].startswith(topic_slug + "-")]
    if persona:
        persona_lower = persona.lower()
        candidates = [e for e in candidates if persona_lower in e["personas"]]

    if not candidates:
        print(f"[screen-rec] no LIBRARY.md match for topic={topic} persona={persona} - using b-roll filler instead")
        return None

    candidates.sort(key=lambda e: e["filename"], reverse=True)
    chosen = candidates[0]
    path = SCREEN_RECORDINGS_DIR / chosen["filename"]
    if not path.exists():
        print(f"[screen-rec] WARN: LIBRARY.md lists {chosen['filename']} but the file is missing - using b-roll filler")
        return None
    print(f"[screen-rec] LIBRARY.md match: {chosen['filename']} (voice={chosen['voice']}, demo={chosen['demo_account']})")
    return path


def load_env_local() -> dict:
    """Load .env.local from MeetDossie root into os.environ if not already set.
    Lets the script auto-pick up ELEVENLABS_API_KEY / PEXELS_API_KEY without
    requiring the caller to wrap the invocation with env-var prefixes."""
    env_path = ROOT / ".env.local"
    loaded: dict = {}
    if not env_path.exists():
        return loaded
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if not k or not v:
            continue
        loaded[k] = v
        # Don't clobber an existing env var (CLI-passed values win)
        os.environ.setdefault(k, v)
    return loaded


def main():
    # Load .env.local before argparse reads its defaults from os.environ.
    load_env_local()

    ap = argparse.ArgumentParser(description="Generate a lifestyle marketing video for Dossie")
    ap.add_argument("--topic", required=True, help="content topic key (e.g. morning_brief)")
    ap.add_argument("--hook", help="title-card text")
    ap.add_argument("--voiceover-script", dest="voiceover_script", help="text fed to ElevenLabs Bill")
    ap.add_argument("--screen-recording", dest="screen_recording", help="path to the user's recorded MP4")
    ap.add_argument("--output-prefix", dest="output_prefix", help="filename prefix for finished videos")
    ap.add_argument("--platform", help="target platform string (informational)")
    ap.add_argument("--probe", action="store_true", help="just probe Pexels and dump the response")
    ap.add_argument("--preview-broll", action="store_true",
                    help="gather Pexels candidates, save Media/b-roll/<topic>/candidates.json, print picks, exit")
    ap.add_argument("--no-broll", action="store_true", help="skip Pexels b-roll, use black filler")
    ap.add_argument("--no-zernio", action="store_true", help="skip Zernio upload step")
    ap.add_argument("--week", type=int, default=1, help="content_calendar week_number (default 1)")
    ap.add_argument("--day", type=int, default=1, help="content_calendar day_of_week (default 1)")
    ap.add_argument("--pexels-key", dest="pexels_key", default=os.environ.get("PEXELS_API_KEY", ""))
    ap.add_argument("--elevenlabs-key", dest="elevenlabs_key", default=os.environ.get("ELEVENLABS_API_KEY", ""))
    args = ap.parse_args()

    # Probe mode — just dump the Pexels response and exit so we can verify schema.
    if args.probe:
        if not args.pexels_key:
            print("ERROR: PEXELS_API_KEY not provided (env or --pexels-key).", file=sys.stderr)
            return 2
        queries = TOPIC_KEYWORDS.get(args.topic, [args.topic.replace("_", " ")])
        for q in queries[:1]:  # just one query in probe mode
            print(f"\n=== Pexels search: '{q}' (orientation=portrait) ===")
            try:
                resp = pexels_search(args.pexels_key, q, orientation="portrait")
            except RuntimeError as e:
                print(f"FAIL: {e}", file=sys.stderr)
                return 1
            print(json.dumps(resp, indent=2)[:6000])
        return 0

    # Preview-broll mode — gather candidates with quality filters, save the
    # candidates.json manifest, print the top picks, exit before render.
    if args.preview_broll:
        if not args.pexels_key:
            print("ERROR: PEXELS_API_KEY not provided (env or --pexels-key).", file=sys.stderr)
            return 2
        cands = gather_broll_candidates(args.pexels_key, args.topic, target_w=1080, target_h=1920)
        if not cands:
            print(f"[preview] no candidates passed quality filters for topic={args.topic}", file=sys.stderr)
            return 1
        picks = cands[:BROLL_PICK_COUNT]
        save_candidates_json(args.topic, cands, picks)
        print(f"\n=== B-roll candidates for topic={args.topic} ===")
        print(f"min_width={BROLL_MIN_WIDTH}  duration={BROLL_MIN_DURATION}-{BROLL_MAX_DURATION}s  "
              f"ideal={BROLL_IDEAL_DURATION}s  found={len(cands)}\n")
        for i, c in enumerate(cands, 1):
            tag = " [PICK]" if c["id"] in [p["id"] for p in picks] else ""
            print(f"{i:2d}. id={c['id']}{tag}  dur={c['duration']}s  {c['width']}x{c['height']}  "
                  f"q={c.get('file_quality')}  query='{c['query']}'\n     {c['preview_url']}")
        manifest = BROLL_DIR / args.topic / "candidates.json"
        print(f"\n[preview] manifest: {manifest}")
        return 0

    # Render mode — pull hook + voiceover_script from content_calendar by
    # (topic, week, day). CLI overrides win when explicitly passed (so an
    # orchestrator that already resolved them can avoid a second round-trip),
    # but there is no hardcoded fallback: an empty DB row is a hard fail.
    cal_row = None
    try:
        cal_row = fetch_content_calendar_row(args.topic, args.week, args.day)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 4
    if cal_row is None:
        print(f"ERROR: no content_calendar row for topic={args.topic} "
              f"week={args.week} day={args.day}. Verify the row exists and "
              f"is_active=true, or pass --week/--day explicitly.", file=sys.stderr)
        return 4
    hook = args.hook or cal_row.get("hook")
    voiceover_script = args.voiceover_script or cal_row.get("voiceover_script")
    if not hook or not voiceover_script:
        print(f"ERROR: content_calendar row missing hook or voiceover_script "
              f"for topic={args.topic} week={args.week} day={args.day}.", file=sys.stderr)
        return 4
    print(f"[content] week={cal_row.get('week_number')} day={cal_row.get('day_of_week')} "
          f"feature='{cal_row.get('feature')}'")
    print(f"[content] hook: {hook}")
    print(f"[content] script ({len(voiceover_script)} chars): {voiceover_script[:160]}"
          + ("..." if len(voiceover_script) > 160 else ""))
    persona = (cal_row.get("persona") or "").lower() or None
    if persona:
        demo = PERSONA_DEMO_ACCOUNT.get(persona)
        if demo:
            print(f"[content] persona={persona} -> demo account: {demo['name']} ({demo['email']})")
        else:
            print(f"[content] persona={persona} (no demo account mapping)")
    if not args.elevenlabs_key:
        print("ERROR: ELEVENLABS_API_KEY not provided. Add it to MeetDossie/.env.local "
              "(line: ELEVENLABS_API_KEY=\"sk_...\") or pass --elevenlabs-key.", file=sys.stderr)
        return 2

    # Resolve inputs — LIBRARY.md drives selection so a Brenda voiceover
    # never lands over Heath-on-camera footage and vice versa.
    screen_rec = Path(args.screen_recording) if args.screen_recording else select_screen_recording(args.topic, persona)
    if not screen_rec:
        print("WARN: no screen recording provided or found in screen-recordings/. Using b-roll filler for that segment.")
    else:
        print(f"[input] screen recording: {screen_rec}")

    output_prefix = args.output_prefix or f"{args.topic}-{__import__('datetime').date.today().isoformat()}"

    # 1) Pexels b-roll
    if args.no_broll or not args.pexels_key:
        if args.no_broll:
            print("[broll] --no-broll set, skipping")
        else:
            print("WARN: PEXELS_API_KEY not set, skipping b-roll. Pass --pexels-key or set env.")
        broll_clips = []
    else:
        print(f"[broll] fetching Pexels footage for topic={args.topic}")
        broll_clips = fetch_broll(args.pexels_key, args.topic, target_w=1080, target_h=1920)
        print(f"[broll] {len(broll_clips)} clips downloaded")

    # 2) Voiceover (hard-fails if ElevenLabs returns nothing — we don't ship silent videos)
    voiceover_path = VOICEOVERS_DIR / f"{output_prefix}-voiceover.mp3"
    print(f"[voice] generating Bill voiceover -> {voiceover_path}")
    try:
        synth_voiceover(args.elevenlabs_key, voiceover_script, voiceover_path)
    except RuntimeError as e:
        print(f"ERROR: voiceover synthesis failed: {e}", file=sys.stderr)
        print("ERROR: aborting render — a silent video is worse than no video.", file=sys.stderr)
        return 3
    voice_dur = duration(voiceover_path)
    print(f"[voice] duration = {voice_dur:.2f}s  size = {voiceover_path.stat().st_size} bytes")

    # 2b) Derive segment durations from voiceover length (no hardcoded 38s).
    segs = derive_segment_durations(voice_dur)
    print(f"[timing] total={segs['total']:.2f}s  hook={segs['t_title']:.2f}s  "
          f"broll={segs['t_broll']:.2f}s  screen={segs['t_screen']:.2f}s  "
          f"outro={segs['t_outro']:.2f}s")

    # 3) Render both aspects in a tempdir
    FINISHED_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dossie-render-") as tmp:
        workdir = Path(tmp)
        outputs = []
        for aspect in ("vertical", "square"):
            print(f"[render] {aspect}")
            out = render_aspect(aspect, broll=broll_clips, screen_rec=screen_rec,
                                hook_text=hook, voiceover=voiceover_path,
                                output_prefix=output_prefix, workdir=workdir,
                                segs=segs)
            outputs.append(out)
            d = duration(out)
            a_dur = audio_stream_duration(out)
            size_mb = out.stat().st_size / (1024 * 1024)
            print(f"  -> {out}  video={d:.2f}s  audio={a_dur}s  size={size_mb:.2f} MB")

    print("\n[done] outputs:")
    for o in outputs:
        print(f"  {o}")
    if args.platform:
        print(f"[done] platform target: {args.platform}")

    # Optional Zernio upload. Triggered when ZERNIO_API_KEY is in the local
    # env (e.g. via .env.local) AND --no-zernio wasn't passed. Fails soft —
    # a missing key just prints the local file paths so the orchestrator can
    # fall back to a Telegram-attach-and-manual-upload flow.
    zernio_key = os.environ.get("ZERNIO_API_KEY", "")
    if args.no_zernio:
        print("[zernio] --no-zernio set, skipping upload")
    elif not zernio_key:
        print("[zernio] ZERNIO_API_KEY not in local env — skipping upload.")
        print("[zernio] To enable: add ZERNIO_API_KEY=\"...\" to MeetDossie/.env.local")
        print("[zernio] Local files for manual upload:")
        for o in outputs:
            print(f"  {o}")
    else:
        print("[zernio] uploading both renders...")
        upload_results = []
        for o in outputs:
            print(f"[zernio] presign + PUT {o.name}")
            res = zernio_upload_local_file(zernio_key, o, "video/mp4")
            upload_results.append({"file": str(o), "result": res})
            if res.get("ok"):
                print(f"  -> publicUrl: {res['publicUrl']}  size={res.get('size_bytes')} put_status={res.get('put_status')}")
            else:
                print(f"  FAIL step={res.get('step')} status={res.get('status')} error={res.get('error', '')[:300]}")
        # Persist a sidecar JSON so the DONE handler / orchestrator can read it.
        manifest = FINISHED_DIR / f"{output_prefix}-zernio.json"
        manifest.write_text(json.dumps({
            "topic": args.topic,
            "week": args.week,
            "day": args.day,
            "uploads": upload_results,
            "generated_at": __import__("datetime").datetime.now().isoformat(),
        }, indent=2))
        print(f"[zernio] manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
