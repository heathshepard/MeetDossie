"""Build cost-math reel: concat Kling AI clips, mix ElevenLabs voiceover, freeze last frame."""
import os
import subprocess
import tempfile
from pathlib import Path

CLIP_PAIN   = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\Videos\ElevenLabs_video_kling-2-5_A weary fema..._2026-05-25T12_25_18.mp4")
CLIP_RELIEF = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\Videos\ElevenLabs_video_kling-2-5_A confident ..._2026-05-25T12_33_04.mp4")
VOICEOVER   = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\voiceovers\cost-math-reel-jessica.mp3")
OUTPUT      = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media\finished-videos\cost-math-reel-raw.mp4")


def ffmpeg(*args):
    cmd = ["ffmpeg", "-y"] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG STDERR:", r.stderr[-3000:])
        raise RuntimeError(f"ffmpeg failed with code {r.returncode}")
    return r


def probe_duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return float(r.stdout.strip())


def main():
    for p in [CLIP_PAIN, CLIP_RELIEF, VOICEOVER]:
        if not p.exists():
            raise FileNotFoundError(p)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    vo_dur   = probe_duration(VOICEOVER)
    vid_dur  = probe_duration(CLIP_PAIN) + probe_duration(CLIP_RELIEF)
    freeze   = max(0.0, vo_dur - vid_dur + 0.1)  # extra 0.1s breathing room
    print(f"Voiceover: {vo_dur:.2f}s  |  Video clips: {vid_dur:.2f}s  |  Freeze: {freeze:.2f}s")

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8")
    tmp.write(f"file '{CLIP_PAIN.as_posix()}'\n")
    tmp.write(f"file '{CLIP_RELIEF.as_posix()}'\n")
    tmp.close()

    try:
        print("Building reel: concat Kling clips + freeze last frame + ElevenLabs voiceover...")
        ffmpeg(
            "-f", "concat", "-safe", "0", "-i", tmp.name,
            "-i", str(VOICEOVER),
            "-filter_complex",
            f"[0:v]tpad=stop_mode=clone:stop_duration={freeze:.3f}[v]",
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(OUTPUT),
        )
    finally:
        os.unlink(tmp.name)

    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    dur = probe_duration(OUTPUT)
    print(f"OK -> {OUTPUT} ({size_mb:.1f} MB, {dur:.2f}s)")


if __name__ == "__main__":
    main()
