#!/usr/bin/env python3
"""
Creatomate-based lifestyle video generator for Dossie.

Pipeline (updated):
1. Takes voiceover script text + screen recording path + persona name
2. Extracts a static frame from the screen recording (Creatomate Image-K8V is an image element)
3. Pre-generates ElevenLabs TTS audio and uploads to Supabase voiceovers bucket
4. Uploads frame image to Supabase social-cards bucket
5. Calls Creatomate API with static image + static audio (bypasses Creatomate-stored ElevenLabs key)
6. Polls for render completion
7. Returns video URL for approval flow

WHY static assets instead of ElevenLabs provider integration:
- Creatomate template stores its own ElevenLabs API key internally
- That key periodically expires; provider_settings override doesn't reliably work
- Pre-generating audio and passing it as a static URL is more robust and faster
- Creatomate Image-K8V element is type=image, not type=video -- video files are rejected

Usage:
  python generate-creatomate-video.py \\
    --voiceover-script "This is what an active week..." \\
    --screen-recording friday-full-pipeline-view-2026-05-08.mp4 \\
    --persona-name "Victor" \\
    --caption "This is what an active week looks like with Dossie."

Env requirements:
  CREATOMATE_API_KEY
  ELEVENLABS_API_KEY
  SUPABASE_URL (defaults to pgwoitbdiyubjugwufhk)
  SUPABASE_ANON_KEY
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# Constants
CREATOMATE_API_KEY = os.environ.get("CREATOMATE_API_KEY", "")
CREATOMATE_TEMPLATE_ID = "791117d0-665c-4cd0-ba5f-a767f8921f9b"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pgwoitbdiyubjugwufhk.supabase.co")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# Bill voice (Victor/Brenda/Patricia male-default), Luna for female -- Bill is template default
ELEVENLABS_VOICE_MAP = {
    "victor": "pqHfZKP75CvOlQylNhV4",   # Bill
    "brenda": "pqHfZKP75CvOlQylNhV4",   # Bill (Brenda content uses Bill per CLAUDE.md)
    "patricia": "lxYfHSkYm1EzQzGhdbfc", # Luna
}
ELEVENLABS_VOICE_DEFAULT = "pqHfZKP75CvOlQylNhV4"  # Bill
MEDIA_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
SCREEN_RECORDINGS_DIR = MEDIA_DIR / "screen-recordings"
DEMO_EMAIL = "demo@meetdossie.com"
DEMO_PASSWORD = "DossieDemo-VaIiAt6Bab"


def supabase_auth_token() -> str:
    """Authenticate as demo user and return access token"""
    url = f"{SUPABASE_URL}/auth/v1/token?grant_type=password"
    payload = {"email": DEMO_EMAIL, "password": DEMO_PASSWORD}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
        token = data.get("access_token", "")
        if not token:
            print("ERROR: Supabase auth failed -- no access_token")
            sys.exit(1)
        return token


def supabase_upload(bucket: str, filename: str, data_bytes: bytes, content_type: str, auth_token: str) -> str:
    """Upload bytes to a Supabase Storage bucket. Returns public URL. Handles 409 (already exists)."""
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{filename}"
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={"Authorization": f"Bearer {auth_token}", "Content-Type": content_type},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        is_duplicate = e.code == 409 or ('"409"' in body and "Duplicate" in body)
        if not is_duplicate:
            print(f"ERROR uploading to {bucket}/{filename}: {e.code} {body}")
            sys.exit(1)
        print(f"  Already exists in {bucket}/{filename}")
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{filename}"
    return public_url


def extract_frame(screen_recording_path: Path, offset_seconds: int = 30) -> bytes:
    """Extract a single JPEG frame from the screen recording at offset_seconds."""
    print(f"Extracting frame at {offset_seconds}s from {screen_recording_path.name}...")
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp_path = tmp.name

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(offset_seconds),
            "-i", str(screen_recording_path),
            "-vframes", "1",
            "-q:v", "2",
            tmp_path
        ],
        capture_output=True
    )
    if result.returncode != 0 or not Path(tmp_path).exists():
        print(f"ERROR: ffmpeg frame extraction failed: {result.stderr.decode('utf-8','replace')[-300:]}")
        sys.exit(1)

    frame_bytes = Path(tmp_path).read_bytes()
    Path(tmp_path).unlink(missing_ok=True)
    print(f"  OK Frame: {len(frame_bytes):,} bytes")
    return frame_bytes


def generate_elevenlabs_audio(voiceover_text: str, voice_id: str) -> bytes:
    """Generate TTS audio from ElevenLabs. Returns MP3 bytes."""
    print(f"Generating ElevenLabs audio (voice {voice_id[:8]}...)...")
    payload = {
        "text": voiceover_text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
    }
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "User-Agent": "DossieApp/1.0"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            audio_bytes = r.read()
            print(f"  OK Audio: {len(audio_bytes):,} bytes")
            return audio_bytes
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR: ElevenLabs TTS failed: {e.code} {body}")
        sys.exit(1)


def create_creatomate_render(image_url: str, audio_url: str, persona_name: str, caption: str) -> str:
    """Create Creatomate render with static image + audio. Returns render ID."""
    print(f"Creating Creatomate render...")

    modifications = {
        "Image-K8V": image_url,
        "Persona-Name": persona_name,
        "Caption": caption,
        # Override Voiceover element: use static audio URL, clear ElevenLabs provider
        "Voiceover.source": audio_url,
        "Voiceover.provider": "",
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
            "User-Agent": "DossieApp/1.0 python-urllib",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            response = json.loads(r.read().decode("utf-8"))
            render_id = response.get("id")
            print(f"  OK Render created: {render_id}")
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
            headers={
                "Authorization": f"Bearer {CREATOMATE_API_KEY}",
                "User-Agent": "DossieApp/1.0 python-urllib",
            },
            method="GET"
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                render = json.loads(r.read().decode("utf-8"))
                status = render.get("status")

                if status == "succeeded":
                    print(f"  OK Render succeeded: {render.get('url')}")
                    return render
                elif status == "failed":
                    print(f"  ERROR: Render failed: {render.get('error_message','')}")
                    return render
                else:
                    print(f"  Status: {status}...")
                    time.sleep(5)
        except Exception as e:
            print(f"  ERROR polling: {e}")
            time.sleep(5)

    print(f"ERROR: Render timed out after {max_wait_seconds}s")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Generate Dossie marketing video via Creatomate")
    parser.add_argument("--voiceover-script", required=True, help="Voiceover text")
    parser.add_argument("--screen-recording", required=True, help="Screen recording filename")
    parser.add_argument("--persona-name", required=True, help="Persona name (Victor, Brenda, Patricia)")
    parser.add_argument("--caption", required=True, help="Caption text for social media")
    parser.add_argument("--frame-offset", type=int, default=30, help="Seconds into recording to extract frame (default: 30)")

    args = parser.parse_args()

    if not CREATOMATE_API_KEY:
        print("ERROR: CREATOMATE_API_KEY not set")
        sys.exit(1)
    if not ELEVENLABS_API_KEY:
        print("ERROR: ELEVENLABS_API_KEY not set")
        sys.exit(1)

    # Resolve screen recording path
    screen_recording_path = SCREEN_RECORDINGS_DIR / args.screen_recording
    if not screen_recording_path.exists():
        print(f"ERROR: Screen recording not found: {screen_recording_path}")
        sys.exit(1)

    stem = Path(args.screen_recording).stem  # e.g. "amendment-demo-desktop-2026-05-27"
    persona_key = args.persona_name.lower()
    voice_id = ELEVENLABS_VOICE_MAP.get(persona_key, ELEVENLABS_VOICE_DEFAULT)

    print("=== Creatomate Video Pipeline ===\n")

    # Step 1: Authenticate to Supabase
    print("Authenticating to Supabase...")
    auth_token = supabase_auth_token()
    print(f"  OK Authenticated")

    # Step 2: Extract frame from screen recording
    frame_bytes = extract_frame(screen_recording_path, args.frame_offset)
    frame_filename = f"{stem}-frame.jpg"
    frame_url = supabase_upload("social-cards", frame_filename, frame_bytes, "image/jpeg", auth_token)
    print(f"  Frame URL: {frame_url}")

    # Step 3: Generate ElevenLabs voiceover
    audio_bytes = generate_elevenlabs_audio(args.voiceover_script, voice_id)
    audio_filename = f"{stem}-{persona_key}-voiceover.mp3"
    audio_url = supabase_upload("voiceovers", audio_filename, audio_bytes, "audio/mpeg", auth_token)
    print(f"  Audio URL: {audio_url}")

    # Step 4: Create Creatomate render
    render_id = create_creatomate_render(
        frame_url,
        audio_url,
        args.persona_name,
        args.caption
    )

    # Step 5: Poll for completion
    render = poll_render_status(render_id)

    # Step 6: Output result
    if render.get("status") == "succeeded":
        file_size = render.get("file_size") or 0
        print(f"\n=== SUCCESS ===")
        print(f"Video URL: {render.get('url')}")
        print(f"Duration: {render.get('duration')}s")
        print(f"File size: {file_size:,} bytes")

        # Output JSON for DONE handler to parse
        print("\nJSON_OUTPUT:")
        print(json.dumps({
            "ok": True,
            "render_id": render_id,
            "video_url": render.get("url"),
            "duration": render.get("duration"),
            "file_size": file_size,
            "frame_url": frame_url,
            "audio_url": audio_url,
        }))
    else:
        print(f"\n=== FAILED ===")
        sys.exit(1)


if __name__ == "__main__":
    main()
