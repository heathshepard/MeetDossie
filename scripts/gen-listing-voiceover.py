"""Generate a listing-video voiceover with ElevenLabs, plus a character-level
timing JSON so the caller (generate-listing-video.js) can align specific
photo segments to specific words (e.g. the "kitchen" line lands on the
kitchen photo).

Voice: NEUTRAL PROFESSIONAL ONLY. Do NOT use Bill (pqHfZKP75CvOlQylNhV4) or
Luna (lxYfHSkYm1EzQzGhdbfc) — those are Dossie's product personas and using
them on Heath's personal listing videos conflates two separate brands.
Default here is Adam (pNInz6obpgDQGcFmaJgB) — clear, neutral, not dramatic.
If Heath clones his own voice later, point VOICE_ID at that clone instead;
nothing else about this pipeline needs to change.

Usage:
  ELEVENLABS_API_KEY=... python scripts/gen-listing-voiceover.py \
    --script-file listing-video-configs/702-fawndale-script.txt \
    --out-mp3 .tmp/702-fawndale-voiceover.mp3 \
    --out-timing .tmp/702-fawndale-timing.json \
    --target-seconds 30

Timing JSON schema:
  {
    "duration": 29.87,
    "text": "...",
    "characters": ["7","0","2",...],
    "char_start": [0.0, 0.06, ...],
    "char_end":   [0.06, 0.12, ...]
  }

Callers find a word's on-screen moment via `text.find("kitchen")` then index
into char_start/char_end at that offset — no extra API call needed.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_KEY = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVENLABS_API_KEY_PERSONAL")
MODEL = "eleven_turbo_v2"
DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"  # Adam — neutral professional, NOT Bill/Luna
BANNED_VOICE_IDS = {
    "pqHfZKP75CvOlQylNhV4": "Bill (Dossie product persona)",
    "lxYfHSkYm1EzQzGhdbfc": "Luna (Dossie product persona)",
}


def synthesize_with_timestamps(text, voice_id, stability, similarity, style, speed):
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    body = {
        "text": text,
        "model_id": MODEL,
        "voice_settings": {
            "stability": stability,
            "similarity_boost": similarity,
            "style": style,
            "use_speaker_boost": True,
            "speed": speed,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "xi-api-key": API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}\n")
        raise


def ffprobe_duration(path):
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script-file", required=True)
    ap.add_argument("--out-mp3", required=True)
    ap.add_argument("--out-timing", required=True)
    ap.add_argument("--voice-id", default=DEFAULT_VOICE)
    ap.add_argument("--target-seconds", type=float, default=30.0)
    ap.add_argument("--tolerance-seconds", type=float, default=5.0)
    args = ap.parse_args()

    if args.voice_id in BANNED_VOICE_IDS:
        sys.stderr.write(
            f"REFUSING: voice_id {args.voice_id} is {BANNED_VOICE_IDS[args.voice_id]}. "
            "Never use Dossie's product voices on Heath's personal listing videos.\n"
        )
        return 2

    if not API_KEY:
        sys.stderr.write("ELEVENLABS_API_KEY not set.\n")
        return 2

    text = Path(args.script_file).read_text(encoding="utf-8").strip()
    print(f"[voiceover] script: {len(text)} chars, voice={args.voice_id}")

    speed = 1.0
    stability = 0.5
    similarity = 0.8
    style = 0.15

    out_mp3 = Path(args.out_mp3)
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_timing = Path(args.out_timing)
    out_timing.parent.mkdir(parents=True, exist_ok=True)

    result = None
    for attempt in range(1, 6):
        print(f"[try {attempt}] speed={speed:.2f}")
        result = synthesize_with_timestamps(text, args.voice_id, stability, similarity, style, speed)
        audio_bytes = base64.b64decode(result["audio_base64"])
        out_mp3.write_bytes(audio_bytes)
        dur = ffprobe_duration(out_mp3)
        delta = dur - args.target_seconds
        print(f"  duration={dur:.2f}s delta={delta:+.2f}s")
        if abs(delta) <= args.tolerance_seconds:
            print(f"[done] within tolerance: {dur:.2f}s vs target {args.target_seconds}s")
            break
        ratio = dur / args.target_seconds
        new_speed = max(0.7, min(1.2, speed * ratio))
        if abs(new_speed - speed) < 0.01:
            print("[stop] speed pinned, cannot improve further")
            break
        speed = new_speed
    else:
        print("[stop] exhausted attempts, using last result")

    alignment = result["alignment"]
    timing = {
        "duration": ffprobe_duration(out_mp3),
        "text": text,
        "characters": alignment["characters"],
        "char_start": alignment["character_start_times_seconds"],
        "char_end": alignment["character_end_times_seconds"],
        "voice_id": args.voice_id,
    }
    out_timing.write_text(json.dumps(timing), encoding="utf-8")
    print(f"[voiceover] SAVED mp3={out_mp3} timing={out_timing} duration={timing['duration']:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
