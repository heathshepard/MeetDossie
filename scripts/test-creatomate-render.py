#!/usr/bin/env python3
"""Test Creatomate video rendering with template 791117d0-665c-4cd0-ba5f-a767f8921f9b"""
import os
import sys
import json
import urllib.request
from pathlib import Path

CREATOMATE_API_KEY = os.environ.get("CREATOMATE_API_KEY", "")
CREATOMATE_TEMPLATE_ID = "791117d0-665c-4cd0-ba5f-a767f8921f9b"

def main():
    if not CREATOMATE_API_KEY:
        print("ERROR: CREATOMATE_API_KEY not set")
        sys.exit(1)

    print(f"API key loaded: {CREATOMATE_API_KEY[:10]}...")
    print(f"Template ID: {CREATOMATE_TEMPLATE_ID}")

    # Test render with Victor persona and pipeline view
    screen_recording_url = "https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/screen-recordings/friday-full-pipeline-view-2026-05-08.mp4"

    modifications = {
        "Image-K8V": screen_recording_url,
        "Persona-Name": "Victor",
        "Caption": "This is what an active week looks like with Dossie. Six files. Three under option, two clear to close, one waiting on appraisal.",
        "Voiceover": "This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every TREC paragraph already cited."
    }

    payload = {
        "template_id": CREATOMATE_TEMPLATE_ID,
        "modifications": modifications
    }

    print(f"\nCalling Creatomate API...")
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
            print(f"\n✅ Render created successfully!")
            print(f"Render ID: {response.get('id')}")
            print(f"Status: {response.get('status')}")
            print(f"\nFull response:")
            print(json.dumps(response, indent=2))

            # Check for rendered URL
            if response.get('url'):
                print(f"\n🎥 Rendered video URL: {response.get('url')}")
            else:
                print(f"\n⏳ Video rendering in progress. Check status at: https://creatomate.com/renders/{response.get('id')}")

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
