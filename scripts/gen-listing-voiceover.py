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

sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
import tts_normalize  # noqa: E402  (path set immediately above)

API_KEY = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVENLABS_API_KEY_PERSONAL")
# MODEL CHOICE, settled 2026-09-16 (previously a bare eleven_turbo_v2).
#
#   * Heath's own cloned voice -> eleven_v3 with stability 0.3 / style 0.4.
#     That is the exact configuration Heath approved 2026-09-14 after
#     reviewing three listing renders (heath-voice-clone-settings-locked.md)
#     and is the only decision of record on the clone. This script used to
#     default to 0.5/0.15 on turbo, so the clone had never actually been
#     rendered at its approved settings -- a likely part of the "sounds off"
#     complaint. These values are applied, NOT re-tuned; do not change them
#     without an explicit new decision from Heath.
#   * Any other (stock/neutral) voice -> eleven_multilingual_v2, ElevenLabs'
#     highest-fidelity narration model.
#   * eleven_turbo_v2 is retired here. Turbo trades quality for latency and
#     is built for real-time/conversational use; these are pre-rendered
#     marketing assets with no latency constraint, so that trade buys us
#     nothing. Turbo belongs on the interactive paths (Jarvis), not video.
MODEL_NARRATION = "eleven_multilingual_v2"
MODEL_CLONE = "eleven_v3"
MODEL = MODEL_NARRATION  # back-compat for callers importing MODEL
CLONE_LOCKED_STABILITY = 0.3
CLONE_LOCKED_STYLE = 0.4
CLONE_CONFIG_PATH = Path(__file__).parent / "config" / "heath-voice-clone.json"


def clone_voice_id():
    """Heath's cloned voice id, read from the gitignored clone config rather
    than hardcoded -- docs/ENV.md treats the id itself as a secret."""
    try:
        return json.loads(
            CLONE_CONFIG_PATH.read_text(encoding="utf-8")).get("voice_id")
    except (OSError, ValueError):
        return None
DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"  # Adam — neutral professional, NOT Bill/Luna
BANNED_VOICE_IDS = {
    "pqHfZKP75CvOlQylNhV4": "Bill (Dossie product persona)",
    "lxYfHSkYm1EzQzGhdbfc": "Luna (Dossie product persona)",
}


def synthesize_with_timestamps(text, voice_id, stability, similarity, style, speed, model=None):
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    body = {
        "text": text,
        "model_id": model or MODEL_NARRATION,
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
    ap.add_argument("--model", default=None, choices=[MODEL_NARRATION, MODEL_CLONE],
                    help="Default: eleven_v3 for Heath's clone (his locked "
                         "config), eleven_multilingual_v2 for every other voice.")
    ap.add_argument("--stability", type=float, default=None)
    ap.add_argument("--style", type=float, default=None)
    ap.add_argument("--similarity", type=float, default=0.8)
    ap.add_argument(
        "--no-normalize", action="store_true",
        help="Send the script to the TTS API verbatim, skipping spoken-form "
             "normalization (debugging only -- abbreviations will be spelled out).")
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

    # TTS-INPUT-ONLY normalization. `text` stays the written form and is what
    # captions/post copy must use; `spoken` is the only thing the API sees.
    # Without this, ElevenLabs reads "789 Ranch Rd." as "seven eighty nine
    # Ranch R D" -- the defect Heath flagged on the Dossie D1 video 2026-09-16.
    if args.no_normalize:
        norm = tts_normalize.NormalizedText(text, text, [(text, text)], [])
    else:
        norm = tts_normalize.normalize_for_speech(text)
    spoken = norm.spoken

    print(f"[voiceover] script: {len(text)} chars, voice={args.voice_id}")
    if norm.fired:
        print(f"[normalize] {len(norm.fired)} TTS-input substitution(s) "
              f"(on-screen text and captions unaffected):")
        for rule, was, now in norm.fired:
            print(f"             [{rule}] {was!r} -> {now!r}")

    speed = 1.0
    similarity = args.similarity
    is_clone = bool(clone_voice_id()) and args.voice_id == clone_voice_id()
    if is_clone:
        model = args.model or MODEL_CLONE
        stability = CLONE_LOCKED_STABILITY if args.stability is None else args.stability
        style = CLONE_LOCKED_STYLE if args.style is None else args.style
        print(f"[voice] Heath's clone -> locked config: model={model} "
              f"stability={stability} style={style}")
    else:
        model = args.model or MODEL_NARRATION
        stability = 0.5 if args.stability is None else args.stability
        style = 0.15 if args.style is None else args.style
        print(f"[voice] model={model} stability={stability} style={style}")

    out_mp3 = Path(args.out_mp3)
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_timing = Path(args.out_timing)
    out_timing.parent.mkdir(parents=True, exist_ok=True)

    result = None
    for attempt in range(1, 6):
        print(f"[try {attempt}] speed={speed:.2f}")
        result = synthesize_with_timestamps(spoken, args.voice_id, stability, similarity, style, speed, model=model)
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
        # "text" is the SPOKEN form, because char_start/char_end index into
        # it. "display_text" + "segments" let the compositor render written
        # captions ("Rd") on these spoken timings -- see
        # scripts/build-shortform-video.py phrase_cues().
        "text": spoken,
        "display_text": text,
        "segments": [list(seg) for seg in norm.segments],
        "characters": alignment["characters"],
        "char_start": alignment["character_start_times_seconds"],
        "char_end": alignment["character_end_times_seconds"],
        "voice_id": args.voice_id,
        # Recorded so a render can be audited after the fact. The Dossie D1
        # timing JSON (2026-09-16) had no model_id, so "which model produced
        # this?" was unanswerable when Heath flagged the voiceover.
        "model_id": model,
        "voice_settings": {
            "stability": stability, "similarity_boost": similarity,
            "style": style, "speed": speed,
        },
        "normalized": not args.no_normalize,
    }
    out_timing.write_text(json.dumps(timing), encoding="utf-8")
    print(f"[voiceover] SAVED mp3={out_mp3} timing={out_timing} duration={timing['duration']:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
