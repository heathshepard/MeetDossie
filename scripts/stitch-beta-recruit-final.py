"""Add background music to the beta-recruit marketing video.

Pixabay CDN download was 403-gated, so per the spec's documented fallback,
we synthesize a soft ambient pad (layered sine drones + filtered pink noise)
with ffmpeg. At 8% volume under the Bill voiceover it reads as warm room
tone rather than music.

Then re-encode both video aspect ratios with the mixed audio.
"""
import shutil
import subprocess
import sys
from pathlib import Path

MEDIA = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
SRC_VIDEO = MEDIA / "beta-recruit-v1-screenrecord.mp4"
SRC_VOICE = MEDIA / "beta-recruit-v1-voiceover-bill-v4.mp3"
BG_MUSIC = MEDIA / "Music" / "joyinsound-corporate-motivational-background-music-403417.mp3"
OUT_VERTICAL = MEDIA / "beta-recruit-v1-vertical-final.mp4"
OUT_SQUARE = MEDIA / "beta-recruit-v1-square-final.mp4"

FADE_IN_VIDEO = 0.3
FADE_OUT_VIDEO = 0.5
BG_FADE_IN = 1.0
BG_FADE_OUT = 2.0
BG_LEVEL = 0.08
VOICE_LEVEL = 1.0

FFMPEG = shutil.which("ffmpeg") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"
FFPROBE = shutil.which("ffprobe") or r"C:\Users\Heath Shepard\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffprobe.exe"


def duration(path: Path) -> float:
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def synth_background(out: Path, length: float) -> None:
    """Build a soft ambient pad: three detuned low sines (root + fifth +
    octave), a slow tremolo, very faint filtered pink noise for texture,
    heavy lowpass + slight reverb. ~75 seconds long, plenty for our video."""
    target = max(length + 4.0, 70.0)
    fc = (
        # Three sine layers — A2 / E3 / A3 with tiny detunes
        f"sine=frequency=110:duration={target},aformat=channel_layouts=stereo[a1];"
        f"sine=frequency=165.5:duration={target},aformat=channel_layouts=stereo[a2];"
        f"sine=frequency=220.3:duration={target},aformat=channel_layouts=stereo[a3];"
        # Pink noise at very low gain for texture
        f"anoisesrc=color=pink:amplitude=0.05:duration={target},aformat=channel_layouts=stereo[n];"
        # Mix the four
        f"[a1][a2][a3][n]amix=inputs=4:weights=0.6 0.4 0.25 0.15:normalize=0[mix];"
        # Smooth: lowpass kills high partials, slight tremolo, gentle echo for air
        f"[mix]lowpass=f=900,tremolo=f=0.15:d=0.25,aecho=0.6:0.5:120:0.3,volume=0.7[out]"
    )
    cmd = [
        FFMPEG, "-y",
        "-filter_complex", fc,
        "-map", "[out]",
        "-c:a", "libmp3lame", "-b:a", "192k",
        str(out),
    ]
    print(f"[bg] synthesizing {out.name} ({target:.1f}s pad)")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr[-2000:])
        raise SystemExit("background synthesis failed")


def render(out: Path, dest_w: int, dest_h: int, target: float, video_dur: float) -> None:
    fade_out_video = max(0.0, target - FADE_OUT_VIDEO)
    bg_fade_out = max(0.0, target - BG_FADE_OUT)

    # Video chain
    vchain = []
    if video_dur < target - 0.05:
        pad = target - video_dur
        vchain.append(f"tpad=stop_mode=clone:stop_duration={pad:.3f}")
    vchain.append(f"trim=duration={target:.3f}")
    vchain.append("setpts=PTS-STARTPTS")
    vchain.append(f"scale={dest_w}:-2:force_original_aspect_ratio=decrease")
    vchain.append(f"pad={dest_w}:{dest_h}:(ow-iw)/2:(oh-ih)/2:color=black")
    vchain.append(f"fade=t=in:st=0:d={FADE_IN_VIDEO}")
    vchain.append(f"fade=t=out:st={fade_out_video:.3f}:d={FADE_OUT_VIDEO}")
    vstr = ",".join(vchain)

    # Voice chain — match video fades for clean start/end
    voice = (
        f"atrim=duration={target:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={FADE_IN_VIDEO},"
        f"afade=t=out:st={fade_out_video:.3f}:d={FADE_OUT_VIDEO},"
        f"volume={VOICE_LEVEL}"
    )

    # Background chain — separate fade timings (1s in, 2s out)
    bg = (
        f"atrim=duration={target:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={BG_FADE_IN},"
        f"afade=t=out:st={bg_fade_out:.3f}:d={BG_FADE_OUT},"
        f"volume={BG_LEVEL}"
    )

    fc = (
        f"[0:v]{vstr}[v];"
        f"[1:a]{voice}[voice];"
        f"[2:a]{bg}[bg];"
        f"[voice][bg]amix=inputs=2:duration=longest:normalize=0[a]"
    )

    cmd = [
        FFMPEG, "-y",
        "-i", str(SRC_VIDEO),
        "-i", str(SRC_VOICE),
        "-i", str(BG_MUSIC),
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
    for src in (SRC_VIDEO, SRC_VOICE):
        if not src.exists():
            sys.exit(f"missing: {src}")

    if not BG_MUSIC.exists():
        sys.exit(f"missing background music: {BG_MUSIC}")

    vdur = duration(SRC_VIDEO)
    adur = duration(SRC_VOICE)
    target = adur
    bdur = duration(BG_MUSIC)
    print(f"video {vdur:.3f}s  voice {adur:.3f}s  bg {bdur:.3f}s  target {target:.3f}s")

    render(OUT_VERTICAL, 1080, 1920, target, vdur)
    render(OUT_SQUARE,   1080, 1080, target, vdur)

    for out in (OUT_VERTICAL, OUT_SQUARE):
        d = duration(out)
        size_mb = out.stat().st_size / (1024 * 1024)
        print(f"[done] {out.name}  duration={d:.3f}s  size={size_mb:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
