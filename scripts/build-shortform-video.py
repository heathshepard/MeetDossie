#!/usr/bin/env python3
"""Compose a vertical short-form video from real captured app frames + real voiceover.

BRAND-AGNOSTIC. This is the generalization of the Rust-only draft
(`scripts/build-rust-shortform-video.py`, written 2026-09-16 for the
`readiness-marcus` rebuild and never committed). Dossie, Rust and Heath's
realtor page all render through THIS file — there is deliberately only one
short-form builder in version control. Everything that used to be a Rust
constant (capture size, caption colours, the chat-composer geometry split) is
now a per-spec value with a safe default, so nothing about the Rust build
path changed behaviourally.

Implements the binary requirements in docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md
§5 / §5a:

  * hook-then-clear  - full-bleed animated hook card, gone by 3.0s
  * full-bleed real footage - captured at the source size (default 1170x2532,
    i.e. 390x844 @ dsf 3) from the LIVE app, cropped to 1080x1920, never a
    phone-bezel mockup
  * burned captions  - heavy sans (Plus Jakarta Sans Bold) via libass, bottom
    third, clear of TikTok's reserved bottom zone, verbatim == spoken audio.
    A serif is an automatic gate FAIL (§5a check 12) — Cormorant Garamond is
    a Dossie brand/heading face and is never a caption face.
  * voiceover        - real ElevenLabs audio + its character-timing JSON, as
    produced by scripts/gen-listing-voiceover.py (same JSON shape)
  * music bed        - 18-22 dB under the voice, licence-clean source only
  * CTA end card     - rendered here, per-brand

Cards (hook + CTA) are rendered by this script with ffmpeg drawtext rather
than shelled out to PIL: there is no PIL in this environment and no pip to
install one (local-toolchain-constraints). Text is passed via drawtext's
`textfile=` so punctuation never has to be shell/filter escaped.

Inputs are declared in a JSON spec (see --spec). Nothing here invents
dialogue: caption text is passed in verbatim and is asserted to match the
text that was sent to the TTS engine.

Usage:
  python3 scripts/build-shortform-video.py --spec /path/spec.json --out out.mp4 --work /tmp/work
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

W, H = 1080, 1920
FPS = 30

# Default capture geometry: 390x844 CSS px at deviceScaleFactor 3.
DEFAULT_SRC_W, DEFAULT_SRC_H = 1170, 2532

# TikTok reserved zones (playbook §1.2): top ~200px, bottom ~334-484px,
# right ~140px, left ~44px on a 1080x1920 canvas. Captions sit above the
# bottom reserved band with headroom.
DEFAULT_CAPTION_MARGIN_V = 500   # px from frame bottom to the caption box
DEFAULT_CAPTION_MARGIN_LR = 150  # keeps caption boxes out of the right-rail zone


def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        sys.stderr.write(" ".join(str(c) for c in cmd[:14]) + " ...\n")
        sys.stderr.write(p.stderr[-4000:] + "\n")
        raise SystemExit(f"command failed: {cmd[0]}")
    return p


def probe_duration(path):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)])
    return float(p.stdout.strip())


# ------------------------------------------------------------------ cards ----
CARD_RENDERER = Path(__file__).parent / "render-card-png.js"


def render_card(card, out_png, work):
    """Render one full-bleed 1080x1920 card PNG from an HTML source.

    card = {"html": "<path to .html>"}  or  {"html_inline": "<!doctype html>..."}

    Cards are HTML, not ffmpeg filtergraphs, because the static ffmpeg here
    has NO drawtext/drawbox filter (verified: "No such filter: 'drawtext'")
    and there is no PIL/pip either. See scripts/render-card-png.js for the
    full reasoning. HTML also means the hook card can use the real brand
    faces from public/fonts.

    A card is never text-alone-on-flat — playbook §5 item 3 requires a visual
    grab (a colour block, a rule, a highlight); that lives in the card's CSS.
    """
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    html_path = card.get("html")
    if not html_path:
        inline = card.get("html_inline")
        if not inline:
            raise SystemExit("card needs 'html' or 'html_inline'")
        html_path = work / f"{Path(out_png).stem}.html"
        Path(html_path).write_text(inline, encoding="utf-8")
    run(["node", str(CARD_RENDERER),
         "--html", str(html_path), "--out", str(out_png),
         "--width", str(W), "--height", str(H)])
    return out_png


# ---------------------------------------------------------------- frames ----
def pick_frame(frames, t_ms):
    """Nearest captured frame to a source timestamp (ms)."""
    return min(frames, key=lambda f: abs(f["ts"] - t_ms))


def build_sequence(frames, src0, src1, out_dur, seq_dir):
    """Materialise an FPS-rate frame sequence that maps source time
    [src0, src1] onto an output clip of out_dur seconds."""
    seq_dir.mkdir(parents=True, exist_ok=True)
    n = max(2, int(round(out_dur * FPS)))
    for i in range(n):
        t = src0 + (src1 - src0) * (i / (n - 1))
        src = pick_frame(frames, t)["f"]
        dst = seq_dir / f"{i:05d}.jpg"
        if dst.exists():
            dst.unlink()
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy(src, dst)
    return n


def geometry_filter(kind, crop_y, src_w, src_h, window_h, composer_h):
    """Vertical window into the capture, mapped to 1080x1920.

    `crop_y` is the top of the `window_h`-tall 9:16 window inside the capture.
    It is the one knob that keeps real app text OUT of the burned-caption band:
    a top-anchored list/thread means sliding the window DOWN lifts the last row
    above the caption box instead of shrinking the footage (playbook §5 item 9
    forbids shrinking it). Reads as ordinary scroll.
    """
    crop_y = max(0, min(crop_y, src_h - window_h))
    if kind == "content":
        # Content-only window: no pinned bottom bar.
        return f"crop={src_w}:{window_h}:0:{crop_y},scale={W}:{H}:flags=lanczos"
    if kind == "with_input":
        # Content + a pinned bottom bar (chat composer, tab bar): splice the
        # top (window_h - composer_h) onto the bottom composer_h so the bar
        # stays on screen. The seam falls in flat background, so it is
        # invisible; no content is removed or reordered.
        top_h = window_h - composer_h
        return (
            f"split[gA][gB];"
            f"[gA]crop={src_w}:{top_h}:0:{crop_y}[gt];"
            f"[gB]crop={src_w}:{composer_h}:0:{src_h - composer_h}[gb];"
            f"[gt][gb]vstack=inputs=2,scale={W}:{H}:flags=lanczos"
        )
    raise SystemExit(f"unknown geometry {kind}")


def segment_video(seq_dir, n_frames, geometry, zoom_to, out_path,
                  zoom_from=1.0, anchor="center", crop_y=0,
                  src_w=DEFAULT_SRC_W, src_h=DEFAULT_SRC_H,
                  window_h=2080, composer_h=380):
    vf = geometry_filter(geometry, crop_y, src_w, src_h, window_h, composer_h)
    if (zoom_to and zoom_to > 1.0) or zoom_from > 1.0:
        # Linear punch-in across the segment (playbook §4.3). A top anchor
        # keeps a top-aligned list filling the frame instead of drifting into
        # the empty tail below the last row.
        zt = zoom_to or zoom_from
        y = "0" if anchor == "top" else "ih/2-(ih/zoom/2)"
        vf += (
            f",zoompan=z='{zoom_from:.4f}+{zt - zoom_from:.4f}*on/{max(1, n_frames - 1)}'"
            f":d=1:x='iw/2-(iw/zoom/2)':y='{y}':s={W}x{H}:fps={FPS}"
        )
    vf += ",setsar=1,format=yuv420p"
    run(["ffmpeg", "-y", "-v", "error",
         "-framerate", str(FPS), "-i", str(seq_dir / "%05d.jpg"),
         "-vf", vf, "-r", str(FPS),
         "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
         str(out_path)])


def card_video(pngs, out_path, zoom_from=1.0, zoom_to=1.0):
    """pngs: [(path, seconds), ...] rendered as one clip with a continuous
    punch-in so there is real motion at frame 0 (playbook §5 item 1, and
    §5a check 1 / the real_motion_0_to_1_5s SSIM rule)."""
    seq = out_path.parent / (out_path.stem + "_seq")
    if seq.exists():
        shutil.rmtree(seq)
    seq.mkdir(parents=True, exist_ok=True)
    cache = {}
    i = 0
    for png, dur in pngs:
        if png not in cache:
            tmp = out_path.parent / (Path(png).stem + "_tmp.jpg")
            run(["ffmpeg", "-y", "-v", "error", "-i", str(png),
                 "-frames:v", "1", "-q:v", "2", str(tmp)])
            cache[png] = tmp
        for _ in range(int(round(dur * FPS))):
            dst = seq / f"{i:05d}.jpg"
            try:
                os.link(cache[png], dst)
            except OSError:
                shutil.copy(cache[png], dst)
            i += 1
    n = i
    vf = (f"zoompan=z='{zoom_from:.4f}+{zoom_to - zoom_from:.4f}*on/{max(1, n - 1)}'"
          f":d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS}"
          f",setsar=1,format=yuv420p")
    run(["ffmpeg", "-y", "-v", "error",
         "-framerate", str(FPS), "-i", str(seq / "%05d.jpg"),
         "-vf", vf, "-r", str(FPS),
         "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
         str(out_path)])
    return n / FPS


# -------------------------------------------------------------- captions ----
def phrase_cues(timing_path, start_s, text_assert, max_words=5):
    """Group an ElevenLabs character-timing JSON into short caption phrases.
    Returns [(start, end, text)] in OUTPUT-timeline seconds.

    Raises on any drift between the caption text and what was actually spoken
    — playbook §5a check 11 is enforced HERE, in code, not by review."""
    d = json.loads(Path(timing_path).read_text(encoding="utf-8"))
    chars, cs, ce = d["characters"], d["char_start"], d["char_end"]
    spoken = "".join(chars)
    if text_assert.strip() != spoken.strip():
        raise SystemExit(
            "caption/audio mismatch - captions must be verbatim what was spoken.\n"
            f"  spoken : {spoken!r}\n  caption: {text_assert!r}")
    cues, buf, w0, w1, words = [], "", None, None, 0
    i = 0
    while i < len(chars):
        ch = chars[i]
        if w0 is None:
            w0 = cs[i]
        buf += ch
        w1 = ce[i]
        boundary = ch == " "
        hard = ch in ".?!" or (ch == "," and words >= max_words - 1)
        if boundary:
            words += 1
        if (words >= max_words and boundary) or hard:
            t = buf.strip()
            if t:
                cues.append([start_s + w0, start_s + w1, t])
            buf, w0, w1, words = "", None, None, 0
        i += 1
    if buf.strip():
        cues.append([start_s + (w0 or 0.0), start_s + (w1 or 0.0), buf.strip()])
    return cues


def ts(t):
    t = max(0.0, t)
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def write_ass(cues, out_path, style):
    """cues: [(start, end, text, speaker)] on the output timeline."""
    cues = sorted(cues, key=lambda c: c[0])
    for i in range(len(cues) - 1):
        # Bridge EVERY gap: §5a check 3 requires continuous cue coverage with
        # no hole longer than 0.3s, and a held last-phrase reads naturally.
        if cues[i + 1][0] > cues[i][1]:
            cues[i][1] = cues[i + 1][0]

    def ass_colour(hexstr, alpha="00"):
        """#RRGGBB -> &HAABBGGRR (libass is BGR with a leading alpha)."""
        h = hexstr.lstrip("#")
        return f"&H{alpha}{h[4:6]}{h[2:4]}{h[0:2]}"

    font = style.get("font", "Plus Jakarta Sans")
    size = style.get("size", 64)
    primary = ass_colour(style.get("primary", "#FFFFFF"))
    outline = ass_colour(style.get("outline", "#120C0A"))
    back = ass_colour(style.get("back", "#000000"), alpha="D0")
    mv = style.get("margin_v", DEFAULT_CAPTION_MARGIN_V)
    mlr = style.get("margin_lr", DEFAULT_CAPTION_MARGIN_LR)

    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},{size},{primary},{primary},{outline},{back},-1,0,0,0,100,100,0,0,3,14,0,2,{mlr},{mlr},{mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for st, en, tx, who in cues:
        tx = tx.replace("\n", " ").replace("{", "(").replace("}", ")")
        lines.append(f"Dialogue: 0,{ts(st)},{ts(en)},Cap,,0,0,0,,{tx}")
    Path(out_path).write_text(head + "\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------ main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--cover-out", help="also write the hook card as the explicit cover asset")
    args = ap.parse_args()

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    work = Path(args.work); work.mkdir(parents=True, exist_ok=True)
    frames = json.loads(Path(spec["frames_json"]).read_text(encoding="utf-8"))["frames"]

    source = spec.get("source", {})
    src_w = source.get("w", DEFAULT_SRC_W)
    src_h = source.get("h", DEFAULT_SRC_H)
    window_h = source.get("window_h", 2080)
    composer_h = source.get("composer_h", 380)
    fontsdir = spec["fontsdir"]

    # ---- render any declarative cards up front ----
    card_pngs = {}
    for name, card in (spec.get("cards") or {}).items():
        png = work / f"card-{name}.png"
        render_card(card, png, work)
        card_pngs[name] = str(png)
        print(f"[card] {name} -> {png.name}")

    # ---- video segments ----
    parts = []
    for seg in spec["segments"]:
        out = work / f"seg-{seg['name']}.mp4"
        if seg["kind"] == "card":
            pngs = [(card_pngs.get(p, p), d) for p, d in seg["pngs"]]
            dur = card_video(pngs, out,
                             zoom_from=seg.get("zoom_from", 1.0),
                             zoom_to=seg.get("zoom_to", 1.0))
        else:
            seq = work / f"seq-{seg['name']}"
            if seq.exists():
                shutil.rmtree(seq)
            n = build_sequence(frames, seg["src0"], seg["src1"], seg["dur"], seq)
            segment_video(seq, n, seg["geometry"], seg.get("zoom_to"), out,
                          zoom_from=seg.get("zoom_from", 1.0),
                          anchor=seg.get("anchor", "center"),
                          crop_y=seg.get("crop_y", 0),
                          src_w=src_w, src_h=src_h,
                          window_h=window_h, composer_h=composer_h)
            dur = seg["dur"]
        parts.append((out, dur))
        print(f"[seg] {seg['name']:<10} {dur:6.2f}s -> {out.name}")

    concat = work / "concat.txt"
    concat.write_text("".join(f"file '{p.as_posix()}'\n" for p, _ in parts), encoding="utf-8")
    silent = work / "silent.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat),
         "-c", "copy", str(silent)])
    total = probe_duration(silent)
    print(f"[video] silent master {total:.2f}s")

    # ---- audio: voice clips at fixed offsets + music bed under them ----
    inputs, filters, mixed = [], [], []
    for i, vo in enumerate(spec["voice"]):
        inputs += ["-i", vo["mp3"]]
        filters.append(f"[{i}:a]aresample=48000,adelay={int(vo['at'] * 1000)}|{int(vo['at'] * 1000)},"
                       f"volume={vo.get('gain', 1.0)}[v{i}]")
        mixed.append(f"[v{i}]")
    nv = len(spec["voice"])
    music = spec.get("music")
    filters.append("".join(mixed) + f"amix=inputs={nv}:duration=longest:normalize=0,"
                                    f"loudnorm=I=-15:TP=-1.5:LRA=11,"
                                    f"aresample=48000,apad,atrim=0:{total:.3f}[vox]")
    if music:
        inputs += ["-i", music["file"]]
        filters.append(
            f"[{nv}:a]aresample=48000,aloop=loop=-1:size=2e9,atrim=0:{total:.3f},"
            f"lowpass=f={music.get('lowpass', 5000)},highpass=f=90,"
            f"loudnorm=I={music['lufs']}:TP=-6:LRA=7,"
            f"afade=t=in:st=0:d=1.2,afade=t=out:st={total - 1.6:.3f}:d=1.6[bed]")
        filters.append("[vox][bed]amix=inputs=2:duration=first:normalize=0[aout]")
    else:
        filters.append("[vox]anull[aout]")

    audio = work / "audio.m4a"
    run(["ffmpeg", "-y", "-v", "error", *inputs,
         "-filter_complex", ";".join(filters), "-map", "[aout]",
         "-t", f"{total:.3f}",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(audio)])
    print(f"[audio] {probe_duration(audio):.2f}s")

    # ---- captions ----
    cues = []
    for vo in spec["voice"]:
        c = phrase_cues(vo["timing"], vo["at"], vo["text"],
                        max_words=spec.get("captions", {}).get("max_words", 5))
        cues += [[a, b, t, vo.get("speaker", "vo")] for a, b, t in c]
    ass = work / "captions.ass"
    write_ass(cues, ass, spec.get("captions", {}))

    run(["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-i", str(audio),
         "-filter_complex",
         f"[0:v]subtitles={ass.as_posix()}:fontsdir={fontsdir}[v]",
         "-map", "[v]", "-map", "1:a",
         "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
         args.out])

    # The cover is the hook card itself — §5 item 7 / §5a check 4 require an
    # explicit cover carrying the hook claim at >=1080x1920, same aspect.
    if args.cover_out:
        cover_src = spec.get("cover_card")
        if not cover_src:
            raise SystemExit("--cover-out given but spec has no 'cover_card'")
        shutil.copy(card_pngs.get(cover_src, cover_src), args.cover_out)
        print(f"[cover] {args.cover_out}")

    print(f"[done] {args.out}  {probe_duration(args.out):.2f}s")


if __name__ == "__main__":
    main()
