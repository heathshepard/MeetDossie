#!/usr/bin/env python3
"""Upload screen recording to Supabase Storage and return public URL"""
import os
import sys
import json
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pgwoitbdiyubjugwufhk.supabase.co")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE"
BUCKET_NAME = "screen-recordings"
DEMO_EMAIL = "demo@meetdossie.com"
DEMO_PASSWORD = "DossieDemo-VaIiAt6Bab"

def authenticate():
    """Authenticate as demo user and return access token"""
    url = f"{SUPABASE_URL}/auth/v1/token?grant_type=password"
    payload = {
        "email": DEMO_EMAIL,
        "password": DEMO_PASSWORD
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            response = json.loads(r.read().decode("utf-8"))
            access_token = response.get("access_token")
            if access_token:
                print(f"OK Authenticated as {DEMO_EMAIL}")
                return access_token
            else:
                print(f"ERROR: No access_token in response")
                return None
    except Exception as e:
        print(f"ERROR authenticating: {e}")
        return None

def create_bucket():
    """Create the screen-recordings bucket if it doesn't exist"""
    url = f"{SUPABASE_URL}/storage/v1/bucket"
    payload = {
        "name": BUCKET_NAME,
        "public": True,
        "file_size_limit": 104857600,  # 100MB
        "allowed_mime_types": ["video/mp4", "video/quicktime"]
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            response = json.loads(r.read().decode("utf-8"))
            print(f"OK Bucket created: {response.get('name')}")
            return True
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print(f"OK Bucket '{BUCKET_NAME}' already exists")
            return True
        else:
            body = e.read().decode("utf-8", "replace") if e.fp else ""
            print(f"ERROR creating bucket: {e.code} {body}")
            return False

def upload_file(file_path: Path, access_token=None):
    """Upload file to Supabase Storage and return public URL"""
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}")
        sys.exit(1)

    file_name = file_path.name
    file_size = file_path.stat().st_size
    print(f"Uploading {file_name} ({file_size:,} bytes)...")

    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{file_name}"
    file_bytes = file_path.read_bytes()

    # Priority: SERVICE_ROLE_KEY > access_token > ANON_KEY
    if SUPABASE_SERVICE_ROLE_KEY:
        auth_key = SUPABASE_SERVICE_ROLE_KEY
    elif access_token:
        auth_key = access_token
    else:
        auth_key = SUPABASE_ANON_KEY

    req = urllib.request.Request(
        url,
        data=file_bytes,
        headers={
            "Authorization": f"Bearer {auth_key}",
            "Content-Type": "video/mp4",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            response = json.loads(r.read().decode("utf-8"))
            print(f"OK Upload complete")

            # Construct public URL
            public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{file_name}"
            print(f" Public URL: {public_url}")
            return public_url

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR uploading: {e.code} {body}")
        sys.exit(1)

def main():
    if not SUPABASE_URL:
        print("ERROR: SUPABASE_URL must be set")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("Usage: python upload-to-supabase-storage.py <file-path>")
        sys.exit(1)

    file_path = Path(sys.argv[1])

    # Authenticate to get access token
    access_token = None
    if not SUPABASE_SERVICE_ROLE_KEY:
        print(f"Authenticating as {DEMO_EMAIL}...")
        access_token = authenticate()
        if not access_token:
            print("ERROR: Authentication failed")
            sys.exit(1)

    # Create bucket (only if SERVICE_ROLE_KEY is available)
    if SUPABASE_SERVICE_ROLE_KEY:
        print(f"Creating/checking bucket '{BUCKET_NAME}'...")
        if not create_bucket():
            print("Note: Bucket creation failed, assuming it already exists")
    else:
        print(f"Note: Bucket '{BUCKET_NAME}' assumed to exist")

    # Upload file
    public_url = upload_file(file_path, access_token)

    # Return URL
    print(f"\nOK Done! Public URL:")
    print(public_url)

if __name__ == "__main__":
    main()
