"""Generate the Dossie 'D' logo SVG and PNG variants.

cairosvg requires native cairo (not installed on this machine), so for the
PNG outputs we render directly with Pillow rather than rasterizing the SVG.
The two paths use the same constants so the outputs match.

Outputs:
  Media/dossie-logo-d.svg          500x500 (Cormorant Garamond declared in font-family)
  Media/dossie-logo-d.png          400x400 social profile
  Media/dossie-logo-horizontal.png 1500x500 D + 'Dossie' wordmark
"""
import io
import math
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageChops

MEDIA = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\Media")
FONT_DIR = MEDIA / "_fonts"
SVG_OUT = MEDIA / "dossie-logo-d.svg"
PNG_LOGO = MEDIA / "dossie-logo-d.png"
PNG_HORIZONTAL = MEDIA / "dossie-logo-horizontal.png"

CG_BOLD_URL = "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3umX5slCNuHLi8bLeY9MK7whWMhyjypVO7abI26QOD_hg9GnM.ttf"
CG_SEMIBOLD_URL = "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3umX5slCNuHLi8bLeY9MK7whWMhyjypVO7abI26QOD_iE9GnM.ttf"

BLUSH_LIGHT = (245, 230, 224)   # #F5E6E0
BLUSH_DEEP = (212, 160, 160)    # #D4A0A0
NAVY = (26, 26, 46)             # #1A1A2E
GOLD = (201, 169, 110)          # #C9A96E


def fetch_font(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        dest.write_bytes(r.read())
    return dest


def make_radial_blush(size: int) -> Image.Image:
    """Diagonal blush gradient inside a circular mask. Top-left light,
    bottom-right deep."""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = base.load()
    diag = math.hypot(size, size)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)  # 0 → 1 from top-left to bottom-right
            r = int(BLUSH_LIGHT[0] + (BLUSH_DEEP[0] - BLUSH_LIGHT[0]) * t)
            g = int(BLUSH_LIGHT[1] + (BLUSH_DEEP[1] - BLUSH_LIGHT[1]) * t)
            b = int(BLUSH_LIGHT[2] + (BLUSH_DEEP[2] - BLUSH_LIGHT[2]) * t)
            px[x, y] = (r, g, b, 255)
    # Circular mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    base.putalpha(mask)
    return base


def draw_letter_d(canvas: Image.Image, font_path: Path, center: tuple[int, int], font_size: int) -> None:
    font = ImageFont.truetype(str(font_path), font_size)
    draw = ImageDraw.Draw(canvas)
    bbox = draw.textbbox((0, 0), "D", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    # Pillow's textbbox gives the actual ink box; we anchor via the bbox top-left
    # so the glyph is visually centered.
    x = center[0] - w / 2 - bbox[0]
    y = center[1] - h / 2 - bbox[1]
    draw.text((x, y), "D", font=font, fill=NAVY)


def render_logo_circle(size: int, font_path: Path) -> Image.Image:
    img = make_radial_blush(size)
    draw = ImageDraw.Draw(img)
    # Subtle gold inner ring — small gap from edge.
    gap = max(8, size // 60)
    ring_w = max(2, size // 250)
    inset = gap + ring_w / 2
    draw.ellipse(
        (inset, inset, size - 1 - inset, size - 1 - inset),
        outline=GOLD, width=ring_w,
    )
    # D — ~60% of diameter. Cormorant Garamond Bold cap-height ~0.7em.
    font_size = int(size * 0.85)
    # Optical centering: D's visual mass sits slightly low; nudge up.
    draw_letter_d(img, font_path, (size // 2, int(size * 0.50)), font_size)
    return img


def render_horizontal(width: int, height: int, font_path: Path, font_path_text: Path) -> Image.Image:
    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    # Logo on the left — circle sized to fit the height with a comfortable margin.
    margin = int(height * 0.10)
    circle = height - 2 * margin
    logo = render_logo_circle(circle, font_path)
    canvas.paste(logo, (margin, margin), logo)
    # Wordmark on the right — single line, baseline-aligned with circle's vertical center.
    wordmark_size = int(height * 0.48)
    font = ImageFont.truetype(str(font_path_text), wordmark_size)
    draw = ImageDraw.Draw(canvas)
    text = "Dossie"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = margin + circle + int(height * 0.18)
    y = (height - text_h) // 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=NAVY)
    return canvas


SVG_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <defs>
    <linearGradient id="blush" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F5E6E0"/>
      <stop offset="100%" stop-color="#D4A0A0"/>
    </linearGradient>
  </defs>
  <!-- soft blush gradient circle -->
  <circle cx="250" cy="250" r="249.5" fill="url(#blush)"/>
  <!-- subtle gold inner ring, small gap from edge -->
  <circle cx="250" cy="250" r="240" fill="none" stroke="#C9A96E" stroke-width="2"/>
  <!-- letter D, Cormorant Garamond serif, dark navy -->
  <text x="250" y="250"
        font-family="'Cormorant Garamond', 'Garamond', 'Times New Roman', serif"
        font-weight="700"
        font-size="425"
        fill="#1A1A2E"
        text-anchor="middle"
        dominant-baseline="central">D</text>
</svg>
"""


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    print("[fonts] downloading Cormorant Garamond...")
    font_bold = fetch_font(CG_BOLD_URL, FONT_DIR / "CormorantGaramond-Bold.ttf")
    font_semibold = fetch_font(CG_SEMIBOLD_URL, FONT_DIR / "CormorantGaramond-SemiBold.ttf")
    print(f"  bold     {font_bold.stat().st_size} bytes")
    print(f"  semibold {font_semibold.stat().st_size} bytes")

    print(f"[svg]   {SVG_OUT}")
    SVG_OUT.write_text(SVG_TEMPLATE, encoding="utf-8")

    print(f"[png]   {PNG_LOGO} (400x400)")
    logo400 = render_logo_circle(400, font_bold)
    logo400.save(PNG_LOGO, "PNG")

    print(f"[png]   {PNG_HORIZONTAL} (1500x500)")
    horiz = render_horizontal(1500, 500, font_bold, font_semibold)
    horiz.save(PNG_HORIZONTAL, "PNG")

    for f in (SVG_OUT, PNG_LOGO, PNG_HORIZONTAL):
        print(f"[done]  {f}  {f.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
