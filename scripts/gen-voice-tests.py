"""Generate 10-second voice-test clips for candidate male preset voices.

API key on this account only has text_to_speech scope (not voices_read), so
we use the well-known ElevenLabs preset voice IDs directly.

Picked for natural, conversational, non-commercial founder feel:
  - Brian   — warm, articulate, natural
  - Bill    — calm, friendly
  - Adam    — clear, less dramatic than Antoni
  - Eric    — smooth, conversational
  - Daniel  — articulate, calm
"""
import os
import json
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

API_KEY = os.environ.get("ELEVENLABS_API_KEY") or "sk_18df32e2fd136d24c8d76dfac76457259704ae30ac271b15"
MODEL = "eleven_turbo_v2"
OUT_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")

CANDIDATES = [
    ("brian",  "nPczCjzI2devNBz1zQrb"),
    ("bill",   "pqHfZKP75CvOlQylNhV4"),
    ("adam",   "pNInz6obpgDQGcFmaJgB"),
    ("eric",   "cjVigY5qzO86Huf0OWal"),
    ("daniel", "onwK4e9ZLuTAKqWW03F9"),
]

TEST_LINE = (
    "I'm a Texas REALTOR. And I built this because I was tired of paying "
    "four hundred dollars a transaction to a coordinator and still doing "
    "half the work myself."
)


def synth(voice_id: str, out_path: Path) -> None:
    body = {
        "text": TEST_LINE,
        "model_id": MODEL,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.85,
            "style": 0.30,
            "use_speaker_boost": True,
            "speed": 1.0,
        },
    }
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "xi-api-key": API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out_path.write_bytes(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}")
        raise


def duration(path: Path) -> float:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{'voice':<10} {'voice_id':<24} {'duration':>10}  file")
    print("-" * 80)
    for name, vid in CANDIDATES:
        out = OUT_DIR / f"voice-test-{name}.mp3"
        synth(vid, out)
        d = duration(out)
        print(f"{name:<10} {vid:<24} {d:>9.2f}s  {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
