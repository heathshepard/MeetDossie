"""Generate Bill voiceover in two halves with different pacing settings,
then concat with ffmpeg.

ElevenLabs accepts <break time="X.Xs"/> tags inline in the text for explicit
pauses; passing the script through as-is.
"""
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
HALF2 = OUT_DIR / "bill-half2.mp3"
FINAL = OUT_DIR / "beta-recruit-v1-voiceover-bill-v3.mp3"

SCRIPT_HALF_1 = (
    'I\'m a Texas REALTOR. <break time="0.5s"/> And I built this because I was tired of '
    'paying four hundred dollars a transaction to a coordinator <break time="0.3s"/> '
    'and still doing half the work myself. <break time="0.7s"/>\n\n'
    'This is Dossie. <break time="0.8s"/>\n\n'
    'Every morning she briefs you on every active deal. <break time="0.3s"/> '
    'Which deadlines are today. <break time="0.3s"/> What needs your attention. '
    '<break time="0.3s"/> By name. By address. <break time="0.7s"/>\n\n'
    'Every TREC deadline is calculated the moment you open a file. <break time="0.3s"/> '
    'Option period. Financing. Closing. <break time="0.3s"/> All of it — automatic.'
)

SCRIPT_HALF_2 = (
    '<break time="0.7s"/> She queues your emails before you think of them. '
    '<break time="0.3s"/> Lender intro. <break time="0.3s"/> Title order. '
    '<break time="0.3s"/> Buyer welcome. <break time="0.3s"/> Drafted and ready. '
    '<break time="0.7s"/>\n\n'
    'And when something needs you? <break time="0.4s"/> She tells you exactly what '
    'it is and why. <break time="0.7s"/>\n\n'
    'I\'m looking for two or three Texas agents to test this for free. '
    '<break time="0.4s"/> Tell me what breaks. <break time="0.3s"/> Help me build '
    'what you actually need. <break time="0.7s"/>\n\n'
    'Link in the comments. <break time="0.3s"/> Two minutes to apply.'
)


def synth(text: str, settings: dict, out_path: Path) -> None:
    body = {
        "text": text,
        "model_id": MODEL,
        "voice_settings": settings,
    }
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
    half1_settings = {
        "stability": 0.65,
        "similarity_boost": 0.75,
        "style": 0.4,
        "use_speaker_boost": True,
        "speed": 1.1,
    }
    half2_settings = {
        "stability": 0.75,
        "similarity_boost": 0.75,
        "style": 0.2,
        "use_speaker_boost": True,
        "speed": 0.95,
    }

    print("[half1] generating ...")
    synth(SCRIPT_HALF_1, half1_settings, HALF1)
    d1 = duration(HALF1)
    print(f"[half1] duration={d1:.2f}s")

    print("[half2] generating ...")
    synth(SCRIPT_HALF_2, half2_settings, HALF2)
    d2 = duration(HALF2)
    print(f"[half2] duration={d2:.2f}s")

    print("[concat] running ffmpeg ...")
    res = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(HALF1),
            "-i", str(HALF2),
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
