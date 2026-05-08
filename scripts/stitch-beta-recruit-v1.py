"""Stitch the Bill v4 voiceover onto the screen recording, exporting
1080x1920 vertical (Reels/TikTok) and 1080x1080 square (FB groups).

Behavior:
  - Strip original video audio.
  - Extend video by freezing last frame if voiceover is longer.
  - Trim video if voiceover is shorter.
  - 0.3s fade-in on video+audio at start; 0.5s fade-out at end.
  - Vertical: scale to fit 1080 wide, pad top/bottom to 1080x1920.
  - Square:   scale to fit 1080 wide, pad top/bottom to 1080x1080.
"""
import shutil
import subprocess
import sys
from pathlib import Path

MEDIA = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
SRC_VIDEO = MEDIA / "beta-recruit-v1-screenrecord.mp4"
SRC_AUDIO = MEDIA / "beta-recruit-v1-voiceover-bill-v4.mp3"
OUT_VERTICAL = MEDIA / "beta-recruit-v1-vertical.mp4"
OUT_SQUARE = MEDIA / "beta-recruit-v1-square.mp4"

FADE_IN = 0.3
FADE_OUT = 0.5

FFMPEG = shutil.which("ffmpeg") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"
FFPROBE = shutil.which("ffprobe") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffprobe.exe"


def duration(path: Path) -> float:
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def build_filter_complex(target: float, dest_w: int, dest_h: int, video_dur: float) -> str:
    """Compose the filter chain. We start from the video stream, optionally
    extend (tpad clone) or trim (no extra filter — handled by output -t),
    then scale + pad + fade. Audio gets its fade in a parallel chain."""
    fade_out_start = max(0.0, target - FADE_OUT)
    # Video chain
    vchain = ["[0:v]"]
    if video_dur < target - 0.05:
        # Freeze last frame for the shortfall.
        pad = target - video_dur
        vchain.append(f"tpad=stop_mode=clone:stop_duration={pad:.3f}")
    # Trim to exact target so fade-out lands clean.
    vchain.append(f"trim=duration={target:.3f}")
    vchain.append("setpts=PTS-STARTPTS")
    vchain.append(f"scale={dest_w}:-2:force_original_aspect_ratio=decrease")
    vchain.append(f"pad={dest_w}:{dest_h}:(ow-iw)/2:(oh-ih)/2:color=black")
    vchain.append(f"fade=t=in:st=0:d={FADE_IN}")
    vchain.append(f"fade=t=out:st={fade_out_start:.3f}:d={FADE_OUT}")
    vstr = ",".join(vchain[1:])
    # Audio chain
    achain = ["[1:a]"]
    achain.append(f"atrim=duration={target:.3f}")
    achain.append("asetpts=PTS-STARTPTS")
    achain.append(f"afade=t=in:st=0:d={FADE_IN}")
    achain.append(f"afade=t=out:st={fade_out_start:.3f}:d={FADE_OUT}")
    astr = ",".join(achain[1:])
    return f"[0:v]{vstr}[v];[1:a]{astr}[a]"


def render(out: Path, dest_w: int, dest_h: int, target: float, video_dur: float) -> None:
    fc = build_filter_complex(target, dest_w, dest_h, video_dur)
    cmd = [
        FFMPEG, "-y",
        "-i", str(SRC_VIDEO),
        "-i", str(SRC_AUDIO),
        "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out),
    ]
    print(f"[render] {out.name}  {dest_w}x{dest_h}")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr[-2000:])
        raise SystemExit(f"ffmpeg failed: {out.name}")


def main() -> int:
    if not SRC_VIDEO.exists():
        sys.exit(f"missing video: {SRC_VIDEO}")
    if not SRC_AUDIO.exists():
        sys.exit(f"missing audio: {SRC_AUDIO}")

    vdur = duration(SRC_VIDEO)
    adur = duration(SRC_AUDIO)
    target = adur  # voiceover length wins
    print(f"video duration: {vdur:.3f}s")
    print(f"audio duration: {adur:.3f}s")
    print(f"target output:  {target:.3f}s  ({'freeze last frame' if adur > vdur else 'trim video' if adur < vdur else 'exact match'})")

    render(OUT_VERTICAL, 1080, 1920, target, vdur)
    render(OUT_SQUARE,   1080, 1080, target, vdur)

    for out in (OUT_VERTICAL, OUT_SQUARE):
        d = duration(out)
        size_mb = out.stat().st_size / (1024 * 1024)
        print(f"[done] {out.name}  duration={d:.3f}s  size={size_mb:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
