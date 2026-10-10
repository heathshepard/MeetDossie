#!/usr/bin/env python3
"""Delivery encode for a headless master: same picture, same audio, platform-sized.

    python3 scripts/headless-video/encode_delivery.py Media/headless-videos/<slug>.mp4
    -> Media/headless-videos/<slug>.delivery.mp4

Why this exists (2026-10-09, headless bank): the engine masters at crf 18 so the
burn-in captions stay crisp, which puts a 50-60s drone-heavy cut at 97-128 MB. The
Supabase `videos` bucket cap that scripts/video-engine/queue-variant.js uploads
into is 100 MB, and every platform re-encodes on ingest anyway. This re-encodes
the VIDEO stream only (crf 23, capped at 8 Mbit/s, 1080x1920 untouched) and
copies the audio stream bit-for-bit, so the mix, the decay tail and the
video/audio stream-duration agreement that api/_lib/verify-video-quality.js's
`speed_applied_once` rule measures are all unchanged. Every gate runs on THIS
file, because this is the file that posts.
"""
import os
import subprocess
import sys


# Effective per-file upload ceiling. storage.buckets says 104857600 for
# `videos`, but a 53.1 MB upload was refused with 413 EntityTooLarge on
# 2026-10-09 while a 43.0 MB one went through -- the project-level global
# upload limit (50 MB) binds before the bucket's own setting does. Keep a
# margin under it.
MAX_BYTES = 48 * 1024 * 1024
LADDER = [("23", "8M", "16M"), ("26", "6M", "12M"), ("28", "4.5M", "9M"), ("30", "3.5M", "7M")]


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: encode_delivery.py <master.mp4>")
    src = os.path.abspath(sys.argv[1])
    dst = src[:-4] + ".delivery.mp4"
    for crf, maxrate, bufsize in LADDER:
        subprocess.check_call([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
            "-c:v", "libx264", "-preset", "slow", "-crf", crf,
            "-maxrate", maxrate, "-bufsize", bufsize, "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-c:a", "copy", dst])
        size = os.path.getsize(dst)
        print("%s  %.1f MB  (crf %s, maxrate %s)" % (dst, size / 1e6, crf, maxrate))
        if size <= MAX_BYTES:
            return
    sys.exit("delivery file is still over %d bytes after the whole ladder" % MAX_BYTES)


if __name__ == "__main__":
    main()
