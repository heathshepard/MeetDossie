#!/usr/bin/env python3
"""
build-italy-v3.py
Assembles the Italy founder-story selfie video (v3) from 15 raw HEVC clips
plus one screen recording splice.

Directed by Sage. Executed by Carter.

Assembly order (Sage's editorial decision — do not reorder without Sage approval):
  1. Clip 1  (20260529_163602) — Hook: Italy, TC quit
  2. Clip 2  (20260529_163719) — Stakes: option period
  3. Clip 3  (20260529_163731) — Stakes: title company
  4. Clip 4  (20260529_163759) — Stakes: lender/appraisal
  5. Clip 5  (20260529_163851) — Situation: 9 time zones
  6. Clip 6  (20260529_163858) — Situation: hotel Wi-Fi
  7. Clip 7  (20260529_163912) — Situation: restaurant
  8. Clip 15 (20260529_164512) — Emotional peak: built business around someone who could leave
  9. Clip 8  (20260529_164010) — The build: so I built something
  [SCREEN SPLICE — pipeline-mobile-2026-05-29.mp4 t=9s to t=17s, 8 seconds]
  10. Clip 9  (20260529_164037) — Feature: morning brief
  11. Clip 10 (20260529_164048) — Feature: deadlines coming
  12. Clip 11 (20260529_164059) — Feature: what's already handled
  13. Clip 12 (20260529_164118) — Feature: follow-up emails
  14. Clip 13 (20260529_164130) — Outcome: no 4:30am
  15. Clip 16 (20260529_164748) — CTA: $29/mo, 38 spots

DROPPED:
  Clip 14 (20260529_164140) — social proof (12 transactions) — interrupts payoff-to-CTA flow
  Clip 17 (20260529_165211) — TREC deadline feature — third consecutive feature item, redundant

Technical spec:
  - Output: 1080x1920, H.264 CRF 23, 30fps, AAC 128k
  - All HEVC source clips re-encoded (never stream-copied)
  - Each selfie clip: 0.3s trimmed from head and tail
  - Screen recording: t=9s to t=17s, scaled to 1080x1920 fill + center crop
  - Target duration: 50-60 seconds
"""

import subprocess
import os
import sys
import json
import shutil

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ITALY_DIR = r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\Selfie\Italy"
# Source clips are the numbered HEVC 4K originals in the Italy root folder
SOURCE_DIR = ITALY_DIR
SCREEN_REC = r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\screen-recordings\pipeline-mobile-2026-05-29.mp4"
OUTPUT = r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\finished-videos\italy-selfie-v3-2026-05-29.mp4"
INTERMEDIATES_DIR = os.path.join(ITALY_DIR, "intermediates_v3")

# ---------------------------------------------------------------------------
# Assembly plan — ordered by Sage
# ---------------------------------------------------------------------------
# Numbered source files (HEVC 4K originals in Italy root).
# Mapping confirmed by duration matching against transcript table.
# Numbered order is filming order (camera-assigned), NOT timestamp order.
SELFIE_ORDER = [
    "1.mp4",   # Hook: Italy, TC quit (7.0s)
    "2.mp4",   # Stakes: option period (2.5s)
    "3.mp4",   # Stakes: title company (2.3s)
    "4.mp4",   # Stakes: lender/appraisal (2.7s)
    "5.mp4",   # Situation: 9 time zones (2.1s)
    "6.mp4",   # Situation: hotel Wi-Fi (2.3s)
    "7.mp4",   # Situation: restaurant (3.7s)
    "8.mp4",   # Emotional peak: built business around someone who could leave (7.5s)
    "9.mp4",   # The build: so I built something (6.2s)
    # --- SCREEN SPLICE GOES HERE ---
    "10.mp4",  # Feature: morning brief (3.6s)
    "11.mp4",  # Feature: deadlines coming (3.5s)
    "12.mp4",  # Feature: what's already handled (2.2s)
    "14.mp4",  # Feature: follow-up emails (3.6s)
    "15.mp4",  # Outcome: no 4:30am (3.9s)
    "13.mp4",  # CTA: $29/mo, 38 spots (4.8s)
]
# DROPPED: 16.mp4 (social proof / 12 transactions - interrupts payoff flow)
#          17.mp4 (TREC deadline feature - redundant third feature item)

# Screen splice parameters (confirmed usable section from prior verification)
SCREEN_START = 9.0
SCREEN_END = 17.0
SCREEN_DURATION = SCREEN_END - SCREEN_START  # 8.0 seconds

# Head/tail trim on every selfie clip (Rule 3)
CLIP_TRIM = 0.3

