"""Regenerate Bill half 2 with revised ending, then stitch with existing half 1."""
import os
import json
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

API_KEY = os.environ["ELEVENLABS_API_KEY"]
BILL = "pqHfZKP75CvOlQylNhV4"
MODEL = "eleven_turbo_v2"
OUT_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
HALF1 = OUT_DIR / "bill-half1.mp3"
HALF2_V2 = OUT_DIR / "bill-half2-v2.mp3"
FINAL = OUT_DIR / "beta-recruit-v1-voiceover-bill-v4.mp3"

SCRIPT_HALF_2_V2 = (
    '<break time="0.7s"/> She queues your emails before you think of them. '
    '<break time="0.3s"/> Lender intro. <break time="0.3s"/> Title order. '
    '<break time="0.3s"/> Buyer welcome. <break time="0.3s"/> Drafted and ready. '
    '<break time="0.7s"/>\n\n'
    'And when something needs you? <break time="0.4s"/> She tells you exactly what '
    'it is and why. <break time="0.7s"/>\n\n'
    'I\'m looking for two or three Texas agents to get in early. '
    '<break time="0.4s"/> Fifty founding spots. <break time="0.3s"/> You help shape '
    'what Dossie becomes. <break time="0.7s"/>\n\n'
    'Link in the comments. <break time="0.3s"/> Two minutes to apply.'
)

SETTINGS = {
    "stability": 0.75,
    "similarity_boost": 0.75,
    "style": 0.2,
    "use_speaker_boost": True,
    "speed": 0.95,
}


def synth(text: str, out_path: Path) -> None:
    body = {"text": text, "model_id": MODEL, "voice_settings": SETTINGS}
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{BILL}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "xi-api-key": API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            out_path.write_bytes(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}")
        raise


def duration(path: Path) -> float:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def main() -> int:
    print("[half2-v2] generating ...")
    synth(SCRIPT_HALF_2_V2, HALF2_V2)
    d2 = duration(HALF2_V2)
    print(f"[half2-v2] duration={d2:.2f}s")

    d1 = duration(HALF1)
    print(f"[half1] existing duration={d1:.2f}s")

    print("[concat] running ffmpeg ...")
    res = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(HALF1),
            "-i", str(HALF2_V2),
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
            str(FINAL),
        ],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print("ffmpeg failed:")
        print(res.stderr)
        return 1
    total = duration(FINAL)
    print(f"[final] duration={total:.2f}s  delta={total - 54.0:+.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
