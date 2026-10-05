#!/usr/bin/env python3
"""Build the screen-recording clips for the TREC 20-19 "autopsy" video.

Each error gets ONE clip that serves both phases of the format:

    0.0 -  3.5s   the region, no highlight    -> the hunt
    3.5 - 12.0s   gold highlight on the error -> the reveal

The shot list then uses two different in-points into the same file, which
halves the number of clips and guarantees the reveal is framed identically to
the hunt (a different framing would let the viewer find it by the cut rather
than by looking).

WHY A COMPOSED FRAME AND NOT A FULL PAGE
  docs/VIDEO-PRODUCTION-RECIPE.md §8 records the measurement that killed the
  obvious approach: a TREC paragraph at full line width lands around 13px of
  type on a 1080-wide frame, and a 2x pan across the real line was built and
  REJECTED because with 34 lines of contract on screen the viewer cannot find
  the one being quoted. A 9:16 crop of a 1700x2200 page is worse still -- the
  crop is 1.78x taller than it is wide, so framing one line means showing the
  whole page.

  So each frame here is a horizontal STRIP of the form -- the operative lines
  only -- scaled to the full 1080 width and floated on a dark canvas. That
  trades away the "whole page" look for type the eye can actually land on, and
  puts the strip in the upper-middle band, clear of the caption box.

  Honest limit: the strip carries the MARKS legibly (a ticked box, an empty
  blank beside a filled one, a block of typed-in text). It does not make the
  surrounding 10pt body text comfortably readable on a phone. The captions
  carry the words; the form carries the authority. That is the same division
  of labour §8 settled on.

Source is scripts/video-engine/build-autopsy-specimen.py's output, which is the
BLANK promulgated form plus an overlay. No real document is ever opened here.

Usage:
  python3 scripts/video-engine/build-autopsy-clips.py --specimen <dir> --out <dir>
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

W, H = 1080, 1920
FPS = 30
DUR = 12.0
REVEAL_AT = 3.5
CANVAS = "0x14141C"
GOLD = "0xF5C543"
STRIP_W = 1090                      # page px; scales to 1080 => 0.99083
S = W / float(STRIP_W)
BAND_CENTRE = 480                   # canvas y: strip centre, so the band clears the caption box
# Strip height is set by the CROP height, and the text scale is set by the crop
# WIDTH -- so a taller crop shows more surrounding contract at exactly the same
# legibility. The first build used h=464, which filled 24% of the frame and left
# a top-heavy composition with a dead lower half. 760 fills ~39% and buys real
# context: on error 1 it is the difference between seeing only the empty option
# fee blank and seeing the 7-day option period in 5.B in the SAME frame, which
# is the actual contradiction.

DATE = "2026-10-04"

# region: (page, x0, y0, h)  -- strip is always STRIP_W wide
# hl:     (x0, y0, x1, y1) in PAGE coordinates of that same page
ERRORS = [
    {
        "key": "trec-autopsy-e1-option-fee",
        "page": 2, "x0": 560, "y0": 120, "h": 800,
        "hl": [(1352, 240, 1584, 284)],
        # A second box on 5.B's "___ days" option period was tried and REMOVED.
        # 5.B's blank sits at page x~250 and the option fee blank at x~1370 --
        # 1300px apart, so no 1090-wide crop holds both, and the box rendered
        # over off-frame content: a highlight pointing at nothing. Widening the
        # crop to cover both drops the type scale to 0.72x, which is the
        # legibility failure this whole composition exists to avoid. The option
        # period is carried by the voiceover instead.
        "hunt": {"y0": 72, "h": 380},
        "scene": "TREC 20-19 p2 para 5.A -- earnest money stated, option fee blank EMPTY",
    },
    {
        "key": "trec-autopsy-e2-both-boxes",
        "page": 2, "x0": 140, "y0": 1351, "h": 760,
        "hl": [(202, 1690, 262, 1772)],
        "hunt": {"y0": 1541, "h": 380},
        "scene": "TREC 20-19 p2 para 6.A(8) -- both (i) and (ii) ticked",
    },
    {
        "key": "trec-autopsy-e3-special-provisions",
        "page": 6, "x0": 150, "y0": 1165, "h": 760,
        "hl": [(160, 1488, 1248, 1600)],
        "hunt": {"y0": 1354, "h": 380},
        "scene": "TREC 20-19 p6 para 11 -- repair + option extension written into Special Provisions",
    },
]

# Error 4 spans a page break, so it is a two-strip composite.
E4 = {
    "key": "trec-autopsy-e4-brokerage-contribution",
    "a": {"page": 6, "x0": 150, "y0": 1600, "h": 350},
    "b": {"page": 7, "x0": 150, "y0": 250, "h": 380},
    "hl_a": (688, 1778, 934, 1820),      # the $9,000 in 12A(1)(b)
    "hl_b": (168, 398, 208, 432),        # the UNticked 12B(1) box
    "gap": 10,
    "hunt_a": {"y0": 1700, "h": 150},
    "hunt_b": {"y0": 340, "h": 160},
    "scene": "TREC 20-19 paras 12A(1)(b) + 12B(1) -- contribution in the wrong blank, 12B(1) unticked",
}

ESTABLISH = {"key": "trec-autopsy-establishing", "page": 2,
             "scene": "TREC 20-19 page 2, specimen overlay, full page"}


def run(a):
    p = subprocess.run(a, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("FATAL: %s\n%s\n" % (" ".join(a[:6]), p.stderr[-1500:]))
        sys.exit(1)


def box(x0, y0, x1, y1, oy, src_y0, src_x0=150):
    """Page rect -> canvas drawbox args, given the strip's canvas origin `oy`."""
    cx = (x0 - src_x0) * S
    cy = oy + (y0 - src_y0) * S
    return (int(round(cx)), int(round(cy)),
            int(round((x1 - x0) * S)), int(round((y1 - y0) * S)))


