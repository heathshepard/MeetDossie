#!/usr/bin/env python3
"""Upload a video to Zernio and create an Instagram post."""
import os
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path

ZERNIO_BASE = "https://zernio.com/api/v1"
SUPABASE_URL = "https://pgwoitbdiyubjugwufhk.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE"

def main():
    api_key = os.environ.get("ZERNIO_API_KEY", "")
    if not api_key:
        print("ERROR: ZERNIO_API_KEY not set")
        sys.exit(1)

    print(f"API key loaded: {api_key[:10]}...")

    # Get Instagram account ID (hardcoded from zernio_accounts table)
    # RLS policy may be blocking anon access, so we use the known account ID
    account_id = "69f25431985e734bf3d8fcbe"
    print(f"Instagram account ID: {account_id}")

    # Upload video
    video_path = Path("Media/finished-videos/pipeline_view-2026-05-08-vertical-simple.mp4")
    if not video_path.exists():
        print(f"ERROR: Video file not found: {video_path}")
        sys.exit(1)

    file_size = video_path.stat().st_size
    print(f"Uploading {video_path.name} ({file_size:,} bytes)...")

    # Step 1: Get presigned URL
    presign_body = json.dumps({
        "filename": video_path.name,
        "contentType": "video/mp4",
    }).encode("utf-8")

    presign_req = urllib.request.Request(
        f"{ZERNIO_BASE}/media/presign",
        data=presign_body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(presign_req, timeout=60) as r:
            presign_resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR presigning: {e.code} {body}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR presigning: {e}")
        sys.exit(1)

    upload_url = presign_resp.get("uploadUrl")
    public_url = presign_resp.get("publicUrl")

    if not upload_url or not public_url:
        print(f"ERROR: No uploadUrl/publicUrl in response: {presign_resp}")
        sys.exit(1)

    print(f"Presigned URL obtained, uploading to GCS...")

    # Step 2: Upload file bytes
    file_bytes = video_path.read_bytes()
    put_req = urllib.request.Request(
        upload_url,
        data=file_bytes,
        headers={"Content-Type": "video/mp4"},
        method="PUT",
    )

    try:
        with urllib.request.urlopen(put_req, timeout=300) as r:
            put_status = r.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR uploading: {e.code} {body}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR uploading: {e}")
        sys.exit(1)

    print(f"Upload complete (status {put_status})")
    print(f"Public URL: {public_url}")

    # Step 3: Create Instagram post
    content = """This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every TREC paragraph already cited on the deadline page. I have not opened a folder of PDFs in two weeks. The pipeline view is the file. The file is the work. The work is the deal. Texas agents — meetdossie.com/founding

#RealEstate #TexasRealEstate #RealtorLife #TransactionCoordination #REtech #RealEstateAgent #PropertyManagement #TREC #DossieAI #RealEstateTools"""

    payload = {
        "content": content,
        "platforms": [{"platform": "instagram", "accountId": account_id}],
        "mediaItems": [{"url": public_url, "type": "video"}],
        "publishNow": True,
    }

    post_req = urllib.request.Request(
        f"{ZERNIO_BASE}/posts",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    print("Creating Instagram post...")
    try:
        with urllib.request.urlopen(post_req, timeout=60) as r:
            post_resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        print(f"ERROR creating post: {e.code} {body}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR creating post: {e}")
        sys.exit(1)

    print("✅ Post created successfully!")
    print(f"Post ID: {post_resp.get('id')}")
    print(f"Status: {post_resp.get('status')}")
    print(f"\nFull response:")
    print(json.dumps(post_resp, indent=2))

if __name__ == "__main__":
    main()
