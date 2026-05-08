#!/usr/bin/env python3
"""
Complete Creatomate test flow with pre-generated ElevenLabs audio:
1. Generate Bill voiceover via ElevenLabs
2. Upload audio to Supabase Storage (voiceovers bucket)
3. Call Creatomate API with audio URL
4. Return render ID and status
"""
import os
import sys
import json
import subprocess
from pathlib import Path
import urllib.request

# Configuration
CREATOMATE_API_KEY = os.environ.get("CREATOMATE_API_KEY", "")
CREATOMATE_TEMPLATE_ID = "791117d0-665c-4cd0-ba5f-a767f8921f9b"
SCREEN_RECORDING_URL = "https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/screen-recordings/friday-full-pipeline-view-2026-05-08.mp4"
VOICEOVER_TEXT = "This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every TREC paragraph already cited."

def main():
    if not CREATOMATE_API_KEY:
        print("ERROR: CREATOMATE_API_KEY not set")
        sys.exit(1)

    print("=== Creatomate Test Flow ===\n")

    # Step 1: Generate voiceover
    print("Step 1: Generating ElevenLabs voiceover...")
    audio_file = Path("Media/voiceovers/test-victor-pipeline-view.mp3")
    audio_file.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        ["python", "scripts/generate-voiceover.py", VOICEOVER_TEXT, str(audio_file)],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        print(f"ERROR generating voiceover: {result.stderr}")
        sys.exit(1)

    print(result.stdout)

    # Step 2: Upload to Supabase Storage
    print("\nStep 2: Uploading audio to Supabase Storage...")
    result = subprocess.run(
        ["python", "scripts/upload-to-supabase-storage.py", "voiceovers", str(audio_file)],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        print(f"ERROR uploading audio: {result.stderr}")
        sys.exit(1)

    print(result.stdout)

    # Extract public URL from output
    audio_url = None
    for line in result.stdout.split("\n"):
        if "Public URL:" in line:
            audio_url = line.split("Public URL:")[-1].strip()
            break

    if not audio_url:
        print("ERROR: Could not extract audio URL from upload output")
        sys.exit(1)

    print(f"\nAudio URL: {audio_url}")

    # Step 3: Call Creatomate API
    print("\nStep 3: Calling Creatomate API...")
    modifications = {
        "Image-K8V": SCREEN_RECORDING_URL,
        "Persona-Name": "Victor",
        "Caption": "This is what an active week looks like with Dossie. Six files. Three under option, two clear to close, one waiting on appraisal.",
        "Voiceover": audio_url  # Audio URL instead of text
    }

    payload = {
        "template_id": CREATOMATE_TEMPLATE_ID,
        "modifications": modifications
    }

    print(f"Modifications: {json.dumps(modifications, indent=2)}")

    req = urllib.request.Request(
        "https://api.creatomate.com/v2/renders",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {CREATOMATE_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            response = json.loads(r.read().decode("utf-8"))
            print(f"\nOK Render created!")
            print(f"Render ID: {response.get('id')}")
            print(f"Status: {response.get('status')}")
            print(f"URL: {response.get('url')}")
            print(f"\nFull response:")
            print(json.dumps(response, indent=2))

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR: {e.code}")
        print(f"Response: {body}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
