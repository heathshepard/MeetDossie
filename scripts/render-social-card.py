#!/usr/bin/env python3
"""Render branded Dossie social cards for Instagram (1080x1080) and Facebook (1200x630).

Single unified renderer — same brand language, different proportions.

Usage:
  python scripts/render-social-card.py --platform instagram --content "..." --output card.png
  python scripts/render-social-card.py --platform facebook  --content "..." --hook "Stop trusting your file to a TC who ghosts." --persona brenda --output card.png

Designed to be called by api/cron-publish-approved.js (or by the DONE handler)
when a queued social_post needs an image — the rendered PNG is then uploaded
to Supabase Storage / Zernio and attached as mediaItems[0].
"""
from __future__ import annotations

import argparse
import os
import sys
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ─── Brand palette (matches Dossie web app) ──────────────────────────────
SALMON = (232, 146, 124)       # #E8927C — primary accent
CREAM = (253, 252, 250)        # #FDFCFA — page background
BEIGE = (240, 235, 227)        # #F0EBE3 — borders / dividers
WARM_GRAY_LIGHT = (163, 158, 148)  # #A39E94 — secondary text
WARM_GRAY_DARK = (122, 116, 104)   # #7A7468 — body text
INK = (38, 32, 24)             # near-black for hook headlines

# ─── Asset paths ─────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
FONT_BOLD = ROOT / "Media" / "_fonts" / "CormorantGaramond-Bold.ttf"
FONT_SEMIBOLD = ROOT / "Media" / "_fonts" / "CormorantGaramond-SemiBold.ttf"
FONT_FALLBACK_BOLD = "C:/Windows/Fonts/arialbd.ttf"
FONT_FALLBACK_REGULAR = "C:/Windows/Fonts/arial.ttf"
LOGO_D = ROOT / "Media" / "dossie-logo-d.png"

PLATFORM_DIMS = {
    "instagram": (1080, 1080),
    "facebook":  (1200, 630),
}

# Persona signature shows above the URL footer when --persona is supplied.
PERSONA_DISPLAY = {
    "brenda":   "— Brenda Martinez · San Antonio REALTOR",
    "patricia": "— Patricia Morrison · Dossie founder",
    "victor":   "— Victor Hayes · Houston REALTOR",
}


def load_font(path: Path | str, size: int) -> ImageFont.FreeTypeFont:
    """Load a TrueType font with a Windows Arial fallback if the asset is missing."""
    try:
        return ImageFont.truetype(str(path), size=size)
    except (OSError, IOError):
        fallback = FONT_FALLBACK_BOLD if "Bold" in str(path) else FONT_FALLBACK_REGULAR
        return ImageFont.truetype(fallback, size=size)


