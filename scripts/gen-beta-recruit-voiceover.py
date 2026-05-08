"""Generate Antoni voiceover for the 54-second beta-recruit marketing video.

Uses ElevenLabs eleven_turbo_v2. Iterates on speaking_rate (via the speed
voice setting in tts settings) until duration is within 3s of target.
"""
import os
import sys
import json
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

API_KEY = os.environ.get("ELEVENLABS_API_KEY") or "sk_18df32e2fd136d24c8d76dfac76457259704ae30ac271b15"
VOICE_ID = os.environ.get("VOICE_ID", "ErXwobaYiN019PkySvjV")  # default: Antoni
MODEL = "eleven_turbo_v2"
OUTPUT = Path(os.environ.get("OUTPUT_PATH", r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\beta-recruit-v1-voiceover.mp3"))
TARGET = 54.0
TOLERANCE = 3.0

# Pauses encoded as ellipsis + sentence breaks, since SSML <break> tags are not
# supported by eleven_turbo_v2. Periods + line breaks give natural beats.
SCRIPT = (
    "I'm a Texas REALTOR. And I built this because I was tired of paying "
    "four hundred dollars a transaction to a coordinator and still doing "
    "half the work myself.\n\n"
    "This is Dossie.\n\n"
    "Every morning she briefs you on every active deal. Which deadlines "
    "are today. What needs your attention. By name. By address.\n\n"
    "Every TREC deadline is calculated the moment you open a file. Option "
    "period. Financing. Closing. All of it — automatic.\n\n"
    "She queues your emails before you think of them. Lender intro. Title "
    "order. Buyer welcome. Drafted and ready.\n\n"
    "And when something needs you? She tells you exactly what it is and why.\n\n"
    "I'm looking for two or three Texas agents to test this for free. Tell "
    "me what breaks. Help me build what you actually need.\n\n"
    "Link in the comments. Two minutes to apply."
)


def synthesize(out_path: Path, stability: float, similarity: float, style: float, speed: float) -> None:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    body = {
        "text": SCRIPT,
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
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}\n")
        raise
    out_path.write_bytes(data)


def duration_seconds(path: Path) -> float:
    res = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(res.stdout.strip())


def main() -> int:
    # Start point: speed 1.0, stability low (more expressive). If too long we
    # raise speed; too short we lower it. Speed range in ElevenLabs is 0.7-1.2.
    speed = 1.0
    stability = 0.45
    similarity = 0.85
    style = 0.30

    for attempt in range(1, 6):
        print(f"[try {attempt}] speed={speed:.2f} stability={stability:.2f}")
        synthesize(OUTPUT, stability, similarity, style, speed)
        dur = duration_seconds(OUTPUT)
        delta = dur - TARGET
        print(f"  duration={dur:.2f}s  delta={delta:+.2f}s")
        if abs(delta) <= TOLERANCE:
            print(f"[done] within tolerance: {dur:.2f}s vs target {TARGET}s")
            return 0
        # Adjust speed: if too long, speed up proportionally; too short, slow down.
        ratio = dur / TARGET
        new_speed = max(0.7, min(1.2, speed * ratio))
        if abs(new_speed - speed) < 0.01:
            print(f"[stop] speed pinned at {speed:.2f}; cannot improve further.")
            return 1
        speed = new_speed

    print("[stop] exhausted attempts")
    return 1


if __name__ == "__main__":
    sys.exit(main())
