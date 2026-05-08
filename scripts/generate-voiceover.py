#!/usr/bin/env python3
"""Generate voiceover using ElevenLabs API and save to file"""
import os
import sys
from pathlib import Path
import urllib.request

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
BILL_VOICE_ID = "pqHfZKP75CvOlQylNhV4"

def generate_voiceover(text: str, output_path: Path):
    """Generate voiceover audio using ElevenLabs Bill voice"""
    if not ELEVENLABS_API_KEY:
        print("ERROR: ELEVENLABS_API_KEY not set")
        sys.exit(1)

    print(f"Generating voiceover with Bill voice...")
    print(f"Text: {text[:100]}...")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{BILL_VOICE_ID}"
    payload = {
        "text": text,
        "model_id": "eleven_monolingual_v1",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75
        }
    }

    import json
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            audio_bytes = r.read()
            output_path.write_bytes(audio_bytes)
            print(f"OK Voiceover saved: {output_path} ({len(audio_bytes):,} bytes)")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR: {e.code} {body}")
        return False
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate-voiceover.py <text> <output-file>")
        sys.exit(1)

    text = sys.argv[1]
    output_path = Path(sys.argv[2])

    if generate_voiceover(text, output_path):
        print(f"\nOK Done! Audio file: {output_path}")
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
