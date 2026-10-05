#!/usr/bin/env python3
"""
Build the TREC 20-19 "autopsy" specimen pages for the hunt-the-error video.

WHAT THIS IS
  The on-screen document is the BLANK promulgated TREC 20-19 (scripts/trec-forms/20-19.pdf),
  rasterised at 200dpi. Every filled value is drawn as an OVERLAY on top of that render.
  Nothing is written back into the PDF, so scripts/video-engine/assert-blessed-pdf.js still
  sees the blessed blank form on disk.

  Every page is stamped SPECIMEN - NOT A REAL CONTRACT so a frame of this can never be
  mistaken for an executed document.

WHY ASS AND NOT drawtext
  The local ffmpeg (7.0.2 johnvansickle static) is built WITHOUT libfreetype, so the
  drawtext filter does not exist. It does carry libass, so every text overlay in this
  pipeline is positioned ASS rendered through the `ass` filter. Same renderer the
  captions use.

NO PII. There is no address, no party name, no phone, no email, no escrow agent and no
file number anywhere in FILLS. Those blanks stay blank on purpose.

THE FOUR ERRORS (each verified verbatim against the form - see docs/AUTOPSY-TREC-20-19.md):
  E1  p2   5.A    option fee blank left EMPTY while 5.B carries a 7-day option period
  E2  p2   6.A(8) BOTH (i) and (ii) ticked - the printed text joins them with "; or"
  E3  p6   11     a repair obligation + an option-period extension in Special Provisions
  E4  p6/7 12     $9,000 put in 12A(1)(b), whose printed words exclude brokerage
                  compensation, while the 12B(1) box that would actually do it is unticked

Usage:
  python3 scripts/video-engine/build-autopsy-specimen.py --out <dir>
"""
import argparse
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FORM = REPO / "scripts" / "trec-forms" / "20-19.pdf"
DPI = 200
PAGE_W, PAGE_H = 1700, 2200

FONT = "DejaVu Sans"
INK = "&H6B3A1B&"           # #1B3A6B dark blue, BBGGRR - clearly not the form's black print
WM = "&HC72828C6"           # #C62828 at ~22% opacity

# page -> [(x, y, size, bold, text)]   x,y = glyph box top-left in page pixels
FILLS = {
    2: [
        # 5.A earnest money IS stated ...
        (852, 247, 30, 0, "3,000"),
        # ... and the option fee blank is deliberately left EMPTY        <<< ERROR 1
        # 5.B option period
        (250, 800, 30, 0, "7"),
        # 6.A(8) both sub-boxes ticked                                   <<< ERROR 2
        (222, 1702, 32, 1, "X"),
        (222, 1730, 32, 1, "X"),
        # the (ii) expense election, so (ii) reads as deliberate not a slip
        (1212, 1730, 32, 1, "X"),
    ],
    6: [
        # 11 Special Provisions carrying a repair + a modification       <<< ERROR 3
        (905, 1503, 26, 0, "Seller to replace roof"),
        (172, 1538, 26, 0, "prior to closing; option period extended to 14 days;"),
        (172, 1571, 26, 0, "sale contingent on buyer closing current home."),
        # 12.A(1)(b) concession                                          <<< ERROR 4 (part 1)
        (740, 1788, 30, 0, "9,000"),
    ],
    # page 7: 12.B(1) is left UNTICKED on purpose                        <<< ERROR 4 (part 2)
    7: [],
}

WATERMARK = "SPECIMEN - NOT A REAL CONTRACT"
HEADER = (
    "[Script Info]\n"
    "ScriptType: v4.00+\n"
    f"PlayResX: {PAGE_W}\n"
    f"PlayResY: {PAGE_H}\n"
    "WrapStyle: 2\n"
    "ScaledBorderAndShadow: yes\n\n"
    "[V4+ Styles]\n"
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
    "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
    "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    f"Style: fill,{FONT},30,{INK},{INK},{INK},{INK},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n"
    f"Style: wm,{FONT},46,{WM},{WM},{WM},{WM},1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n"
    "[Events]\n"
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
)


def ass_for(page: int) -> str:
    lines = [HEADER]
    for x, y, size, bold, text in FILLS.get(page, []):
        tag = f"{{\\pos({x},{y})\\fs{size}\\b{bold}}}"
        lines.append(f"Dialogue: 0,0:00:00.00,9:00:00.00,fill,,0,0,0,,{tag}{text}\n")
    for ypos in (520, 1240, 1960):
        tag = f"{{\\pos({PAGE_W // 2},{ypos})\\frz18}}"
        lines.append(f"Dialogue: 0,0:00:00.00,9:00:00.00,wm,,0,0,0,,{tag}{WATERMARK}\n")
    return "".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    raw = out / "_raw"
    raw.mkdir(exist_ok=True)

    if not FORM.exists():
        print(f"FATAL: blessed blank form missing at {FORM}", file=sys.stderr)
        return 1

    for page in sorted(FILLS):
        subprocess.run(
            ["pdftoppm", "-r", str(DPI), "-f", str(page), "-l", str(page), "-png",
             str(FORM), str(raw / "p")],
            check=True,
        )
        src = raw / f"p-{page:02d}.png"
        assf = raw / f"p{page}.ass"
        assf.write_text(ass_for(page), encoding="utf-8")
        dst = out / f"specimen-p{page}.png"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
             "-vf", f"ass={assf.as_posix()}", str(dst)],
            check=True,
        )
        print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