# Target spec
TARGET_W = 1080
TARGET_H = 1920
TARGET_FPS = 30
TARGET_CRF = 23
TARGET_AUDIO_BITRATE = "128k"

# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------
def run(cmd, label=""):
    """Run a command, print it, raise on failure."""
    print(f"\n{'='*60}")
    if label:
        print(f"STEP: {label}")
    print("CMD:", " ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, capture_output=False)
    if result.returncode != 0:
        print(f"ERROR: command failed with code {result.returncode}")
        sys.exit(1)
    return result


def probe_duration(path):
    """Return duration in seconds via ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    data = json.loads(result.stdout)
    for stream in data.get("streams", []):
        if "duration" in stream:
            return float(stream["duration"])
    return None


# ---------------------------------------------------------------------------
# Step 1: Create fresh intermediates_v3 directory
# ---------------------------------------------------------------------------
def setup_dirs():
    if os.path.exists(INTERMEDIATES_DIR):
        shutil.rmtree(INTERMEDIATES_DIR)
    os.makedirs(INTERMEDIATES_DIR)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    print(f"Intermediates dir: {INTERMEDIATES_DIR}")


# ---------------------------------------------------------------------------
# Step 2: Re-encode each selfie clip
# Trims 0.3s from head and tail.
# Re-encodes HEVC 4K -> H.264 1080x1920 30fps CRF 23.
# ---------------------------------------------------------------------------
def encode_selfie_clips():
    encoded = []
    for filename in SELFIE_ORDER:
        src = os.path.join(SOURCE_DIR, filename)
        dst = os.path.join(INTERMEDIATES_DIR, filename)

        if not os.path.exists(src):
            print(f"ERROR: source clip not found: {src}")
            sys.exit(1)

        raw_dur = probe_duration(src)
        if raw_dur is None:
            print(f"ERROR: could not probe duration of {src}")
            sys.exit(1)

        # After trimming 0.3s head + 0.3s tail
        trimmed_dur = raw_dur - (CLIP_TRIM * 2)
        if trimmed_dur <= 0.5:
            print(f"WARNING: clip {filename} too short after trim ({raw_dur:.2f}s raw). Skipping trim.")
            trimmed_dur = raw_dur
            ss = 0.0
        else:
            ss = CLIP_TRIM

        print(f"\nEncoding {filename}: raw={raw_dur:.2f}s -> trimmed={trimmed_dur:.2f}s")

        run([
            "ffmpeg", "-y",
            "-ss", str(ss),
            "-i", src,
            "-t", str(trimmed_dur),
            # Scale to fill 1080x1920, preserve aspect with crop
            "-vf", (
                f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
                f"crop={TARGET_W}:{TARGET_H},"
                f"fps={TARGET_FPS}"
            ),
            "-c:v", "libx264",
            "-crf", str(TARGET_CRF),
            "-preset", "fast",
            "-pix_fmt", "yuv420p",
            # No audio in selfie clips (mic audio not used — ElevenLabs voiceover handles audio)
            "-an",
            dst,
        ], label=f"Re-encode selfie: {filename}")

        encoded.append(dst)

    return encoded


# ---------------------------------------------------------------------------
# Step 3: Extract + re-encode screen recording splice
# t=9s to t=17s (8 seconds), scale to 1080x1920 fill+crop
# ---------------------------------------------------------------------------
def encode_screen_splice():
    dst = os.path.join(INTERMEDIATES_DIR, "pipeline_splice_8s.mp4")

    run([
        "ffmpeg", "-y",
        "-ss", str(SCREEN_START),
        "-i", SCREEN_REC,
        "-t", str(SCREEN_DURATION),
        "-vf", (
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
            f"crop={TARGET_W}:{TARGET_H},"
            f"fps={TARGET_FPS}"
        ),
        "-c:v", "libx264",
        "-crf", str(TARGET_CRF),
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-an",
        dst,
    ], label="Re-encode screen splice (t=9s to t=17s)")

    return dst


# ---------------------------------------------------------------------------
# Step 4: Build concat list
# Splice goes between position 9 (Clip 8 / the build) and position 10 (Clip 9 / morning brief)
# In the encoded list, that is after index 8 (0-indexed).
# ---------------------------------------------------------------------------
def build_concat_list(encoded_selfie_clips, screen_splice_path):
    # Clips before splice: indices 0-8 (9 clips: hook through "so I built")
    before_splice = encoded_selfie_clips[:9]
    # Clips after splice: indices 9-14 (6 clips: morning brief through CTA)
    after_splice = encoded_selfie_clips[9:]

    ordered = before_splice + [screen_splice_path] + after_splice

    concat_path = os.path.join(INTERMEDIATES_DIR, "concat_v3.txt")
    with open(concat_path, "w", encoding="ascii") as f:
        for p in ordered:
            # ffmpeg concat demuxer requires forward slashes
            f.write(f"file '{p.replace(chr(92), '/')}'\n")

    print(f"\nConcat list ({len(ordered)} segments):")
    for i, p in enumerate(ordered, 1):
        dur = probe_duration(p)
        dur_str = f"{dur:.2f}s" if dur else "?"
        label = os.path.basename(p)
        print(f"  {i:2d}. {label} ({dur_str})")

    return concat_path, ordered


# ---------------------------------------------------------------------------
# Step 5: Concatenate all segments and produce final output
# All segments are already H.264 1080x1920 30fps — use stream copy for speed.
# ---------------------------------------------------------------------------
def concatenate(concat_path, ordered):
    # Estimate total duration
    total = sum(
        (probe_duration(p) or 0) for p in ordered
    )
    print(f"\nEstimated total duration: {total:.1f}s")
    if total < 45:
        print(f"WARNING: video is under 45s target ({total:.1f}s)")
    if total > 65:
        print(f"WARNING: video is over 60s target ({total:.1f}s) - consider trimming")

    run([
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_path,
        # All segments already match spec — stream copy is safe here
        "-c", "copy",
        OUTPUT,
    ], label="Final concat -> output")

    return OUTPUT


# ---------------------------------------------------------------------------
# Step 6: Verification — extract frames at 5s, halfway, and 5s before end
# ---------------------------------------------------------------------------
def verify_output(output_path):
    dur = probe_duration(output_path)
    if dur is None:
        print("ERROR: could not probe output duration")
        return

    verify_dir = os.path.join(ITALY_DIR, "verify_v3")
    os.makedirs(verify_dir, exist_ok=True)

    checkpoints = {
        "t05s": 5.0,
        "t_half": dur / 2,
        "t_end": max(dur - 5.0, dur / 2 + 1),
    }

    print(f"\nVerification frames (output duration: {dur:.1f}s):")
    frame_paths = {}
    for label, t in checkpoints.items():
        frame_path = os.path.join(verify_dir, f"frame_{label}.jpg")
        result = subprocess.run([
            "ffmpeg", "-y",
            "-ss", str(t),
            "-i", output_path,
            "-vframes", "1",
            "-q:v", "2",
            frame_path,
        ], capture_output=True)
        if result.returncode == 0:
            print(f"  {label} (t={t:.1f}s): {frame_path}")
            frame_paths[label] = frame_path
        else:
            print(f"  {label}: FAILED to extract frame")

    return frame_paths, dur


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print("ITALY FOUNDER STORY v3 — SAGE DIRECTED ASSEMBLY")
    print("=" * 60)

    # Pre-flight checks
    for p in [ITALY_DIR, SCREEN_REC]:
        if not os.path.exists(p):
            print(f"ERROR: required path not found: {p}")
            sys.exit(1)

    for filename in SELFIE_ORDER:
        src = os.path.join(SOURCE_DIR, filename)
        if not os.path.exists(src):
            print(f"ERROR: clip not found: {src}")
            sys.exit(1)

    print("Pre-flight: all source files confirmed.")

    setup_dirs()

    print("\nStep 2: Re-encoding selfie clips...")
    encoded_selfie = encode_selfie_clips()

    print("\nStep 3: Re-encoding screen splice...")
    screen_splice = encode_screen_splice()

    print("\nStep 4: Building concat list...")
    concat_path, ordered = build_concat_list(encoded_selfie, screen_splice)

    print("\nStep 5: Final concat...")
    concatenate(concat_path, ordered)

    print("\nStep 6: Extracting verification frames...")
    frame_paths, final_dur = verify_output(OUTPUT)

    stat = os.stat(OUTPUT)
    size_mb = stat.st_size / 1024 / 1024

    print("\n" + "=" * 60)
    print("BUILD COMPLETE")
    print(f"  Output:   {OUTPUT}")
    print(f"  Duration: {final_dur:.1f}s")
    print(f"  Size:     {size_mb:.1f} MB")
    print(f"  Frames:   {os.path.join(ITALY_DIR, 'verify_v3')}")
    print("=" * 60)
    print("\nSage: read the verification frames before declaring done.")
    print("Confirm: correct opener, pipeline visible at splice, CTA is final frame.")


if __name__ == "__main__":
    main()
