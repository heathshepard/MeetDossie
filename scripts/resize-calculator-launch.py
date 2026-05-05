"""Resize the calculator-launch screenshot for FB / IG / TW.

Per spec:
  Instagram: 1080x1080 (square crop, center)
  Facebook : 1200x630  (landscape, center crop)
  Twitter  : 1200x675  (landscape, center crop)

Source : Media/screen-shots/Date Calc.png
Outputs:
  Media/instagram-cards/calculator-launch.png         (verbatim copy of source for archive)
  Media/instagram-cards/calculator-launch-square.png  (Instagram)
  Media/instagram-cards/calculator-launch-facebook.png
  Media/instagram-cards/calculator-launch-twitter.png

Also writes the three platform-resized versions to assets/social/ so Vercel
serves them publicly and Zernio can fetch via URL when the cron publishes.
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
SRC = ROOT / "Media" / "screen-shots" / "Date Calc.png"
PRIVATE = ROOT / "Media" / "instagram-cards"
PUBLIC = ROOT / "assets" / "social"

TARGETS = {
    "square":   {"size": (1080, 1080), "label": "Instagram"},
    "facebook": {"size": (1200, 630),  "label": "Facebook"},
    "twitter":  {"size": (1200, 675),  "label": "Twitter"},
}

PADDING_BG = (245, 230, 224, 255)  # blush-light, matches brand


def fit_with_pad(img: Image.Image, target_w: int, target_h: int, bg=PADDING_BG) -> Image.Image:
    """Letterbox-fit on brand-blush background. Preserves the entire screenshot
    (no cropping), centers it, and pads with brand blush so the calculator
    UI is fully visible on every platform."""
    src_w, src_h = img.size
    src_ratio = src_w / src_h
    tgt_ratio = target_w / target_h
    if src_ratio > tgt_ratio:
        # Source is wider than target — fit to width.
        new_w = target_w
        new_h = max(1, round(target_w / src_ratio))
    else:
        # Source taller than target — fit to height.
        new_h = target_h
        new_w = max(1, round(target_h * src_ratio))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (target_w, target_h), bg)
    ox = (target_w - new_w) // 2
    oy = (target_h - new_h) // 2
    if resized.mode != "RGBA":
        resized = resized.convert("RGBA")
    canvas.paste(resized, (ox, oy), resized)
    return canvas


def main() -> int:
    if not SRC.exists():
        print(f"[fatal] source not found: {SRC}", file=sys.stderr)
        return 1

    PRIVATE.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    archive_dest = PRIVATE / "calculator-launch.png"
    shutil.copyfile(SRC, archive_dest)
    print(f"[archive] {SRC.name} -> {archive_dest.relative_to(ROOT)}  ({archive_dest.stat().st_size:,} bytes)")

    src_img = Image.open(SRC).convert("RGBA")
    print(f"[source ] {src_img.size}")

    for key, meta in TARGETS.items():
        w, h = meta["size"]
        out_private = PRIVATE / f"calculator-launch-{key}.png"
        out_public = PUBLIC / f"calculator-launch-{key}.png"
        resized = fit_with_pad(src_img, w, h)
        resized.save(out_private, "PNG", optimize=True)
        resized.save(out_public, "PNG", optimize=True)
        print(f"[{key:8s}] {meta['label']:9s} {w}x{h:<5d} -> {out_private.relative_to(ROOT)} + {out_public.relative_to(ROOT)} "
              f"({out_private.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
