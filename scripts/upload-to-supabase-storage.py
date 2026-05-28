#!/usr/bin/env python3
"""Upload screen recording to Supabase Storage and return public URL"""
import os
import sys
import json
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pgwoitbdiyubjugwufhk.supabase.co")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
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

def create_bucket(bucket_name):
    """Create a bucket if it doesn't exist"""
    url = f"{SUPABASE_URL}/storage/v1/bucket"
    payload = {
        "name": bucket_name,
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
            print(f"OK Bucket '{bucket_name}' already exists")
            return True
        else:
            body = e.read().decode("utf-8", "replace") if e.fp else ""
            print(f"ERROR creating bucket: {e.code} {body}")
            return False

CHUNK_SIZE = 6 * 1024 * 1024  # 6MB chunks for TUS resumable upload


def upload_file_resumable(file_path: Path, bucket_name, auth_key):
    """Upload large file via Supabase TUS resumable upload protocol"""
    file_name = file_path.name
    file_size = file_path.stat().st_size
    print(f"Using resumable upload for {file_name} ({file_size:,} bytes)...")

    tus_url = f"{SUPABASE_URL}/storage/v1/upload/resumable"

    # Step 1: Create upload session
    create_req = urllib.request.Request(
        tus_url,
        data=b"",
        headers={
            "Authorization": f"Bearer {auth_key}",
            "Content-Length": "0",
            "Upload-Length": str(file_size),
            "Tus-Resumable": "1.0.0",
            "Upload-Metadata": f"bucketName {_b64(bucket_name)},objectName {_b64(file_name)},contentType {_b64('video/mp4')}",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(create_req, timeout=30) as r:
            location = r.headers.get("Location")
            if not location:
                print("ERROR: No Location header in TUS create response")
                sys.exit(1)
            print(f"OK TUS session created: ...{location[-40:]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR creating TUS session: {e.code} {body}")
        sys.exit(1)

    # Step 2: Upload chunks
    offset = 0
    with open(file_path, "rb") as f:
        while offset < file_size:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            chunk_req = urllib.request.Request(
                location,
                data=chunk,
                headers={
                    "Authorization": f"Bearer {auth_key}",
                    "Content-Length": str(len(chunk)),
                    "Content-Type": "application/offset+octet-stream",
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": str(offset),
                },
                method="PATCH"
            )
            try:
                with urllib.request.urlopen(chunk_req, timeout=120) as r:
                    new_offset = int(r.headers.get("Upload-Offset", offset + len(chunk)))
                    pct = int(new_offset * 100 / file_size)
                    print(f"  Uploaded {new_offset:,}/{file_size:,} bytes ({pct}%)")
                    offset = new_offset
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace") if e.fp else ""
                print(f"ERROR uploading chunk at offset {offset}: {e.code} {body}")
                sys.exit(1)

    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket_name}/{file_name}"
    print(f"OK Resumable upload complete")
    print(f" Public URL: {public_url}")
    return public_url


def _b64(s):
    import base64
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def upload_file(file_path: Path, bucket_name, access_token=None):
    """Upload file to Supabase Storage and return public URL"""
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}")
        sys.exit(1)

    file_name = file_path.name
    file_size = file_path.stat().st_size
    print(f"Uploading {file_name} ({file_size:,} bytes)...")

    # Priority: SERVICE_ROLE_KEY > access_token > ANON_KEY
    if SUPABASE_SERVICE_ROLE_KEY:
        auth_key = SUPABASE_SERVICE_ROLE_KEY
    elif access_token:
        auth_key = access_token
    else:
        auth_key = SUPABASE_ANON_KEY

    # Files over 50MB must use the TUS resumable upload endpoint
    STANDARD_UPLOAD_LIMIT = 50 * 1024 * 1024  # 50MB
    if file_size > STANDARD_UPLOAD_LIMIT:
        return upload_file_resumable(file_path, bucket_name, auth_key)

    url = f"{SUPABASE_URL}/storage/v1/object/{bucket_name}/{file_name}"
    file_bytes = file_path.read_bytes()

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
            public_url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket_name}/{file_name}"
            print(f" Public URL: {public_url}")
            return public_url

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        # Supabase returns HTTP 400 with statusCode "409" when file already exists
        is_duplicate = e.code == 409 or ('"409"' in body and "Duplicate" in body)
        if is_duplicate:
            print(f"OK File already exists in storage (duplicate) -- using existing URL")
            public_url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket_name}/{file_name}"
            print(f" Public URL: {public_url}")
            return public_url
        print(f"ERROR uploading: {e.code} {body}")
        sys.exit(1)

def main():
    if not SUPABASE_URL:
        print("ERROR: SUPABASE_URL must be set")
        sys.exit(1)

    if len(sys.argv) < 3:
        print("Usage: python upload-to-supabase-storage.py <bucket-name> <file-path>")
        sys.exit(1)

    bucket_name = sys.argv[1]
    file_path = Path(sys.argv[2])

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
        print(f"Creating/checking bucket '{bucket_name}'...")
        if not create_bucket(bucket_name):
            print("Note: Bucket creation failed, assuming it already exists")
    else:
        print(f"Note: Bucket '{bucket_name}' assumed to exist")

    # Upload file
    public_url = upload_file(file_path, bucket_name, access_token)

    # Return URL
    print(f"\nOK Done! Public URL:")
    print(public_url)

if __name__ == "__main__":
    main()
