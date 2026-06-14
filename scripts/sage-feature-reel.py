#!/usr/bin/env python3
"""
sage-feature-reel.py — High-energy feature reel builder.

Heath's pivot 2026-06-13:
  - NO personas. NO Luna/Bill. NO static cards.
  - YES: OpenAI alloy voice (energetic), upbeat music, 1.5x sped-up b-roll,
    Hormozi-style burned-in animated captions, hard cuts, "Old way -> Dossie way"
    direct comparison overlays.

Pipeline per reel:
  1. Load tutorial bite (1080x1920, ~18-21s).
  2. Strip original audio. Speed video 1.5x -> ~12-14s.
  3. Build intro card (3s): "OLD WAY -> DOSSIE WAY" with feature tag.
  4. Build comparison card (4s): "Old: <pain>. Dossie: <relief>."
  5. Build CTA outro (3s): "meetdossie.com/founding" + dossie logo.
  6. Concat: intro -> sped-bite -> comparison -> outro -> ~25-30s total.
  7. Generate alloy TTS for energetic narration script.
  8. Layer narration + music bed (music ducked under voice).
  9. Burn in word-by-word Hormozi captions (word-level timing via ass subtitles).
  10. Export to Media/finished-videos/<slug>-feature-reel-<ts>.mp4.

Usage:
  python scripts/sage-feature-reel.py \
    --bite control-never-miss-a-deadline-again \
    --feature "TREC DEADLINE AUTO-CALC" \
    --old-way "8 minutes of math per contract" \
    --new-way "2 seconds. Every deadline. Auto." \
    --script "Option period. Financing. Closing. Get one wrong, you lose your buyer. Dossie reads the contract. Calculates every TREC deadline. Tracks every hour. Twenty-nine dollars a month. Texas agents — meetdossie.com slash founding." \
    --out-name "trec-deadlines-feature-reel-v1"
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BITES_DIR = ROOT / "Media" / "tutorial-videos"
FONT_PATH = ROOT / "Media" / "_fonts" / "PlusJakartaSans-Bold.ttf"
MUSIC_DEFAULT = ROOT / "Media" / "Music" / "joyinsound-corporate-motivational-background-music-403417.mp3"
OUT_DIR = ROOT / "Media" / "finished-videos"
WORK_DIR = ROOT / ".tmp-reel-work"

# Brand colors (CLAUDE.md sec 4)
BLUSH = "#F5E6E0"
CORAL = "#E8836B"
NAVY = "#1A1A2E"
GOLD = "#C9A96E"
SAGE = "#8BA888"

# ─── env load ─────────────────────────────────────────────────────────────────
def load_env():
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        eq = t.find("=")
        if eq < 0:
            continue
        k = t[:eq].strip()
        v = t[eq + 1:].strip().strip('"')
        if k not in os.environ:
            os.environ[k] = v

load_env()

# ─── helpers ──────────────────────────────────────────────────────────────────
def run(cmd, check=True):
    print(f"\n[run] {' '.join(str(c) for c in cmd)}")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"[FAIL] {r.stderr[-2000:]}", file=sys.stderr)
        sys.exit(1)
    return r

def probe_duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)])
    return float(r.stdout.strip())

# ─── TTS via edge-tts GuyNeural (free, energetic, alloy-equivalent) ───────────
# Heath asked for "alloy or fable" — OpenAI quota is exhausted, so we use
# Microsoft Edge's en-US-GuyNeural which is tagged "Passion" personality.
# Rate +15% + pitch +5Hz pushes it firmly into high-energy reel territory.
def synth_alloy(script_text: str, out_path: Path, voice: str = "en-US-GuyNeural", rate: str = "+15%", pitch: str = "+5Hz"):
    """Generate energetic narration via edge-tts (no API key required)."""
    import asyncio
    import edge_tts
    async def _run():
        comm = edge_tts.Communicate(script_text, voice=voice, rate=rate, pitch=pitch)
        await comm.save(str(out_path))
    asyncio.run(_run())
    print(f"[tts] wrote {out_path} ({out_path.stat().st_size} bytes) voice={voice} rate={rate} pitch={pitch}")
    return out_path

# ─── word-level timing for Hormozi captions ───────────────────────────────────
def words_with_timing(script_text: str, audio_duration: float):
    """Simple linear word timing. Each word gets equal share."""
    # Split keeping punctuation attached
    words = [w for w in re.split(r"\s+", script_text.strip()) if w]
    if not words:
        return []
    per = audio_duration / len(words)
    timed = []
    t = 0.0
    for w in words:
        timed.append({
            "word": w,
            "start": t,
            "end": t + per,
        })
        t += per
    return timed

# ─── ASS subtitle generation (Hormozi big-bold-pulse) ─────────────────────────
KEY_HIGHLIGHT_TERMS = {
    # dollars
    r"\$\d[\d,\.]*": GOLD,
    r"\d+ ?dollars?": GOLD,
    # time
    r"\d+ ?second(s)?": SAGE,
    r"\d+ ?minute(s)?": SAGE,
    r"\d+ ?hour(s)?": SAGE,
    # negation / pain
    r"never": CORAL,
    r"miss(ed)?": CORAL,
    r"wrong": CORAL,
    r"lose": CORAL,
    r"stress": CORAL,
    # product
    r"Dossie": BLUSH,
    r"TREC": GOLD,
    r"founding": GOLD,
    # punch words
    r"every": BLUSH,
    r"auto": SAGE,
    r"done": SAGE,
}

def color_for_word(word: str):
    """Return hex color (with #) or None."""
    lw = word.lower().strip(".,!?:;")
    for pat, col in KEY_HIGHLIGHT_TERMS.items():
        if re.fullmatch(pat, lw, re.IGNORECASE):
            return col
    return None

def hex_to_ass_color(hex_color: str):
    """ASS uses BBGGRR with &H prefix."""
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()

def write_ass(timed_words, offset_seconds: float, ass_path: Path, video_w=1080, video_h=1920, allowed_windows=None):
    """Build ASS file with one event per word group (2-3 words per card).

    allowed_windows: list of (start, end) tuples in TIMELINE seconds during
    which captions are visible. Any caption falling outside these windows is
    clipped or dropped (so captions don't bleed over static comparison/outro
    cards that already have their own text).
    """
    font_name = "Plus Jakarta Sans"
    # Group words into 2-3 word chunks for readable cards
    groups = []
    i = 0
    while i < len(timed_words):
        chunk_size = 2 if sum(len(timed_words[j]["word"]) for j in range(i, min(i+2, len(timed_words)))) > 14 else 3
        chunk = timed_words[i:i + chunk_size]
        if not chunk:
            break
        groups.append({
            "start": chunk[0]["start"],
            "end": chunk[-1]["end"],
            "words": chunk,
        })
        i += chunk_size

    def fmt_t(seconds):
        s = max(0.0, seconds)
        h = int(s // 3600)
        m = int((s % 3600) // 60)
        sec = s - h * 3600 - m * 60
        return f"{h}:{m:02d}:{sec:05.2f}"

    style_white = hex_to_ass_color("#FFFFFF")
    style_outline = hex_to_ass_color("#000000")
    # Position: just above center-bottom. Bigger font for Hormozi punch.
    margin_v = 720

    # Hormozi-style: BIG font, thick black outline, white text with color highlights
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {video_w}
PlayResY: {video_h}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font_name},130,{style_white},{style_white},{style_outline},&H80000000,1,0,0,0,100,100,3,0,1,12,4,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for g in groups:
        timeline_start = g["start"] + offset_seconds
        timeline_end = g["end"] + offset_seconds

        # Clip to allowed windows
        if allowed_windows:
            visible_in_any = False
            for ws, we in allowed_windows:
                # Compute intersection
                vs = max(timeline_start, ws)
                ve = min(timeline_end, we)
                if ve > vs + 0.05:
                    timeline_start, timeline_end = vs, ve
                    visible_in_any = True
                    break
            if not visible_in_any:
                continue

        # Build text with per-word color tags
        parts = []
        for w in g["words"]:
            word = w["word"]
            col = color_for_word(word)
            if col:
                ass_col = hex_to_ass_color(col)
                parts.append(f"{{\\c{ass_col}}}{word}{{\\c{style_white}}}")
            else:
                parts.append(word)
        text = " ".join(parts)
        # Pop-in effect: scale 70->105->100 over first 200ms for punch
        text_full = "{\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)\\t(120,220,\\fscx100\\fscy100)}" + text
        events.append(f"Dialogue: 0,{fmt_t(timeline_start)},{fmt_t(timeline_end)},Default,,0,0,0,,{text_full}")

    ass_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    print(f"[ass] wrote {ass_path} with {len(events)} caption events (from {len(groups)} groups)")
    return ass_path

# ─── card builders (intro / comparison / outro) ───────────────────────────────
def build_card(out_path: Path, duration: float, lines: list, bg_color: str, accent_color: str = None, kind: str = "default"):
    """
    Build a static card frame video.
    lines = list of dicts: {text, size, color (#hex), weight}
    """
    work = WORK_DIR
    work.mkdir(parents=True, exist_ok=True)

    # Total height of all lines (with 50px gaps) — center the block
    total_h = sum(l["size"] for l in lines) + 50 * (len(lines) - 1)
    y_cursor = (1920 - total_h) // 2

    drawtext_chain = []
    font_path_escaped = str(FONT_PATH).replace("\\", "/").replace(":", "\\:")
    for line in lines:
        # Escape ffmpeg drawtext special chars
        text = (line["text"]
                .replace("\\", "\\\\")
                .replace(":", "\\:")
                .replace("'", "’")  # use curly apostrophe to avoid quote hell
                .replace(",", "\\,")
                .replace("[", "\\[")
                .replace("]", "\\]"))
        size = line["size"]
        color = line["color"]
        drawtext_chain.append(
            f"drawtext=fontfile='{font_path_escaped}':text='{text}':"
            f"fontcolor={color}:fontsize={size}:x=(w-text_w)/2:y={y_cursor}"
        )
        y_cursor += size + 50

    lavfi_src = f"color=c={bg_color}:s=1080x1920:d={duration}:r=30"
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", lavfi_src,
        "-vf", ",".join(drawtext_chain),
        "-t", str(duration),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
        "-an",
        str(out_path),
    ]
    run(cmd)
    return out_path

# ─── main reel build ──────────────────────────────────────────────────────────
def build_reel(args):
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    work = WORK_DIR / f"reel-{ts}"
    work.mkdir()
    print(f"[work-dir] {work}")

    # 1) Resolve bite
    bite_candidates = sorted(BITES_DIR.glob(f"{args.bite}-v*.mp4"), reverse=True)
    if not bite_candidates:
        print(f"[FATAL] no bite found for slug {args.bite}", file=sys.stderr)
        sys.exit(1)
    bite_path = bite_candidates[0]
    print(f"[bite] using {bite_path}")

    # 2) Strip audio + speed video 1.5x
    sped = work / "sped.mp4"
    run([
        "ffmpeg", "-y", "-i", str(bite_path),
        "-an",
        "-vf", "setpts=PTS/1.5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
        str(sped),
    ])
    sped_dur = probe_duration(sped)
    print(f"[sped] duration = {sped_dur:.2f}s")

    # 3) Build intro card (3s) — "OLD WAY → DOSSIE WAY: <feature>"
    intro = work / "intro.mp4"
    build_card(intro, 3.0, [
        {"text": "OLD WAY", "size": 110, "color": CORAL, "weight": "bold"},
        {"text": "vs", "size": 70, "color": "white", "weight": "bold"},
        {"text": "DOSSIE WAY", "size": 110, "color": GOLD, "weight": "bold"},
        {"text": args.feature, "size": 60, "color": BLUSH, "weight": "bold"},
    ], bg_color=NAVY, kind="intro")

    # 4) Build comparison card (4s) — concrete "Old: X. Dossie: Y."
    comp = work / "comparison.mp4"
    build_card(comp, 4.0, [
        {"text": "OLD WAY:", "size": 75, "color": CORAL, "weight": "bold"},
        {"text": args.old_way, "size": 60, "color": "white", "weight": "bold"},
        {"text": "DOSSIE WAY:", "size": 75, "color": GOLD, "weight": "bold"},
        {"text": args.new_way, "size": 65, "color": BLUSH, "weight": "bold"},
    ], bg_color=NAVY, kind="comparison")

    # 5) Build outro card (3s) — CTA
    outro = work / "outro.mp4"
    build_card(outro, 3.0, [
        {"text": "TEXAS AGENTS", "size": 95, "color": BLUSH, "weight": "bold"},
        {"text": "$29/mo", "size": 130, "color": GOLD, "weight": "bold"},
        {"text": "meetdossie.com", "size": 80, "color": "white", "weight": "bold"},
        {"text": "/founding", "size": 80, "color": CORAL, "weight": "bold"},
    ], bg_color=NAVY, kind="outro")

    # 6) Concat: intro + sped + comparison + outro (all silent video, audio added later)
    concat_list = work / "concat.txt"
    with open(concat_list, "w") as f:
        for clip in [intro, sped, comp, outro]:
            f.write(f"file '{clip.as_posix()}'\n")
    silent_concat = work / "silent_concat.mp4"
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
        "-an",
        str(silent_concat),
    ])
    total_dur = probe_duration(silent_concat)
    print(f"[silent-concat] total duration = {total_dur:.2f}s")

    # 7) TTS narration via OpenAI alloy
    tts_path = work / "narration.mp3"
    synth_alloy(args.script, tts_path)
    tts_dur = probe_duration(tts_path)
    print(f"[tts] narration duration = {tts_dur:.2f}s")

    # 8) Word-level timing (offset by intro=3s; narration starts at intro end)
    narration_offset = 3.0  # narration starts after intro card
    timed = words_with_timing(args.script, tts_dur)
    ass_path = work / "captions.ass"
    # Only show animated captions during the bite section.
    # Static intro/comparison/outro cards already have their own text.
    bite_start = 3.0
    bite_end = 3.0 + sped_dur
    write_ass(timed, narration_offset, ass_path, allowed_windows=[(bite_start, bite_end)])

    # 9) Build music bed: loop + duck under voice
    music_path = Path(args.music) if args.music else MUSIC_DEFAULT
    if not music_path.exists():
        print(f"[FATAL] music not found: {music_path}", file=sys.stderr)
        sys.exit(1)

    # Pre-mix narration + music with sidechain ducking
    # narration: 0dB during speech; music: -6dB normally, ducked to -18dB when narration plays
    mixed_audio = work / "mixed_audio.mp3"
    # Pad narration with silence: starts at intro_offset (3s), ends before outro
    # Simpler approach: create narration aligned to start at 3s, music loops underneath whole video
    narration_padded = work / "narration_padded.mp3"
    run([
        "ffmpeg", "-y",
        "-i", str(tts_path),
        "-af", f"adelay={int(narration_offset * 1000)}|{int(narration_offset * 1000)},apad=whole_dur={total_dur}",
        str(narration_padded),
    ])
    # Loop music to total_dur, set volume low
    music_looped = work / "music_looped.mp3"
    run([
        "ffmpeg", "-y", "-stream_loop", "-1", "-i", str(music_path),
        "-t", str(total_dur),
        "-af", "volume=0.18",
        str(music_looped),
    ])
    # Mix narration (full vol) over music (ducked)
    run([
        "ffmpeg", "-y",
        "-i", str(narration_padded),
        "-i", str(music_looped),
        "-filter_complex",
        "[0:a]volume=1.0[v0];"
        "[1:a]volume=1.0[v1];"
        "[v1][v0]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[ducked];"
        "[v0][ducked]amix=inputs=2:duration=longest:dropout_transition=0[out]",
        "-map", "[out]",
        "-ac", "2", "-ar", "44100",
        str(mixed_audio),
    ])

    # 10) Burn captions into video + attach mixed audio
    out_name = args.out_name or f"{args.bite}-feature-reel-v1"
    final = OUT_DIR / f"{out_name}.mp4"
    ass_escaped = str(ass_path).replace("\\", "/").replace(":", "\\:")
    run([
        "ffmpeg", "-y",
        "-i", str(silent_concat),
        "-i", str(mixed_audio),
        "-vf", f"ass='{ass_escaped}'",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(final),
    ])
    final_dur = probe_duration(final)
    print(f"\n[DONE] {final}")
    print(f"       duration = {final_dur:.2f}s")
    print(f"       size = {final.stat().st_size / 1024 / 1024:.2f} MB")
    return final


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bite", required=True, help="tutorial bite slug (e.g. control-never-miss-a-deadline-again)")
    ap.add_argument("--feature", required=True, help="feature tag for intro card (e.g. 'TREC DEADLINE AUTO-CALC')")
    ap.add_argument("--old-way", dest="old_way", required=True, help="comparison: old way pain")
    ap.add_argument("--new-way", dest="new_way", required=True, help="comparison: dossie way")
    ap.add_argument("--script", required=True, help="narration script for alloy TTS")
    ap.add_argument("--out-name", dest="out_name", default=None, help="output filename stem (no extension)")
    ap.add_argument("--music", default=None, help="path to music mp3 (default: existing track)")
    args = ap.parse_args()
    build_reel(args)


if __name__ == "__main__":
    main()