def encode(png, out, boxes):
    """Static composed frame -> clip whose highlight(s) appear at REVEAL_AT.

    No zoom here: `motion` in the spec is the engine's job (render_shot applies
    zoompan), and keeping this frame static means the drawbox coordinates stay
    exact.
    """
    parts = ["drawbox=x=%d:y=%d:w=%d:h=%d:color=%s@0.95:t=6:enable='gte(t,%s)'"
             % (x, y, w, h, GOLD, REVEAL_AT) for (x, y, w, h) in boxes]
    vf = ",".join(parts + ["format=yuv420p"])
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-loop", "1", "-i", png,
         "-t", "%.2f" % DUR, "-r", str(FPS), "-vf", vf,
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", out])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--specimen", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    spec, out = Path(args.specimen), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "_tmp"
    tmp.mkdir(exist_ok=True)

    made = []

    # --- single-strip errors -------------------------------------------------
    for e in ERRORS:
        src = spec / ("specimen-p%d.png" % e["page"])
        strip = tmp / (e["key"] + ".strip.png")
        comp = tmp / (e["key"] + ".png")
        sh = int(round(e["h"] * S))
        oy = BAND_CENTRE - sh // 2
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
             "-vf", "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos"
             % (STRIP_W, e["h"], e["x0"], e["y0"], W, sh), str(strip)])
        run(["ffmpeg", "-nostdin", "-v", "error", "-y",
             "-f", "lavfi", "-i", "color=c=%s:s=%dx%d" % (CANVAS, W, H),
             "-i", str(strip), "-frames:v", "1",
             "-filter_complex", "[0][1]overlay=0:%d" % oy, str(comp)])
        hl = [box(*r, oy=oy, src_y0=e["y0"], src_x0=e["x0"]) for r in e["hl"]]
        dst = out / ("%s-mobile-%s.mp4" % (e["key"], DATE))
        encode(str(comp), str(dst), hl)
        made.append((dst, e["scene"]))

    # --- error 4: two strips across a page break ----------------------------
    a, b = E4["a"], E4["b"]
    sa, sb = int(round(a["h"] * S)), int(round(b["h"] * S))
    total = sa + E4["gap"] + sb
    oy = BAND_CENTRE - total // 2
    stripa, stripb = tmp / "e4a.png", tmp / "e4b.png"
    for d, dst_png in ((a, stripa), (b, stripb)):
        src = spec / ("specimen-p%d.png" % d["page"])
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
             "-vf", "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos"
             % (STRIP_W, d["h"], d["x0"], d["y0"], W,
                int(round(d["h"] * S))), str(dst_png)])
    comp4 = tmp / "e4.png"
    run(["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=c=%s:s=%dx%d" % (CANVAS, W, H),
         "-i", str(stripa), "-i", str(stripb), "-frames:v", "1",
         "-filter_complex",
         "[0][1]overlay=0:%d[t];[t][2]overlay=0:%d" % (oy, oy + sa + E4["gap"]),
         str(comp4)])
    hl_a = box(*E4["hl_a"], oy=oy, src_y0=a["y0"], src_x0=a["x0"])
    hl_b = box(*E4["hl_b"], oy=oy + sa + E4["gap"], src_y0=b["y0"], src_x0=b["x0"])
    dst4 = out / ("%s-mobile-%s.mp4" % (E4["key"], DATE))
    encode(str(comp4), str(dst4), [hl_a, hl_b])
    made.append((dst4, E4["scene"]))

    # --- 4-up hunt frame: all four regions at once --------------------------
    #
    # The hunt window is only ~3.6s of runtime. Cycling four separate regions
    # through it gives the viewer under a second each, which is not long enough
    # to actually look -- the instruction to pause would be decorative. Stacking
    # all four in ONE frame means the pause buys real scanning time, and the
    # viewer sees the same four regions they are about to be shown the answers
    # to, in the same order.
    # The reveal strips are 760px tall each; four of those do not fit in a
    # 1920 frame, so the hunt frame gets its own SHORTER crops, each centred on
    # its mark. Same width, so same text scale as the reveals.
    hunt_specs = [(e["key"], e["page"], e["x0"], e["hunt"]["y0"], e["hunt"]["h"]) for e in ERRORS]
    hunt_specs.append(("e4a", E4["a"]["page"], E4["a"]["x0"], E4["hunt_a"]["y0"], E4["hunt_a"]["h"]))
    hunt_specs.append(("e4b", E4["b"]["page"], E4["b"]["x0"], E4["hunt_b"]["y0"], E4["hunt_b"]["h"]))
    strips, heights = [], []
    for key, page, hx0, hy0, hh in hunt_specs:
        sp = tmp / ("hunt-%s.png" % key)
        sh = int(round(hh * S))
        run(["ffmpeg", "-nostdin", "-v", "error", "-y",
             "-i", str(spec / ("specimen-p%d.png" % page)),
             "-vf", "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos"
             % (STRIP_W, hh, hx0, hy0, W, sh), str(sp)])
        strips.append(sp)
        heights.append(sh)
    gap = 12
    total_h = sum(heights) + gap * (len(heights) - 1)
    if total_h > H:
        sys.stderr.write("FATAL: hunt 4-up is %dpx tall, frame is %d\n" % (total_h, H))
        sys.exit(1)
    y = (H - total_h) // 2
    inputs, filt, prev = [], [], "[0]"
    for i, sp in enumerate(strips):
        inputs += ["-i", str(sp)]
        filt.append("%s[%d]overlay=0:%d%s" % (prev, i + 1, y,
                    "[s%d]" % i if i < len(strips) - 1 else ""))
        prev = "[s%d]" % i
        y += heights[i] + (2 if i == len(heights) - 2 else gap)
    comph = tmp / "hunt4up.png"
    run(["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=c=%s:s=%dx%d" % (CANVAS, W, H)]
        + inputs + ["-frames:v", "1", "-filter_complex", ";".join(filt), str(comph)])
    dsth = out / ("trec-autopsy-hunt-4up-mobile-%s.mp4" % DATE)
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-loop", "1", "-i", str(comph),
         "-t", "%.2f" % DUR, "-r", str(FPS), "-vf", "format=yuv420p",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(dsth)])
    made.append((dsth, "all four regions stacked, NO highlight -- the hunt frame"))

    # --- establishing: the whole page, so it reads as a real contract -------
    src = spec / ("specimen-p%d.png" % ESTABLISH["page"])
    compe = tmp / "establish.png"
    run(["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=c=%s:s=%dx%d" % (CANVAS, W, H),
         "-i", str(src), "-frames:v", "1",
         "-filter_complex", "[1]scale=%d:-1:flags=lanczos[p];[0][p]overlay=0:(H-h)/2" % W,
         str(compe)])
    dste = out / ("%s-mobile-%s.mp4" % (ESTABLISH["key"], DATE))
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-loop", "1", "-i", str(compe),
         "-t", "%.2f" % DUR, "-r", str(FPS), "-vf", "format=yuv420p",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(dste)])
    made.append((dste, ESTABLISH["scene"]))

    print("wrote %d clips to %s" % (len(made), out))
    for p, scene in made:
        print("  %-62s %s" % (p.name, scene))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
