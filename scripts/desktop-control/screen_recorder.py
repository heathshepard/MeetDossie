"""Cole desktop control - rotating screen recorder.

Wraps ffmpeg with gdigrab to capture the full Windows desktop to a rotating
mp4 file. Files roll every ROTATE_MINUTES; finished files are uploaded to the
private Supabase bucket `desktop-recordings` and the local copy is kept for
LOCAL_RETENTION_DAYS before deletion.

If ffmpeg is not on PATH, this module logs a warning and does nothing. The
desktop tool still works without recording - recording is a backup audit
artifact, not a primary control surface.
"""

from __future__ import annotations

import os
import time
import shutil
import logging
import threading
import subprocess
from pathlib import Path
from datetime import datetime, timedelta

import requests
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

RECORDINGS_DIR = _REPO_ROOT / "Media" / "desktop-recordings"
ROTATE_MINUTES = 60
LOCAL_RETENTION_DAYS = 7  # keep local copies a week; bucket holds 30 days
BUCKET = "desktop-recordings"

log = logging.getLogger("cole_desktop.screen_recorder")

_state = {
    "running": False,
    "proc": None,
    "current_file": None,
    "thread": None,
}


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _start_chunk() -> Path:
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = RECORDINGS_DIR / f"cole-desktop-{ts}.mp4"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "gdigrab",
        "-framerate", "8",      # 8 fps is plenty for an audit recording, keeps file small
        "-i", "desktop",
        "-vcodec", "libx264",
        "-preset", "veryfast",
        "-crf", "30",
        "-pix_fmt", "yuv420p",
        "-t", str(ROTATE_MINUTES * 60),
        str(out),
    ]
    log.info("Starting recording chunk: %s", out.name)
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    _state["proc"] = proc
    _state["current_file"] = out
    return out


def _upload_chunk(path: Path) -> None:
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return
    if not path.exists():
        return
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path.name}"
    try:
        with open(path, "rb") as f:
            resp = requests.post(
                url,
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "video/mp4",
                    "x-upsert": "true",
                },
                data=f,
                timeout=120,
            )
        if resp.status_code not in (200, 201):
            log.warning("recording upload failed %s: %s %s", path.name, resp.status_code, resp.text[:200])
    except Exception as e:
        log.warning("recording upload exception: %s", e)


def _clean_local() -> None:
    cutoff = datetime.now() - timedelta(days=LOCAL_RETENTION_DAYS)
    for f in RECORDINGS_DIR.glob("cole-desktop-*.mp4"):
        try:
            if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                f.unlink(missing_ok=True)
        except Exception:
            continue


def _loop():
    while _state["running"]:
        out_path = _start_chunk()
        # Wait for ffmpeg to finish this chunk (-t handles rotation)
        proc = _state["proc"]
        try:
            proc.wait()
        except Exception:
            pass
        # Chunk done - upload + clean
        _upload_chunk(out_path)
        _clean_local()


def start() -> bool:
    """Start the rotating recorder thread. Returns True if started, False otherwise."""
    if _state["running"]:
        return True
    if not _ffmpeg_available():
        log.warning("ffmpeg not on PATH - screen recording disabled")
        return False
    _state["running"] = True
    t = threading.Thread(target=_loop, name="cole-screen-recorder", daemon=True)
    t.start()
    _state["thread"] = t
    return True


def stop() -> None:
    _state["running"] = False
    proc = _state["proc"]
    if proc and proc.poll() is None:
        try:
            # Polite stop: send 'q' on stdin so ffmpeg writes a clean trailer
            proc.stdin.write(b"q")
            proc.stdin.flush()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if start():
        print("Recording. Ctrl-C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            stop()
            print("Stopped.")
    else:
        print("ffmpeg not available - install ffmpeg and add to PATH")
