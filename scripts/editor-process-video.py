#!/usr/bin/env python3
"""Editor agent video-processing pipeline for Dossie / real-estate content.

Implements EDITOR.md Section 2 (Audio-First Sync) and Section 5 (Production
Pipeline) exactly:

    1. Audio measurement   -- ffprobe, exact duration of the MASTER audio
                               (a supplied voiceover file if given, otherwise
                               the raw footage's own audio track). This is
                               the clock everything else is cut to -- NEVER
                               the script's estimated length.
    2. Transcription        -- OpenAI Whisper (same provider already used at
                               api/transcribe-video.js), word-level timestamps,
                               transcribed from the ACTUAL audio -- not the
                               original script text.
    3. Video trim            -- raw footage trimmed/padded to match the
                               measured audio duration exactly.
    4. Caption generation    -- .srt (plain, for the captions/ folder) +
                               a burn-in .ass with word-by-word highlight,
                               built from the Whisper word timestamps.
    5. Overlay application   -- hook-text card (top 20%, Cormorant Garamond,
                               white w/ black outline, max 2 lines) burned in
                               over the opening beat; captions burned in
                               bottom 20% per house style.
    6. Audio mix             -- loudnorm to -16 LUFS, optional music bed at
                               -24 LUFS (8 dB under voice).
    7. Render                -- 9:16 1080x1920 (or 1:1 1080x1080), scale-to-
                               fill + top-anchor crop, no letterbox, hard cuts
                               only (no filter does dissolves here, so this is
                               satisfied by construction).
    8. End card               -- 3s navy card, "meetdossie.com/founding" in
                               Cormorant Garamond, coral accent line.
    9. QA report              -- prints measured vs. final duration drift so
                               a human can eyeball the #1 failure mode before
                               anything ships.

House style constants (fonts, colors, timings, folder/naming convention) are
pulled directly from EDITOR.md Sections 3 and 4 -- do not hand-tune values
here without updating that doc first, it is the source of truth.

Usage:
    python editor-process-video.py \\
        --input Media/dossie/raw/dossie-educational-sticky-note-2026-08-06-v1.mp4 \\
        --account dossie --pillar educational \\
        --topic-slug sticky-note-hook \\
        --hook-text "It's never the contract." \\
        --aspect 9:16

    # Smoke-test the ffprobe -> trim -> caption -> export chain without a
    # real OpenAI key or real footage (used to verify the pipeline doesn't
    # crash before Heath has filmed anything):
    python editor-process-video.py --input some-test-clip.mp4 \\
        --account dossie --pillar educational --topic-slug smoke-test \\
        --skip-transcription

Env requirements:
    OPENAI_API_KEY   -- Whisper transcription (skip with --skip-transcription)

Optional env overrides (useful off Heath's Windows machine, e.g. CI/sandbox
testing where ffmpeg isn't at the usual WinGet path):
    EDITOR_FFMPEG_BIN
    EDITOR_FFPROBE_BIN
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, OSError):
    pass

# --------------------------------------------------------------------------------------
# Paths / constants -- EDITOR.md Section 4 (folder/naming convention) and
# Section 3 (house style spec)
# --------------------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "Media"
FONTS_DIR = ROOT / "public" / "fonts"

HOOK_FONT = FONTS_DIR / "CormorantGaramond-Bold.ttf"
ENDCARD_FONT = FONTS_DIR / "CormorantGaramond-SemiBold.ttf"
CAPTION_FONT = FONTS_DIR / "PlusJakartaSans-Bold.ttf"

# Brand (CLAUDE.md Section 4)
NAVY = "1A1A2E"
CORAL = "E8836B"
GOLD = "C9A96E"
WHITE = "FFFFFF"

VALID_ACCOUNTS = ("dossie", "real-estate", "workout-app")
VALID_PILLARS = ("educational", "hyper-local", "personal-brand", "social-proof", "listings")

# Pacing table (EDITOR.md Section 3) -- informational only right now; the
# pipeline does hard cuts at trim points, not multi-clip beat editing. Kept
# here so QA output can flag pillar/duration mismatches.
PACE_SECONDS_PER_CUT = {
    "educational": (4, 6),
    "hyper-local": (3, 4),  # closest analog not listed; treat like listings
    "personal-brand": (2, 3),
    "social-proof": (5, 8),
    "listings": (3, 4),
}

HOOK_WINDOW_SECONDS = 1.5  # "Hook opening: ALWAYS cut within 1.5 seconds"
ENDCARD_SECONDS = 3.0
TARGET_LUFS = -16.0
MUSIC_BED_DB_UNDER_VOICE = 8  # music sits 8dB below voice per spec

ASPECTS = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
}

WHISPER_MAX_BYTES = 24 * 1024 * 1024  # OpenAI hard limit, matches api/transcribe-video.js


def account_dir(account: str, sub: str) -> Path:
    d = MEDIA / account / sub
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------------------
# ffmpeg / ffprobe resolution
# --------------------------------------------------------------------------------------

def _resolve_binary(env_var: str, name: str, winget_glob_hint: str) -> str:
    override = os.environ.get(env_var)
    if override and Path(override).exists():
        return override
    found = shutil.which(name)
    if found:
        return found
    # Heath's Windows machine installs ffmpeg via WinGet -- same fallback
    # pattern as scripts/generate-lifestyle-video.py.
    winget_root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    if winget_root.exists():
        for candidate in winget_root.glob(winget_glob_hint):
            if candidate.exists():
                return str(candidate)
    raise RuntimeError(
        f"Could not locate {name}. Set {env_var} to an explicit path, install it "
        f"(WinGet: Gyan.FFmpeg), or make sure it's on PATH."
    )


def resolve_ffmpeg() -> str:
    return _resolve_binary(
        "EDITOR_FFMPEG_BIN", "ffmpeg",
        "Gyan.FFmpeg_Microsoft.Winget.Source_*/ffmpeg-*-full_build/bin/ffmpeg.exe",
    )


def resolve_ffprobe() -> str:
    return _resolve_binary(
        "EDITOR_FFPROBE_BIN", "ffprobe",
        "Gyan.FFmpeg_Microsoft.Winget.Source_*/ffmpeg-*-full_build/bin/ffprobe.exe",
    )


def run(cmd: list, **kwargs) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {proc.returncode}): {' '.join(str(c) for c in cmd)}\n"
            f"stderr:\n{proc.stderr[-2000:]}"
        )
    return proc


# --------------------------------------------------------------------------------------
# Step 1 -- Audio measurement (EDITOR.md Section 2, step 1)
# --------------------------------------------------------------------------------------

def ffprobe_json(ffprobe: str, path: Path) -> dict:
    proc = run([
        ffprobe, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    return json.loads(proc.stdout)


def has_audio_stream(probe: dict) -> bool:
    return any(s.get("codec_type") == "audio" for s in probe.get("streams", []))


def audio_duration_seconds(ffprobe: str, path: Path) -> float:
    """Duration of the audio stream specifically -- this is the MASTER CLOCK.
    Falls back to container `format.duration` if ffprobe doesn't report a
    stream-level duration (some containers only stamp format duration)."""
    probe = ffprobe_json(ffprobe, path)
    if not has_audio_stream(probe):
        raise RuntimeError(f"{path} has no audio stream -- cannot measure master audio duration.")
    audio_streams = [s for s in probe["streams"] if s.get("codec_type") == "audio"]
    dur = audio_streams[0].get("duration")
    if dur is None:
        dur = probe.get("format", {}).get("duration")
    if dur is None:
        raise RuntimeError(f"ffprobe could not determine audio duration for {path}")
    return float(dur)


def video_duration_seconds(ffprobe: str, path: Path) -> float:
    probe = ffprobe_json(ffprobe, path)
    return float(probe["format"]["duration"])


# --------------------------------------------------------------------------------------
# Step 2 -- Transcription (EDITOR.md Section 2, steps 3-4 / Section 8: Whisper)
# Reuses the same provider + model as api/transcribe-video.js (OpenAI Whisper).
# That endpoint uses response_format=text for a Telegram transcript; here we
# need word-level timestamps for word-by-word caption highlight, so we call
# the same API with response_format=verbose_json + timestamp_granularities.
# --------------------------------------------------------------------------------------

def extract_audio_wav(ffmpeg: str, video_path: Path, out_wav: Path) -> Path:
    run([
        ffmpeg, "-y", "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(out_wav),
    ])
    return out_wav


def whisper_transcribe(audio_path: Path, api_key: str) -> dict:
    """Calls OpenAI Whisper (whisper-1) with word-level timestamps.
    Returns {"text": str, "words": [{"word": str, "start": float, "end": float}]}."""
    size = audio_path.stat().st_size
    if size > WHISPER_MAX_BYTES:
        raise RuntimeError(
            f"Audio is {size / 1024 / 1024:.1f} MB, over Whisper's 24 MB limit. "
            f"Trim or compress before transcribing."
        )

    boundary = f"----EditorBoundary{uuid.uuid4().hex}"
    audio_bytes = audio_path.read_bytes()

    def field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode("utf-8")

    file_part = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8")

    body = b"".join([
        field("model", "whisper-1"),
        field("response_format", "verbose_json"),
        field("timestamp_granularities[]", "word"),
        file_part,
        audio_bytes,
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ])

    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            result = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"Whisper HTTP {e.code}: {err_body[:500]}") from e
    except Exception as e:
        raise RuntimeError(f"Whisper request failed: {e}") from e

    words = result.get("words") or []
    if not words:
        # verbose_json without word timestamps (e.g. very short/silent clip) --
        # degrade gracefully to segment-level so downstream doesn't crash.
        for seg in result.get("segments", []):
            words.append({"word": seg.get("text", "").strip(), "start": seg.get("start", 0.0), "end": seg.get("end", 0.0)})
    return {"text": result.get("text", ""), "words": words}


# --------------------------------------------------------------------------------------
# Step 3 -- Video trim to measured audio duration (EDITOR.md Section 2, step 2)
# --------------------------------------------------------------------------------------

def trim_or_pad_video(ffmpeg: str, ffprobe: str, video_path: Path, target_duration: float, out_path: Path) -> Path:
    vdur = video_duration_seconds(ffprobe, video_path)
    if vdur > target_duration + 0.01:
        # Longer than audio -- trim to exact length.
        run([
            ffmpeg, "-y", "-i", str(video_path),
            "-t", f"{target_duration:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-an",
            str(out_path),
        ])
    elif vdur < target_duration - 0.01:
        # Shorter than audio -- hold the last frame to fill the gap rather
        # than looping (EDITOR.md doesn't specify b-roll insertion logic yet;
        # freeze-frame is the safe, always-available fallback for a single
        # raw take).
        pad = target_duration - vdur
        run([
            ffmpeg, "-y", "-i", str(video_path),
            "-vf", f"tpad=stop_mode=clone:stop_duration={pad:.3f}",
            "-t", f"{target_duration:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-an",
            str(out_path),
        ])
    else:
        run([
            ffmpeg, "-y", "-i", str(video_path),
            "-c:v", "libx264", "-preset", "veryfast", "-an",
            str(out_path),
        ])
    return out_path


# --------------------------------------------------------------------------------------
# Step 4 -- Caption generation (EDITOR.md Section 2 step 3-4, Section 3 caption style)
# --------------------------------------------------------------------------------------

def format_srt_timestamp(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_ass_timestamp(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6_000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def group_words_into_lines(words: list, max_words_per_line: int = 6, max_gap: float = 0.6) -> list:
    """Groups Whisper word timestamps into caption lines. Breaks on a pause
    longer than max_gap or once max_words_per_line is hit -- keeps captions
    short enough to read at a glance, matching a bottom-third overlay."""
    lines, current = [], []
    for w in words:
        if current and (w["start"] - current[-1]["end"] > max_gap or len(current) >= max_words_per_line):
            lines.append(current)
            current = []
        current.append(w)
    if current:
        lines.append(current)
    return lines


def write_srt(words: list, out_srt: Path) -> Path:
    lines = group_words_into_lines(words)
    out = []
    for i, line_words in enumerate(lines, start=1):
        start = line_words[0]["start"]
        end = line_words[-1]["end"]
        text = " ".join(w["word"].strip() for w in line_words)
        out.append(f"{i}\n{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}\n{text}\n")
    out_srt.write_text("\n".join(out), encoding="utf-8")
    return out_srt


def build_caption_ass_events(words: list) -> list:
    """Bottom-third, centered, word-by-word highlight (active word = gold
    #C9A96E, inactive = white) -- EDITOR.md Section 3 caption style. Built as
    one ASS Dialogue event per active-word window, showing the full line with
    the active word's color swapped via inline override tags."""
    lines = group_words_into_lines(words)
    events = []
    for line_words in lines:
        for idx, active in enumerate(line_words):
            start, end = active["start"], active["end"]
            if end <= start:
                continue
            parts = []
            for j, w in enumerate(line_words):
                token = w["word"].strip()
                if j == idx:
                    parts.append(f"{{\\c&H6EA9C9&}}{token}{{\\c&HFFFFFF&}}")  # ASS is &HBBGGRR
                else:
                    parts.append(token)
            text = " ".join(parts)
            events.append(
                f"Dialogue: 0,{format_ass_timestamp(start)},{format_ass_timestamp(end)},Caption,,0,0,0,,{text}"
            )
    return events


def build_hook_ass_event(hook_text: str, window: float = HOOK_WINDOW_SECONDS) -> Optional[str]:
    if not hook_text:
        return None
    words = hook_text.strip().split()
    if len(words) > 8:
        print(f"[editor] WARN hook text is {len(words)} words, spec max is 8 -- burning it in anyway.")
    # Max 2 lines -- naive wrap at the midpoint word boundary if it's long.
    if len(" ".join(words)) > 28 and len(words) > 3:
        mid = len(words) // 2
        wrapped = " ".join(words[:mid]) + "\\N" + " ".join(words[mid:])
    else:
        wrapped = hook_text.strip()
    return f"Dialogue: 0,{format_ass_timestamp(0)},{format_ass_timestamp(window)},Hook,,0,0,0,,{wrapped}"


ASS_HEADER_TEMPLATE = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Cormorant Garamond,{hook_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,2,7,{margin_h},{margin_h},{top_margin_v},1
Style: Caption,Plus Jakarta Sans,{caption_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,2,{margin_h},{margin_h},{bottom_margin_v},1
Style: EndCard,Cormorant Garamond,{endcard_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_ass_file(words: list, hook_text: str, width: int, height: int, out_ass: Path,
                    caption_events_override: Optional[list] = None) -> Path:
    header = ASS_HEADER_TEMPLATE.format(
        w=width, h=height,
        hook_size=int(height * 0.045),
        caption_size=int(height * 0.035),
        endcard_size=int(height * 0.06),
        margin_h=int(width * 0.05),
        top_margin_v=int(height * 0.02),
        bottom_margin_v=int(height * 0.02),
    )
    events = []
    hook_event = build_hook_ass_event(hook_text)
    if hook_event:
        events.append(hook_event)
    events.extend(caption_events_override if caption_events_override is not None else build_caption_ass_events(words))
    out_ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_ass


def build_endcard_ass(width: int, height: int, out_ass: Path, cta: str = "meetdossie.com/founding") -> Path:
    header = ASS_HEADER_TEMPLATE.format(
        w=width, h=height,
        hook_size=int(height * 0.045),
        caption_size=int(height * 0.035),
        endcard_size=int(height * 0.055),
        margin_h=int(width * 0.05),
        top_margin_v=int(height * 0.02),
        bottom_margin_v=int(height * 0.02),
    )
    event = f"Dialogue: 0,0:00:00.00,0:00:{ENDCARD_SECONDS:.2f},EndCard,,0,0,0,,{cta}"
    out_ass.write_text(header + event + "\n", encoding="utf-8")
    return out_ass


# --------------------------------------------------------------------------------------
# Step 5-7 -- Overlay + crop/scale to aspect + render (EDITOR.md Section 3 Visual,
# Section 5 steps 5-7)
# --------------------------------------------------------------------------------------

def scale_crop_filter(width: int, height: int) -> str:
    """Scale-to-fill + top-anchor crop -- never letterbox, per house style
    and docs/VIDEO-RULES.md."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height}:(iw-{width})/2:0"
    )


def render_main_clip(ffmpeg: str, video_no_audio: Path, ass_path: Path, fonts_dir: Path,
                      width: int, height: int, out_path: Path) -> Path:
    vf = f"{scale_crop_filter(width, height)},ass={ass_path}:fontsdir={fonts_dir}"
    run([
        ffmpeg, "-y", "-i", str(video_no_audio),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    ])
    return out_path


def render_endcard_clip(ffmpeg: str, ass_path: Path, fonts_dir: Path, width: int, height: int, out_path: Path) -> Path:
    accent_h = max(4, int(height * 0.006))
    accent_y = int(height * 0.62)
    vf = (
        f"color=c=0x{NAVY}:s={width}x{height}:d={ENDCARD_SECONDS},"
        f"drawbox=x=0:y={accent_y}:w={width}:h={accent_h}:color=0x{CORAL}@1.0:t=fill,"
        f"ass={ass_path}:fontsdir={fonts_dir}"
    )
    run([
        ffmpeg, "-y", "-f", "lavfi", "-i", vf,
        "-t", f"{ENDCARD_SECONDS}",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        str(out_path),
    ])
    return out_path


# All final (non-Whisper) audio tracks are forced to this sample rate/layout.
# The end-card's silent bed (anullsrc) is generated at the same spec below --
# concat demuxer with "-c copy" requires every input to share codec params
# exactly, and ffmpeg's default AAC sample-rate choice is NOT guaranteed to
# match across separate encode calls (seen firsthand: one run picked 96kHz
# mono for the main clip vs 44.1kHz stereo for the end card, which silently
# truncated the concatenated output by ~1.7s with no error -- exactly the
# kind of drift EDITOR.md step 2 exists to catch, just one layer further
# downstream). Keep this explicit.
OUTPUT_SAMPLE_RATE = 44100
OUTPUT_CHANNELS = 2


def normalize_audio(ffmpeg: str, audio_in: Path, out_path: Path, music_bed: Optional[Path] = None) -> Path:
    if music_bed and music_bed.exists():
        # Voice normalized to -16 LUFS, music bed mixed in 8dB under voice.
        filter_complex = (
            f"[0:a]loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11[voice];"
            f"[1:a]volume=-{MUSIC_BED_DB_UNDER_VOICE}dB[music];"
            f"[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        run([
            ffmpeg, "-y", "-i", str(audio_in), "-i", str(music_bed),
            "-filter_complex", filter_complex, "-map", "[aout]",
            "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", str(OUTPUT_CHANNELS),
            "-c:a", "aac",
            str(out_path),
        ])
    else:
        run([
            ffmpeg, "-y", "-i", str(audio_in),
            "-af", f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11",
            "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", str(OUTPUT_CHANNELS),
            "-c:a", "aac",
            str(out_path),
        ])
    return out_path


def mux(ffmpeg: str, video_path: Path, audio_path: Path, out_path: Path) -> Path:
    run([
        ffmpeg, "-y", "-i", str(video_path), "-i", str(audio_path),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", str(OUTPUT_CHANNELS),
        "-shortest",
        str(out_path),
    ])
    return out_path


def concat_clips(ffmpeg: str, clip_paths: list, out_path: Path, tmp_dir: Path) -> Path:
    list_file = tmp_dir / "concat_list.txt"
    list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in clip_paths), encoding="utf-8")
    run([
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy",
        str(out_path),
    ])
    return out_path


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------

def process(args) -> dict:
    ffmpeg = resolve_ffmpeg()
    ffprobe = resolve_ffprobe()
    print(f"[editor] ffmpeg: {ffmpeg}")
    print(f"[editor] ffprobe: {ffprobe}")

    input_path = Path(args.input)
    if not input_path.exists():
        raise RuntimeError(f"--input not found: {input_path}")

    width, height = ASPECTS[args.aspect]
    filename_base = f"{args.account}-{args.pillar}-{args.topic_slug}-{args.date}-v{args.version}"

    with tempfile.TemporaryDirectory(prefix="editor-") as tmp:
        tmp_dir = Path(tmp)

        # ---- Step 1: audio measurement (the master clock) ----
        master_audio_source = Path(args.voiceover) if args.voiceover else input_path
        measured_duration = audio_duration_seconds(ffprobe, master_audio_source)
        print(f"[editor] STEP 1/8 measured master audio duration: {measured_duration:.3f}s "
              f"(source: {master_audio_source.name})")

        # ---- Step 2: transcription ----
        raw_audio_wav = tmp_dir / "master_audio.wav"
        extract_audio_wav(ffmpeg, master_audio_source, raw_audio_wav)

        if args.skip_transcription:
            print("[editor] STEP 2/8 transcription SKIPPED (--skip-transcription) -- smoke test mode")
            words = []
            transcript_text = ""
        else:
            api_key = args.openai_api_key or os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise RuntimeError(
                    "OPENAI_API_KEY not set and --skip-transcription not passed. "
                    "Set the env var or pass --skip-transcription for a dry run."
                )
            print("[editor] STEP 2/8 transcribing via Whisper...")
            result = whisper_transcribe(raw_audio_wav, api_key)
            words = result["words"]
            transcript_text = result["text"]
            print(f"[editor] transcript ({len(words)} words): {transcript_text[:120]}"
                  f"{'...' if len(transcript_text) > 120 else ''}")

        # ---- Step 3: video trim to measured audio duration ----
        print("[editor] STEP 3/8 trimming video to measured audio duration...")
        trimmed_video = tmp_dir / "trimmed.mp4"
        trim_or_pad_video(ffmpeg, ffprobe, input_path, measured_duration, trimmed_video)

        # ---- Step 4: caption generation ----
        print("[editor] STEP 4/8 generating captions...")
        captions_dir = account_dir(args.account, "captions")
        srt_path = captions_dir / f"{filename_base}.srt"
        if words:
            write_srt(words, srt_path)
            print(f"[editor] wrote {srt_path}")
        else:
            srt_path.write_text("", encoding="utf-8")
            print("[editor] no words to caption (smoke test or empty transcript) -- wrote empty .srt")

        ass_path = tmp_dir / "overlay.ass"
        build_ass_file(words, args.hook_text or "", width, height, ass_path)

        # ---- Step 5-7: overlay burn-in + scale/crop + render main clip ----
        print("[editor] STEP 5/8 burning in overlays (hook text + captions)...")
        main_clip = tmp_dir / "main_no_audio.mp4"
        render_main_clip(ffmpeg, trimmed_video, ass_path, FONTS_DIR, width, height, main_clip)

        # ---- Step 6: audio mix / normalize ----
        print("[editor] STEP 6/8 normalizing audio to -16 LUFS...")
        music_bed = Path(args.music) if args.music else None
        normalized_audio = tmp_dir / "audio_normalized.m4a"
        normalize_audio(ffmpeg, raw_audio_wav, normalized_audio, music_bed)

        main_with_audio = tmp_dir / "main_with_audio.mp4"
        mux(ffmpeg, main_clip, normalized_audio, main_with_audio)

        # ---- Step 8: end card + concat + final export ----
        print("[editor] STEP 7/8 rendering end card + concatenating...")
        endcard_ass = tmp_dir / "endcard.ass"
        build_endcard_ass(width, height, endcard_ass)
        endcard_clip = tmp_dir / "endcard.mp4"
        render_endcard_clip(ffmpeg, endcard_ass, FONTS_DIR, width, height, endcard_clip)

        # End card has no audio track; add silence so concat (same codec,
        # consistent stream layout) doesn't choke on a missing audio stream.
        # Sample rate/channels must match normalize_audio()'s output exactly
        # (see OUTPUT_SAMPLE_RATE/OUTPUT_CHANNELS) or concat -c copy silently
        # truncates the result -- this bit us during testing.
        endcard_with_audio = tmp_dir / "endcard_with_audio.mp4"
        run([
            ffmpeg, "-y", "-i", str(endcard_clip),
            "-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate={OUTPUT_SAMPLE_RATE}",
            "-c:v", "copy", "-c:a", "aac",
            "-ar", str(OUTPUT_SAMPLE_RATE), "-ac", str(OUTPUT_CHANNELS),
            "-shortest",
            str(endcard_with_audio),
        ])

        finished_dir = account_dir(args.account, "finished")
        final_path = finished_dir / f"{filename_base}.mp4"
        concat_clips(ffmpeg, [main_with_audio, endcard_with_audio], final_path, tmp_dir)

        # ---- QA ----
        final_duration = video_duration_seconds(ffprobe, final_path)
        main_duration = video_duration_seconds(ffprobe, main_with_audio)
        drift_ms = abs(main_duration - measured_duration) * 1000
        print("[editor] STEP 8/8 QA")
        print(f"[editor]   measured master audio : {measured_duration:.3f}s")
        print(f"[editor]   main clip duration     : {main_duration:.3f}s (drift {drift_ms:.0f}ms)")
        print(f"[editor]   final duration (+card) : {final_duration:.3f}s")
        if drift_ms > 100:
            print(f"[editor]   WARN drift exceeds 100ms -- investigate before shipping.")

        lo, hi = PACE_SECONDS_PER_CUT.get(args.pillar, (None, None))
        if lo:
            print(f"[editor]   pillar '{args.pillar}' target cut pace: {lo}-{hi}s/cut "
                  f"(single-take clip has no internal cuts yet -- informational only)")

        print(f"[editor] DONE -- final video: {final_path}")
        return {
            "final_path": str(final_path),
            "srt_path": str(srt_path),
            "measured_audio_duration": measured_duration,
            "final_duration": final_duration,
            "drift_ms": drift_ms,
            "transcript": transcript_text,
        }


def parse_args():
    p = argparse.ArgumentParser(description="Editor agent video-processing pipeline (EDITOR.md spec)")
    p.add_argument("--input", required=True, help="Raw footage file")
    p.add_argument("--account", required=True, choices=VALID_ACCOUNTS)
    p.add_argument("--pillar", required=True, choices=VALID_PILLARS)
    p.add_argument("--topic-slug", required=True)
    p.add_argument("--voiceover", default=None, help="Separate voiceover audio file; "
                    "defaults to using the raw footage's own audio track as the master clock")
    p.add_argument("--hook-text", default="", help="Top-third hook text overlay")
    p.add_argument("--music", default=None, help="Optional background music bed")
    p.add_argument("--aspect", default="9:16", choices=list(ASPECTS.keys()))
    p.add_argument("--date", default=None, help="YYYY-MM-DD, defaults to today")
    p.add_argument("--version", type=int, default=1)
    p.add_argument("--openai-api-key", default=None)
    p.add_argument("--skip-transcription", action="store_true",
                    help="Smoke-test mode: skip the Whisper call, burn in captions only if "
                         "words are otherwise supplied. Confirms ffprobe->trim->render chain.")
    return p.parse_args()


def main():
    args = parse_args()
    if args.date is None:
        import datetime
        args.date = datetime.date.today().isoformat()
    try:
        result = process(args)
    except Exception as e:
        print(f"[editor] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({k: v for k, v in result.items() if k != "transcript"}, indent=2))


if __name__ == "__main__":
    main()
