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

# Timing (seconds)
T_TITLE = 3.0
T_BROLL = 15.0
T_SCREEN = 14.0
T_OUTRO = 6.0
T_FADE_OUT = 1.0  # final fade to black at the end of outro
TOTAL_DURATION = T_TITLE + T_BROLL + T_SCREEN + T_OUTRO  # 38s

# Audio mix
BG_VOLUME = 0.08
VOICE_VOLUME = 1.0
BG_FADE_IN = 1.0
BG_FADE_OUT = 2.0

# Pexels search keywords by topic
TOPIC_KEYWORDS = {
    "morning_brief": ["real estate agent morning", "agent coffee desk", "realtor working"],
    "trec_deadlines": ["real estate paperwork", "agent signing contract", "realtor documents"],
    "draft_emails": ["agent on phone", "realtor texting", "real estate communication"],
    "talk_to_dossie": ["agent driving", "realtor car", "agent between showings"],
    "pipeline_view": ["real estate team", "agent laptop", "realtor busy"],
}

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
                  min_duration: int = 4, max_duration: int = 15) -> dict:
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
    req = urllib.request.Request(url, headers={"Authorization": api_key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"Pexels HTTP {e.code}: {body}") from e


def pick_video_file(video: dict, target_w: int, target_h: int) -> Optional[dict]:
    """Choose the best video_files entry for the target resolution. Pexels
    typically returns multiple resolutions per video; we want the smallest one
    that's >= target on both dimensions, falling back to the largest available."""
    files = video.get("video_files") or []
    if not files:
        return None
    # Prefer files that meet/exceed target dimensions
    candidates = [f for f in files if (f.get("width") or 0) >= target_w and (f.get("height") or 0) >= target_h]
    if candidates:
        candidates.sort(key=lambda f: (f.get("width") or 0) * (f.get("height") or 0))
        return candidates[0]
    # Fallback: largest available
    files = sorted(files, key=lambda f: (f.get("width") or 0) * (f.get("height") or 0), reverse=True)
    return files[0]


def fetch_broll(api_key: str, topic: str, *, target_w: int, target_h: int,
                count: int = 4, out_dir: Path = None) -> list[Path]:
    """Search Pexels for the topic's keywords and download up to `count`
    short clips. Caches per-(topic,query,id) so re-runs don't re-download."""
    out_dir = out_dir or (BROLL_DIR / topic)
    out_dir.mkdir(parents=True, exist_ok=True)
    queries = TOPIC_KEYWORDS.get(topic, [topic.replace("_", " ")])
    orientation = "portrait" if target_h > target_w else ("square" if target_h == target_w else "landscape")
    downloaded: list[Path] = []
    for q in queries:
        if len(downloaded) >= count:
            break
        try:
            resp = pexels_search(api_key, q, orientation=orientation)
        except RuntimeError as e:
            print(f"[pexels] search '{q}' failed: {e}", file=sys.stderr)
            continue
        videos = resp.get("videos") or []
        for v in videos:
            if len(downloaded) >= count:
                break
            file_info = pick_video_file(v, target_w, target_h)
            if not file_info:
                continue
            link = file_info.get("link")
            if not link:
                continue
            video_id = v.get("id") or "?"
            ext = ".mp4"
            local = out_dir / f"pexels-{video_id}-{file_info.get('quality','x')}{ext}"
            if not local.exists():
                print(f"[pexels] downloading {video_id} → {local.name}")
                try:
                    with urllib.request.urlopen(link, timeout=60) as r, open(local, "wb") as out:
                        shutil.copyfileobj(r, out)
                except Exception as e:
                    print(f"[pexels] download failed: {e}", file=sys.stderr)
                    if local.exists():
                        local.unlink()
                    continue
            downloaded.append(local)
    return downloaded


# --------------------------------------------------------------------------------------
# ElevenLabs voiceover
# --------------------------------------------------------------------------------------

def synth_voiceover(api_key: str, script_text: str, out_path: Path) -> Path:
    """Generate Bill voiceover. Add SSML <break time="0.4s"/> between sentences
    so the voice has natural pacing. eleven_turbo_v2 honors break tags inline."""
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
            out_path.write_bytes(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {body}") from e
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
    for i, _ in enumerate(clips):
        label_v = f"v{i}"
        parts.append(
            f"[{i}:v]trim=duration={per_clip:.3f},setpts=PTS-STARTPTS,"
            f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
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
    # Filter chain: black bg → recording scaled+padded → over a darker shadow
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


def mix_audio_with_video(video: Path, voiceover: Path, music: Path,
                         total_seconds: float, out_mp4: Path) -> Path:
    """Combine video silent track + voiceover (100%) + bg music (8%) into the
    final output. Voiceover plays from t=3 (after the title card). Music fades
    in 1s and out 2s."""
    bg_fade_out_start = max(0.0, total_seconds - BG_FADE_OUT)
    voice_start = T_TITLE  # voiceover starts when b-roll begins
    fc = (
        # voiceover delayed to start at t=T_TITLE
        f"[1:a]adelay={int(voice_start * 1000)}|{int(voice_start * 1000)},"
        f"atrim=duration={total_seconds:.3f},asetpts=PTS-STARTPTS,"
        f"volume={VOICE_VOLUME}[voice];"
        # background music trimmed and faded
        f"[2:a]atrim=duration={total_seconds:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={BG_FADE_IN},"
        f"afade=t=out:st={bg_fade_out_start:.3f}:d={BG_FADE_OUT},"
        f"volume={BG_VOLUME}[bg];"
        f"[voice][bg]amix=inputs=2:duration=longest:normalize=0[a];"
        # video fade out at the very end
        f"[0:v]fade=t=out:st={max(0, total_seconds - T_FADE_OUT):.2f}:d={T_FADE_OUT}[v]"
    )
    cmd = [FFMPEG, "-y", "-i", str(video), "-i", str(voiceover), "-i", str(music),
           "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
           "-t", f"{total_seconds}", str(out_mp4)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out_mp4


# --------------------------------------------------------------------------------------
# Main render
# --------------------------------------------------------------------------------------

def render_aspect(aspect: str, *, broll: list[Path], screen_rec: Optional[Path],
                  hook_text: str, voiceover: Path, output_prefix: str,
                  workdir: Path) -> Path:
    """Render one aspect ratio. Returns the final mp4 path."""
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
    title_mp4 = render_card_segment(hook_png, T_TITLE, w, h, base / "01-title.mp4")

    # 2) B-roll segment with logo watermark
    broll_mp4 = render_broll_segment(broll, T_BROLL, w, h, LOGO_PATH, base / "02-broll.mp4")

    # 3) Screen recording insert (or fall back to b-roll filler)
    if screen_rec and screen_rec.exists():
        screen_mp4 = render_screen_segment(screen_rec, T_SCREEN, w, h, base / "03-screen.mp4")
    else:
        # Fallback: extend b-roll by another T_SCREEN seconds
        screen_mp4 = render_broll_segment(broll, T_SCREEN, w, h, LOGO_PATH, base / "03-broll-fallback.mp4")

    # 4) Outro CTA
    outro_png = render_text_card("meetdossie.com/founding", width=w, height=h, out_png=base / "outro.png",
                                 bg_color=NAVY, text_color=BLUSH_LIGHT, max_font_size=80)
    outro_mp4 = render_card_segment(outro_png, T_OUTRO, w, h, base / "04-outro.mp4")

    # 5) Concat
    base_mp4 = concat_segments([title_mp4, broll_mp4, screen_mp4, outro_mp4], base / "base.mp4")

    # 6) Mix audio
    out_path = FINISHED_DIR / f"{output_prefix}-{aspect}.mp4"
    mix_audio_with_video(base_mp4, voiceover, BG_MUSIC, TOTAL_DURATION, out_path)
    return out_path


def find_latest_screen_recording() -> Optional[Path]:
    if not SCREEN_RECORDINGS_DIR.exists():
        return None
    candidates = sorted(SCREEN_RECORDINGS_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def main():
    ap = argparse.ArgumentParser(description="Generate a lifestyle marketing video for Dossie")
    ap.add_argument("--topic", required=True, help="content topic key (e.g. morning_brief)")
    ap.add_argument("--hook", help="title-card text")
    ap.add_argument("--voiceover-script", dest="voiceover_script", help="text fed to ElevenLabs Bill")
    ap.add_argument("--screen-recording", dest="screen_recording", help="path to the user's recorded MP4")
    ap.add_argument("--output-prefix", dest="output_prefix", help="filename prefix for finished videos")
    ap.add_argument("--platform", help="target platform string (informational)")
    ap.add_argument("--probe", action="store_true", help="just probe Pexels and dump the response")
    ap.add_argument("--no-broll", action="store_true", help="skip Pexels b-roll, use black filler")
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

    # Render mode requires more args
    if not args.hook or not args.voiceover_script:
        print("ERROR: --hook and --voiceover-script are required for render mode.", file=sys.stderr)
        return 2
    if not args.elevenlabs_key:
        print("ERROR: ELEVENLABS_API_KEY not provided.", file=sys.stderr)
        return 2

    # Resolve inputs
    screen_rec = Path(args.screen_recording) if args.screen_recording else find_latest_screen_recording()
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
        broll_clips = fetch_broll(args.pexels_key, args.topic, target_w=1080, target_h=1920, count=4)
        print(f"[broll] {len(broll_clips)} clips downloaded")

    # 2) Voiceover
    voiceover_path = VOICEOVERS_DIR / f"{output_prefix}-voiceover.mp3"
    print(f"[voice] generating Bill voiceover → {voiceover_path}")
    synth_voiceover(args.elevenlabs_key, args.voiceover_script, voiceover_path)
    voice_dur = duration(voiceover_path)
    print(f"[voice] duration = {voice_dur:.2f}s")

    # 3) Render both aspects in a tempdir
    FINISHED_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dossie-render-") as tmp:
        workdir = Path(tmp)
        outputs = []
        for aspect in ("vertical", "square"):
            print(f"[render] {aspect}")
            out = render_aspect(aspect, broll=broll_clips, screen_rec=screen_rec,
                                hook_text=args.hook, voiceover=voiceover_path,
                                output_prefix=output_prefix, workdir=workdir)
            outputs.append(out)
            d = duration(out)
            size_mb = out.stat().st_size / (1024 * 1024)
            print(f"  → {out}  duration={d:.2f}s  size={size_mb:.2f} MB")

    print("\n[done] outputs:")
    for o in outputs:
        print(f"  {o}")
    if args.platform:
        print(f"[done] platform target: {args.platform}")
    print("[done] Zernio media upload not yet wired — files are local only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
