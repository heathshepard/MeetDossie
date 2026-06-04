"""
make-reel.py — Assemble a 2-clip Dossie ad reel.
Usage: python scripts/make-reel.py --clip1 <pain.mp4> --clip2 <relief.mp4> --out <output.mp4>

Steps:
1. Concat clip1 + clip2 via ffmpeg
2. Generate text overlay PNGs via Pillow (transparent, white bold text + black shadow)
3. Composite overlays onto video via ffmpeg overlay filter
4. Output final MP4
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── config ──────────────────────────────────────────────────────────────────
FONT_BOLD = r"C:\Windows\Fonts\arialbd.ttf"
FONT_REG  = r"C:\Windows\Fonts\arial.ttf"
WIDTH, HEIGHT = 1080, 1920  # 9:16

OVERLAYS = [
    # (start_s, end_s, text, font_size, y_frac)
    (0.5,  4.8,  "$8,000/year",            90, 0.50),
    (5.5,  9.5,  "or $29/month",           90, 0.50),
    (8.0, 10.5,  "meetdossie.com/founding", 46, 0.82),
]

def make_text_png(text: str, font_size: int, out_path: str):
    img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(FONT_BOLD, font_size)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (WIDTH - tw) // 2
    y = 0  # will be positioned via ffmpeg overlay y offset

    # shadow
    for dx, dy in [(-3,-3),(3,-3),(-3,3),(3,3),(0,4),(4,0),(-4,0),(0,-4)]:
        draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0, 200))
    # main text
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    img.save(out_path)
    return tw, th


def ffmpeg(*args, check=True):
    cmd = ["ffmpeg", "-y"] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print("ffmpeg stderr:", result.stderr[-2000:])
        sys.exit(1)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip1", required=True)
    parser.add_argument("--clip2", required=True)
    parser.add_argument("--out", default=r"Media\finished-videos\dossie-reel.mp4")
    args = parser.parse_args()

    tmp = tempfile.mkdtemp()
    concat_path = os.path.join(tmp, "concat.mp4")
    list_path   = os.path.join(tmp, "list.txt")

    # ── Step 1: concat ──────────────────────────────────────────────────────
    print("Concatenating clips...")
    with open(list_path, "w") as f:
        f.write(f"file '{os.path.abspath(args.clip1)}'\n")
        f.write(f"file '{os.path.abspath(args.clip2)}'\n")
    ffmpeg("-f", "concat", "-safe", "0", "-i", list_path,
           "-c:v", "libx264", "-preset", "fast", "-crf", "18",
           "-pix_fmt", "yuv420p", "-an", concat_path)

    # ── Step 2: build overlay PNGs ─────────────────────────────────────────
    print("Generating text overlays...")
    overlay_specs = []
    for i, (start, end, text, fsize, y_frac) in enumerate(OVERLAYS):
        png_path = os.path.join(tmp, f"overlay_{i}.png")
        tw, th = make_text_png(text, fsize, png_path)
        overlay_specs.append({
            "path": png_path, "start": start, "end": end,
            "x": (WIDTH - tw) // 2,
            "y": int(HEIGHT * y_frac) - th // 2,
            "idx": i,
        })

    # ── Step 3: composite overlays ──────────────────────────────────────────
    print("Compositing overlays...")
    inputs = ["-i", concat_path]
    for spec in overlay_specs:
        inputs += ["-i", spec["path"]]

    # build filter_complex string
    # chain: [base] overlay img0 → [v0] overlay img1 → [v1] overlay img2 → [vout]
    fc_parts = []
    prev = "0:v"
    for i, spec in enumerate(overlay_specs):
        inp_idx = i + 1  # input index (0 is video)
        out_label = f"v{i}" if i < len(overlay_specs) - 1 else "vout"
        x = spec["x"]
        y = spec["y"]
        s, e = spec["start"], spec["end"]
        fc_parts.append(
            f"[{prev}][{inp_idx}:v]overlay=x={x}:y={y}:enable='between(t,{s},{e})'[{out_label}]"
        )
        prev = out_label

    filter_complex = ";".join(fc_parts)

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    cmd = (inputs +
           ["-filter_complex", filter_complex,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p", out_path])
    ffmpeg(*cmd)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\nDone: {out_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