def text_size(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
    """Return pixel (width, height) for a single line of text."""
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def wrap_to_width(draw, text: str, font, max_width: int) -> list[str]:
    """Word-wrap text so each line fits within max_width pixels.

    Greedy: keeps adding words until the next would overflow, then breaks.
    Preserves explicit \\n line breaks from the source.
    """
    out: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            out.append("")
            continue
        words = paragraph.split()
        line = ""
        for w in words:
            cand = (line + " " + w).strip()
            if text_size(draw, cand, font)[0] <= max_width:
                line = cand
            else:
                if line:
                    out.append(line)
                line = w
        if line:
            out.append(line)
    return out


def fit_font_size(draw, text: str, font_path, max_width: int, max_height: int,
                  start: int, min_size: int = 24, line_spacing: float = 1.2) -> tuple:
    """Binary-search the largest font size that fits text into the given box.

    Returns (font, lines, total_height).
    """
    lo, hi = min_size, start
    best = (load_font(font_path, min_size), [], 0)
    while lo <= hi:
        mid = (lo + hi) // 2
        f = load_font(font_path, mid)
        lines = wrap_to_width(draw, text, f, max_width)
        line_h = text_size(draw, "Hg", f)[1]
        total_h = int(len(lines) * line_h * line_spacing)
        if total_h <= max_height and all(text_size(draw, ln, f)[0] <= max_width for ln in lines if ln):
            best = (f, lines, total_h)
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def draw_lines(draw, lines: list[str], font, x: int, y: int,
               color: tuple, line_spacing: float = 1.2) -> int:
    """Render a list of lines starting at (x, y). Returns the y after the last line."""
    line_h = text_size(draw, "Hg", font)[1]
    step = int(line_h * line_spacing)
    for ln in lines:
        if ln:
            draw.text((x, y), ln, font=font, fill=color)
        y += step
    return y


def render_card(platform: str, hook: str, content: str, persona: str | None,
                output: Path) -> None:
    if platform not in PLATFORM_DIMS:
        raise ValueError(f"unsupported platform '{platform}' — use instagram or facebook")
    W, H = PLATFORM_DIMS[platform]

    canvas = Image.new("RGB", (W, H), CREAM)
    draw = ImageDraw.Draw(canvas)

    # ─── Top accent stripe (salmon) ──────────────────────────────────────
    stripe_h = int(H * 0.025)
    draw.rectangle([(0, 0), (W, stripe_h)], fill=SALMON)

    # ─── Side margin and footer band ─────────────────────────────────────
    margin = int(W * 0.07)
    footer_h = int(H * (0.18 if platform == "instagram" else 0.22))
    footer_top = H - footer_h
    draw.rectangle([(0, footer_top), (W, footer_top)], fill=BEIGE)  # 1px hairline
    draw.line([(margin, footer_top), (W - margin, footer_top)], fill=BEIGE, width=2)

    # ─── Content area ────────────────────────────────────────────────────
    content_top = stripe_h + int(H * 0.06)
    content_bottom = footer_top - int(H * 0.04)
    content_left = margin
    content_right = W - margin
    content_w = content_right - content_left
    content_h = content_bottom - content_top

    # Hook: large serif, takes up to 45% of available content height.
    if hook:
        hook_max_h = int(content_h * 0.45)
        hook_start_size = int(H * 0.10) if platform == "instagram" else int(H * 0.12)
        hook_font, hook_lines, hook_total = fit_font_size(
            draw, hook, FONT_BOLD, content_w, hook_max_h, hook_start_size, min_size=36
        )
        y = draw_lines(draw, hook_lines, hook_font, content_left, content_top, INK, line_spacing=1.1)
        body_top = y + int(H * 0.025)
    else:
        body_top = content_top

    # Body: smaller serif, fills remaining space.
    body_max_h = max(content_bottom - body_top, int(H * 0.1))
    body_start_size = int(H * 0.045) if platform == "instagram" else int(H * 0.055)
    body_font, body_lines, body_total = fit_font_size(
        draw, content, FONT_SEMIBOLD, content_w, body_max_h, body_start_size, min_size=22
    )
    draw_lines(draw, body_lines, body_font, content_left, body_top, WARM_GRAY_DARK, line_spacing=1.3)

    # ─── Footer layout ───────────────────────────────────────────────────
    # Row 1 (upper):  [D logo] [Dossie wordmark] ............... [URL right]
    # Row 2 (lower):  ............................. [persona signature right]
    has_signature = persona in PERSONA_DISPLAY if persona else False
    row1_y_center = footer_top + int(footer_h * (0.38 if has_signature else 0.5))

    # Logo + wordmark anchored row-1 left.
    logo_target_h = int(footer_h * 0.45)
    if LOGO_D.exists():
        logo = Image.open(LOGO_D).convert("RGBA")
        ratio = logo_target_h / logo.height
        logo_w = int(logo.width * ratio)
        logo = logo.resize((logo_w, logo_target_h), Image.LANCZOS)
        canvas.paste(logo, (margin, row1_y_center - logo_target_h // 2), logo)
        wordmark_left = margin + logo_w + int(W * 0.022)
    else:
        wordmark_left = margin

    wordmark_size = int(footer_h * 0.30)
    wordmark_font = load_font(FONT_BOLD, wordmark_size)
    wm_w, wm_h = text_size(draw, "Dossie", wordmark_font)
    draw.text((wordmark_left, row1_y_center - wm_h // 2), "Dossie", font=wordmark_font, fill=INK)

    # URL right-aligned on row 1, baseline-aligned to wordmark.
    url_size = int(footer_h * 0.20)
    url_font = load_font(FONT_FALLBACK_BOLD, url_size)
    url_text = "meetdossie.com/founding"
    url_w, url_h = text_size(draw, url_text, url_font)
    url_x = W - margin - url_w
    # Bottom-align URL with the wordmark baseline so they read on the same line.
    url_y = (row1_y_center - wm_h // 2) + (wm_h - url_h)
    draw.text((url_x, url_y), url_text, font=url_font, fill=SALMON)

    # Row 2: persona signature, right-aligned, below row 1.
    if has_signature:
        row2_y_center = footer_top + int(footer_h * 0.78)
        sig_size = int(footer_h * 0.16)
        sig_font = load_font(FONT_FALLBACK_REGULAR, sig_size)
        sig_text = PERSONA_DISPLAY[persona]
        sig_w, sig_h = text_size(draw, sig_text, sig_font)
        # If signature is too wide for the row, shrink until it fits.
        max_sig_w = W - 2 * margin
        while sig_w > max_sig_w and sig_size > 14:
            sig_size -= 2
            sig_font = load_font(FONT_FALLBACK_REGULAR, sig_size)
            sig_w, sig_h = text_size(draw, sig_text, sig_font)
        draw.text((W - margin - sig_w, row2_y_center - sig_h // 2),
                  sig_text, font=sig_font, fill=WARM_GRAY_LIGHT)

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Render Dossie social card (Instagram square / Facebook OG)")
    ap.add_argument("--platform", required=True, choices=list(PLATFORM_DIMS.keys()))
    ap.add_argument("--content", required=True, help="Body copy. Use \\n for paragraph breaks.")
    ap.add_argument("--hook", default="", help="Optional bold headline above the body")
    ap.add_argument("--persona", default=None, choices=list(PERSONA_DISPLAY.keys()) + [None])
    ap.add_argument("--output", required=True, help="Output PNG path")
    args = ap.parse_args()

    out = Path(args.output)
    # CLI ergonomics: translate the two-character escape "\n" into a real newline
    # so callers can pass paragraph breaks on the command line. Production callers
    # (cron-publish-approved invoking via child process) pass real newlines and
    # are unaffected.
    content = args.content.replace("\\n", "\n")
    hook = args.hook.replace("\\n", "\n")
    render_card(args.platform, hook, content, args.persona, out)
    W, H = PLATFORM_DIMS[args.platform]
    size_kb = out.stat().st_size / 1024
    print(f"[render-social-card] platform={args.platform} {W}x{H} -> {out} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
