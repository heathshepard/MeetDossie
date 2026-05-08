#!/usr/bin/env python3
"""
Creatomate-based lifestyle video generator for Dossie.

Replaces the old ffmpeg pipeline with Creatomate template rendering:
1. Takes voiceover script text + screen recording path + persona name
2. Uploads screen recording to Supabase Storage (if not already uploaded)
3. Calls Creatomate API with template 791117d0-665c-4cd0-ba5f-a767f8921f9b
4. Polls for render completion
5. Returns video URL for approval flow

Usage:
  python generate-creatomate-video.py \
    --voiceover-script "This is what an active week..." \
    --screen-recording friday-full-pipeline-view-2026-05-08.mp4 \
    --persona-name "Victor" \
    --caption "This is what an active week looks like with Dossie."

Env requirements:
  CREATOMATE_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY (or demo user auth)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

# Constants
CREATOMATE_API_KEY = os.environ.get("CREATOMATE_API_KEY", "")
CREATOMATE_TEMPLATE_ID = "791117d0-665c-4cd0-ba5f-a767f8921f9b"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pgwoitbdiyubjugwufhk.supabase.co")
MEDIA_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
SCREEN_RECORDINGS_DIR = MEDIA_DIR / "screen-recordings"

def upload_screen_recording(file_path: Path) -> str:
    """Upload screen recording to Supabase Storage and return public URL"""
    print(f"Uploading {file_path.name} to Supabase Storage...")

    # Call the upload script
    import subprocess
    result = subprocess.run(
        ["python", "scripts/upload-to-supabase-storage.py", "screen-recordings", str(file_path)],
        capture_output=True,
        text=True,
        cwd=r"C:\Users\Heath Shepard\Desktop\MeetDossie"
    )

    if result.returncode != 0:
        print(f"ERROR uploading: {result.stderr}")
        sys.exit(1)

    # Extract public URL from output
    for line in result.stdout.split("\n"):
        if "Public URL:" in line:
            url = line.split("Public URL:")[-1].strip()
            print(f"OK Uploaded: {url}")
            return url

    print("ERROR: Could not extract public URL from upload output")
    sys.exit(1)

def create_creatomate_render(screen_recording_url: str, voiceover_text: str, persona_name: str, caption: str) -> str:
    """Create Creatomate render and return render ID"""
    print(f"Creating Creatomate render...")

    modifications = {
        "Image-K8V": screen_recording_url,
        "Persona-Name": persona_name,
        "Caption": caption,
        "Voiceover": voiceover_text
    }

    payload = {
        "template_id": CREATOMATE_TEMPLATE_ID,
        "modifications": modifications
    }

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
            render_id = response.get("id")
            print(f"OK Render created: {render_id}")
            return render_id
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR: {e.code} {body}")
        sys.exit(1)

def poll_render_status(render_id: str, max_wait_seconds: int = 300) -> dict:
    """Poll Creatomate render status until succeeded or failed"""
    print(f"Polling render {render_id}...")

    start_time = time.time()
    while time.time() - start_time < max_wait_seconds:
        req = urllib.request.Request(
            f"https://api.creatomate.com/v2/renders/{render_id}",
            headers={"Authorization": f"Bearer {CREATOMATE_API_KEY}"},
            method="GET"
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                render = json.loads(r.read().decode("utf-8"))
                status = render.get("status")

                if status == "succeeded":
                    print(f"OK Render succeeded: {render.get('url')}")
                    return render
                elif status == "failed":
                    print(f"ERROR: Render failed")
                    return render
                else:
                    print(f"  Status: {status}...")
                    time.sleep(5)
        except Exception as e:
            print(f"ERROR polling: {e}")
            time.sleep(5)

    print(f"ERROR: Render timed out after {max_wait_seconds}s")
    sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Generate Dossie marketing video via Creatomate")
    parser.add_argument("--voiceover-script", required=True, help="Voiceover text")
    parser.add_argument("--screen-recording", required=True, help="Screen recording filename")
    parser.add_argument("--persona-name", required=True, help="Persona name (Victor, Brenda, Patricia)")
    parser.add_argument("--caption", required=True, help="Caption text")

    args = parser.parse_args()

    if not CREATOMATE_API_KEY:
        print("ERROR: CREATOMATE_API_KEY not set")
        sys.exit(1)

    # Resolve screen recording path
    screen_recording_path = SCREEN_RECORDINGS_DIR / args.screen_recording
    if not screen_recording_path.exists():
        print(f"ERROR: Screen recording not found: {screen_recording_path}")
        sys.exit(1)

    print("=== Creatomate Video Pipeline ===\n")

    # Step 1: Upload screen recording
    screen_recording_url = upload_screen_recording(screen_recording_path)

    # Step 2: Create Creatomate render
    render_id = create_creatomate_render(
        screen_recording_url,
        args.voiceover_script,
        args.persona_name,
        args.caption
    )

    # Step 3: Poll for completion
    render = poll_render_status(render_id)

    # Step 4: Output result
    if render.get("status") == "succeeded":
        print(f"\n=== SUCCESS ===")
        print(f"Video URL: {render.get('url')}")
        print(f"Duration: {render.get('duration')}s")
        print(f"File size: {render.get('file_size'):,} bytes")

        # Output JSON for DONE handler to parse
        print("\nJSON_OUTPUT:")
        print(json.dumps({
            "ok": True,
            "render_id": render_id,
            "video_url": render.get("url"),
            "duration": render.get("duration"),
            "file_size": render.get("file_size")
        }))
    else:
        print(f"\n=== FAILED ===")
        sys.exit(1)

if __name__ == "__main__":
    main()
