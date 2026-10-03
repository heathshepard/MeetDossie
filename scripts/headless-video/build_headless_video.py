#!/usr/bin/env python3
"""Headless video lane -- script -> voice -> footage -> captioned video.

"Headless" means no camera time from Heath: the voice is a cloned/professional
ElevenLabs voice, the pictures are footage we already own, and the captions are
derived from the audio we just synthesised. One spec file in, one finished
1080x1920 master + covers out.

    python3 scripts/headless-video/build_headless_video.py specs/<name>.json

Everything that is a *policy* decision lives in this file and is enforced in
code, so a future run cannot quietly violate it:

  * Brand/voice guard -- Heath's clone (i41TA0Q36AUrp4axERi3) is allowed on
    realtor-brand content only. A spec with brand="dossie" that names the clone
    aborts. See memory heath-voice-clone-usage-scope.md. (CLAUDE.md §2 and that
    memory both record Luna's id as lxYfHSkYm1EzQzGhdbfc, which the live
    ElevenLabs /v1/voices listing shows is "Jessica Anne Bogart" -- a different
    voice. The real Luna is 6rOxfAnZpbM3VIEhFaeV and is set in the specs.)
  * Privacy gate -- every clip named in a spec is looked up in its library's
    index and must be marked `clear`. A `flagged:` row aborts the build. This
    re-implements the gate in select_local_broll_entries() for a hand-authored
    shot list, which bypasses that selector entirely.
  * Caption style -- the Style line, the pop-in and the 3-word / 19-char / 0.4s
    chunking are copied verbatim from the approved v9 build and must not be
    altered. founder-video-production-standard.md §4.
  * Audio -- music ducked ~18-19 dB under the voice by the same sidechain
    chain as v9, final mix -14 LUFS / -1.5 dBTP, real decay tail at the end.

Caption timing comes from ElevenLabs' /with-timestamps response, i.e. the
alignment of the exact audio samples that get concatenated into the master.
The production standard asks for captions derived from the *finished* audio so
drift is structurally impossible; this is that guarantee by construction
rather than by re-transcription.

Stdlib only -- this box has no numpy/PIL/librosa and no pip.
"""

import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave

# --------------------------------------------------------------------------
# paths / constants
# --------------------------------------------------------------------------

REPO = "/mnt/c/Users/Heath/Projects/MeetDossie"
MEDIA = os.path.join(REPO, "Media")
MUSIC_DIR = os.path.join(MEDIA, "Music")
BROLL_DIR = os.path.join(MEDIA, "b-roll", "boerne")
SCREENREC_DIR = os.path.join(MEDIA, "screen-recordings")
OUT_ROOT = os.path.join(MEDIA, "headless-videos")
# Intermediates stay on the native filesystem. /mnt/ is both slow and the thing
# produce-doc-explainer.js hard-refuses to stage frames on. Only finished
# artifacts are written back into Media/ (which is gitignored).
WORK_ROOT = "/home/heath/mw/headless"

HEATH_CLONE = "i41TA0Q36AUrp4axERi3"
LUNA = "6rOxfAnZpbM3VIEhFaeV"

EL_TTS = "https://api.elevenlabs.io/v1/text-to-speech/%s/with-timestamps?output_format=mp3_44100_128"

FPS = 30
TAIL = 0.33          # real decay tail; a cut to digital silence reads as truncation

# LOCKED -- founder-video-production-standard.md §4. Do not alter.
CAP_STYLE = ("Style: Cap,Plus Jakarta Sans ExtraBold,80,&H00FFFFFF,&H00FFFFFF,"
             "&H00101010,&H00101010,-1,0,0,0,100,100,1,0,3,20,0,2,80,80,1005,1")
POP = r'{\fad(40,60)\t(0,90,\fscx105\fscy105)\t(90,160,\fscx100\fscy100)}'
ACC = r'{\c&H43C5F5&}'      # BGR gold accent
WHT = r'{\c&HFFFFFF&}'

ASS_HDR = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
%s
%s

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

# Hook sits high (Alignment 8 = top-centre) so it never collides with the
# caption band at MarginV 1005, and carries NO \fad -- it must be fully opaque
# in frame 0.
#
# The CTA is ALSO top-anchored (Alignment 8, lower MarginV). The obvious place
# for it is bottom-centre, but the CTA is spoken, so its own captions are on
# screen at the same moment -- at MarginV 1005 the card would land exactly on
# top of them. Anchoring it in the upper third keeps both readable, which is
# what "CTA clear of frame" is actually protecting.
HOOK_STYLE = ("Style: Hook,Plus Jakarta Sans ExtraBold,86,&H00FFFFFF,&H00FFFFFF,"
              "&H00101010,&H00101010,-1,0,0,0,100,100,1,0,3,22,0,8,70,70,170,1")
CTA_STYLE = ("Style: Cta,Plus Jakarta Sans ExtraBold,66,&H00FFFFFF,&H00FFFFFF,"
             "&H002E1A1A,&H002E1A1A,-1,0,0,0,100,100,1,0,3,20,0,8,90,90,300,1")


def die(msg):
    sys.stderr.write("FATAL: %s\n" % msg)
    sys.exit(1)


def run(args, **kw):
    p = subprocess.run(args, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        die("command failed: %s\n%s" % (" ".join(args[:8]), (p.stderr or "")[-2500:]))
    return p.stdout


def ffprobe_dur(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path])
    return float(out.strip())


def ffprobe_wh(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height",
               "-of", "csv=s=x:p=0", path]).strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


# --------------------------------------------------------------------------
# privacy gate
# --------------------------------------------------------------------------

def parse_library(md_path):
    """Return {filename: privacy_string} for every row of a library index.

    Both Media/b-roll/boerne/LIBRARY.md and Media/screen-recordings/LIBRARY.md
    use a markdown table whose first cell is the filename. The b-roll index has
    a dedicated Privacy column; the screen-recording index does not, so a row
    found there is treated as `clear` (its own gate is that a flagged recording
    is never added to the table -- composite backgrounds live in a subdirectory
    precisely so no pipeline can pick them up).
    """
    if not os.path.exists(md_path):
        die("library index missing: %s" % md_path)
    rows = {}
    for line in open(md_path, encoding="utf-8"):
        if not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells or not cells[0].endswith(".mp4"):
            continue
        priv = "clear"
        for c in cells[1:]:
            if c == "clear" or c.startswith("flagged"):
                priv = c
                break
        rows[os.path.basename(cells[0])] = priv
    if not rows:
        die("parsed 0 rows from %s" % md_path)
    return rows


def resolve_clip(name):
    """Map a spec clip name to an absolute path + run the privacy gate."""
    for d, md in ((BROLL_DIR, os.path.join(BROLL_DIR, "LIBRARY.md")),
                  (SCREENREC_DIR, os.path.join(SCREENREC_DIR, "LIBRARY.md"))):
        p = os.path.join(d, name)
        if os.path.exists(p):
            priv = parse_library(md).get(name)
            if priv is None:
                die("clip %s is on disk but NOT indexed in %s -- unindexed "
                    "footage is never postable" % (name, md))
            if priv != "clear":
                die("PRIVACY GATE: %s is '%s' in %s. Flagged footage is never "
                    "auto-selected or hand-selected into a post." % (name, priv, md))
            return p, priv
    die("clip not found in any library: %s" % name)


# --------------------------------------------------------------------------
# text-to-speech with word timings
# --------------------------------------------------------------------------

def el_key():
    for name in ("ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY_PERSONAL"):
        v = os.environ.get(name)
        if v:
            return v.strip()
    env = os.path.join(REPO, ".env.local")
    if os.path.exists(env):
        # .env.local can carry a UTF-8 BOM that corrupts the first var
        for line in open(env, encoding="utf-8-sig"):
            if line.startswith("ELEVENLABS_API_KEY="):
                return line.split("=", 1)[1].strip()
    die("no ELEVENLABS_API_KEY available")


def tts_beat(text, voice_id, model_id, settings, out_mp3, out_json):
    """POST one beat and keep both the audio and its character alignment."""
    body = json.dumps({"text": text, "model_id": model_id,
                       "voice_settings": settings}).encode("utf-8")
    req = out_json + ".req"
    open(req, "wb").write(body)
    raw = out_json + ".raw"
    code = subprocess.run(
        ["curl", "-s", "-w", "%{http_code}", "-X", "POST", EL_TTS % voice_id,
         "-H", "xi-api-key: " + el_key(), "-H", "Content-Type: application/json",
         "-d", "@" + req, "-o", raw],
        capture_output=True, text=True).stdout.strip()
    os.remove(req)
    if code != "200":
        detail = ""
        try:
            detail = open(raw, encoding="utf-8", errors="replace").read()[:600]
        except Exception:
            pass
        die("ElevenLabs HTTP %s for beat %r\n%s" % (code, text[:60], detail))
    d = json.load(open(raw, encoding="utf-8"))
    open(out_mp3, "wb").write(base64.b64decode(d["audio_base64"]))
    # `alignment` is indexed against the ORIGINAL input string, so the words it
    # yields are exactly the words written in the spec -- which is what the
    # captions must show. `normalized_alignment` is against ElevenLabs'
    # preprocessed text (numbers expanded etc.) and would not match.
    al = d.get("alignment") or d.get("normalized_alignment")
    if not al:
        die("no alignment returned for beat %r" % text[:60])
    json.dump(al, open(out_json, "w"))
    os.remove(raw)
    return al


def words_from_alignment(al):
    """Collapse a character alignment into word spans."""
    chars = al["characters"]
    st = al["character_start_times_seconds"]
    en = al["character_end_times_seconds"]
    words, cur, cs, ce = [], "", None, None
    for ch, a, b in zip(chars, st, en):
        if ch.isspace():
            if cur.strip():
                words.append({"text": cur, "start": cs, "end": ce})
            cur, cs, ce = "", None, None
            continue
        if cs is None:
            cs = a
        ce = b
        cur += ch
    if cur.strip():
        words.append({"text": cur, "start": cs, "end": ce})
    # strip punctuation-only tokens and tidy the visible text
    out = []
    for w in words:
        t = w["text"].strip()
        if not re.search(r"[A-Za-z0-9]", t):
            continue
        out.append({"text": t, "start": float(w["start"]), "end": float(w["end"])})
    return out


# --------------------------------------------------------------------------
# voice assembly
# --------------------------------------------------------------------------

def to_wav(src, dst, speed=1.0):
    af = "aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo"
    if abs(speed - 1.0) > 1e-6:
        af = "atempo=%.6f," % speed + af
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
         "-af", af, "-c:a", "pcm_s16le", dst])


def assemble_voice(beats, work, spec):
    """Lay each beat on one timeline with its own trailing gap.

    Returns (voice_wav_path, words, total_voice_dur). `words` carries absolute
    timings on the finished voice track.
    """
    speed = float(spec.get("speed", 1.0))
    default_gap = float(spec.get("default_gap", 0.20))
    placed, words, t = [], [], 0.0
    for i, b in enumerate(beats):
        # Cache key is a hash of everything that changes the AUDIO, not the beat
        # index. Keying on index means editing a line silently reuses the old
        # take -- the captions would then describe audio that is no longer there.
        sig = hashlib.sha1(json.dumps(
            [b["text"], spec["voice_id"], spec["model_id"], spec["voice_settings"]],
            sort_keys=True).encode("utf-8")).hexdigest()[:12]
        mp3 = os.path.join(work, "beat%02d.%s.mp3" % (i, sig))
        aln = os.path.join(work, "beat%02d.%s.align.json" % (i, sig))
        wav = os.path.join(work, "beat%02d.%s.wav" % (i, sig))
        if os.path.exists(aln) and os.path.exists(mp3):
            al = json.load(open(aln))           # resume -- TTS costs credits
        else:
            al = tts_beat(b["text"], spec["voice_id"], spec["model_id"],
                          spec["voice_settings"], mp3, aln)
        to_wav(mp3, wav, speed)
        dur = ffprobe_dur(wav)
        for w in words_from_alignment(al):
            words.append({"text": w["text"],
                          "start": t + w["start"] / speed,
                          "end": t + w["end"] / speed,
                          "beat": b.get("id", str(i))})
        placed.append((wav, t, dur))
        gap = float(b.get("gap_after", default_gap))
        t += dur + gap
        print("  beat %-9s %5.2fs  -> ends %6.2f  (+%.2f gap)  %s"
              % (b.get("id", i), dur, t - gap, gap, b["text"][:52]))
    total = t - float(beats[-1].get("gap_after", default_gap))
    # clamp any alignment overrun onto the real audio length
    for w in words:
        w["end"] = min(w["end"], total)
        w["start"] = min(w["start"], w["end"])

    out = os.path.join(work, "voice.wav")
    inputs, filt = [], []
    for i, (wav, off, _d) in enumerate(placed):
        inputs += ["-i", wav]
        filt.append("[%d:a]adelay=%d|%d[a%d]" % (i, int(off * 1000), int(off * 1000), i))
    mix = "".join("[a%d]" % i for i in range(len(placed)))
    filt.append("%samix=inputs=%d:duration=longest:normalize=0,"
                "aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[vo]"
                % (mix, len(placed)))
    run(["ffmpeg", "-nostdin", "-v", "error", "-y"] + inputs +
        ["-filter_complex", ";".join(filt), "-map", "[vo]",
         "-c:a", "pcm_s16le", out])
    return out, words, ffprobe_dur(out)


# --------------------------------------------------------------------------
# captions
# --------------------------------------------------------------------------

def apply_rewrites(words, rules):
    """Collapse a spoken phrase into the way it should be WRITTEN on screen.

    A paragraph citation has to be spoken "paragraph five E" for the voice to
    say it correctly, but on screen the practising agent is scanning for
    "5.E" -- shorter, and how the form prints it. v9 hard-coded one such fix
    ("three" -> "3" before days); this generalises it so a new script declares
    its own in the spec instead of needing a code change.

    Each rule is [spoken_phrase, written_text]. The matched run keeps its own
    start/end, so the timing still comes from the audio.
    """
    if not rules:
        return words
    norm = [(r[0].lower().split(), r[1]) for r in rules]
    out, i = [], 0
    while i < len(words):
        hit = None
        for phrase, repl in norm:
            n = len(phrase)
            if i + n > len(words):
                continue
            got = [re.sub(r"[^a-z0-9]", "", words[i + k]["text"].lower())
                   for k in range(n)]
            want = [re.sub(r"[^a-z0-9]", "", p) for p in phrase]
            if got == want:
                hit = (n, repl)
                break
        if hit:
            n, repl = hit
            out.append({"text": repl, "start": words[i]["start"],
                        "end": words[i + n - 1]["end"]})
            i += n
        else:
            out.append(words[i])
            i += 1
    return out


def build_captions(words, suppress_until, accent, out_ass, rewrites=None):
    """3-word / 19-char / 0.4s chunking + the locked pop-in. Verbatim v9 logic."""
    words = apply_rewrites(words, rewrites)
    ws = [{"text": w["text"].replace('"', "").replace("'", "’"),
           "start": w["start"], "end": w["end"]} for w in words]
    chunks, cur = [], []
    for w in ws:
        if cur:
            gap = w["start"] - cur[-1]["end"]
            txt = " ".join(x["text"] for x in cur)
            if len(cur) >= 3 or len(txt) >= 19 or gap > 0.4:
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)

    BRIDGE = 0.60
    ev = []
    for ci, c in enumerate(chunks):
        s = c[0]["start"]
        e = c[-1]["end"] + 0.12
        if ci + 1 < len(chunks):
            nxt = chunks[ci + 1][0]["start"]
            e = (nxt - 0.02) if (nxt - c[-1]["end"]) < BRIDGE else min(e, nxt - 0.02)
        if e <= s:
            e = s + 0.25
        if e <= suppress_until:
            continue
        s = max(s, suppress_until)
        parts = []
        for w in c:
            clean = re.sub(r"[^A-Za-z0-9%’]", "", w["text"]).upper()
            t = w["text"].upper()
            parts.append(ACC + t + WHT if clean in accent else t)
        ev.append("Dialogue: 0,%s,%s,Cap,,0,0,0,,%s%s"
                  % (ts(s), ts(e), POP, " ".join(parts)))
    open(out_ass, "w", encoding="utf-8").write(
        (ASS_HDR % (CAP_STYLE, "")) + "\n".join(ev) + "\n")
    return chunks, ev


def ts(t):
    t = max(0.0, t)
    return "%d:%02d:%05.2f" % (int(t // 3600), int(t % 3600 // 60), t % 60)


def build_cards(spec, total, out_ass):
    """Hook card (frame 0, no fade) + CTA card, both in libass."""
    ev = []
    hook = spec.get("hook_card")
    if hook:
        txt = r"\N".join(l.upper() for l in hook["lines"])
        # No \fad and no \t -- fully visible in frame 0 by construction.
        ev.append("Dialogue: 0,%s,%s,Hook,,0,0,0,,%s"
                  % (ts(0.0), ts(float(hook["until"])), txt))
    cta = spec.get("cta_card")
    if cta:
        start = total - float(cta.get("from_end", 3.0))
        txt = r"\N".join(l.upper() for l in cta["lines"])
        ev.append("Dialogue: 0,%s,%s,Cta,,0,0,0,,%s%s"
                  % (ts(start), ts(total), POP, txt))
    open(out_ass, "w", encoding="utf-8").write(
        (ASS_HDR % (HOOK_STYLE, CTA_STYLE)) + "\n".join(ev) + "\n")
    return ev


# --------------------------------------------------------------------------
# picture
# --------------------------------------------------------------------------

def render_shot(clip, tin, dur, motion, w, h, dst, src_crop=None):
    """One cut, normalised to the target frame. Scale-to-fill then centre crop.

    `src_crop` ("W:H:X:Y") selects a region of the SOURCE first. Needed because
    dossier-deadlines-mobile-2026-09-30.mp4 is a 540x960 capture padded into a
    1080x1920 canvas with grey 128 -- measured, not guessed. Without the crop the
    app renders into one corner of the frame and three quarters of the video is
    flat grey.
    """
    cw, ch = ffprobe_wh(clip)
    pre = ""
    if src_crop:
        pre = "crop=%s," % src_crop
        cw, ch = [int(v) for v in src_crop.split(":")[:2]]
    scale = max(float(w) / cw, float(h) / ch)
    sw, sh = int(math.ceil(cw * scale / 2) * 2), int(math.ceil(ch * scale / 2) * 2)
    vf = (pre + "scale=%d:%d:flags=lanczos,crop=%d:%d:(iw-%d)/2:(ih-%d)/2,"
          "fps=%d,setsar=1" % (sw, sh, w, h, w, h, FPS))
    if motion == "push":
        n = max(2, int(round(dur * FPS)))
        vf += (",zoompan=z='1+0.10*on/%d':d=1:x='iw/2-(iw/zoom/2)':"
               "y='ih/2-(ih/zoom/2)':s=%dx%d:fps=%d" % (n, w, h, FPS))
    elif motion == "pull":
        n = max(2, int(round(dur * FPS)))
        vf += (",zoompan=z='1.10-0.10*on/%d':d=1:x='iw/2-(iw/zoom/2)':"
               "y='ih/2-(ih/zoom/2)':s=%dx%d:fps=%d" % (n, w, h, FPS))
    run(["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-display_rotation", "0",            # the GX010181 rotation trap
         "-ss", "%.3f" % tin, "-t", "%.3f" % dur, "-i", clip,
         "-an", "-vf", vf, "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", dst])
    return ffprobe_dur(dst)


def build_picture(spec, total, work):
    """Walk the shot list, cycling it if the script outruns it, to fill `total`.

    Keeping the fill logic here is what makes the lane reusable: a new script
    next week changes the runtime, and the shot list adapts instead of needing
    to be re-timed by hand.
    """
    w, h = spec.get("width", 1080), spec.get("height", 1920)
    shots = spec["shots"]
    for s in shots:
        s["_path"], s["_priv"] = resolve_clip(s["clip"])
        s["_srcdur"] = ffprobe_dur(s["_path"])

    plan, t, i, reuse = [], 0.0, 0, {}
    while t < total - 0.05:
        s = shots[i % len(shots)]
        k = i % len(shots)
        want = float(s.get("dur", 2.0))
        want = min(want, total - t)
        if want < 0.5 and plan:                  # don't leave a stub cut
            plan[-1][2] += want
            t += want
            break
        # rotate the in-point on reuse so a repeated clip is not an identical shot
        base = float(s.get("in", 0.0))
        rot = reuse.get(k, 0)
        tin = base + rot * want
        if tin + want > s["_srcdur"]:
            tin = max(0.0, min(base, s["_srcdur"] - want))
        reuse[k] = rot + 1
        plan.append([s, tin, want, s.get("motion", "none")])
        t += want
        i += 1

    files, total_cut = [], 0.0
    print("  %d cuts, mean %.2fs:" % (len(plan), total / max(1, len(plan))))
    for n, (s, tin, dur, motion) in enumerate(plan):
        dst = os.path.join(work, "shot%03d.mp4" % n)
        got = render_shot(s["_path"], tin, dur, motion, w, h, dst,
                          s.get("src_crop"))
        files.append(dst)
        total_cut += got
        print("    %02d %5.2fs %-6s %-22s %s" % (n, got, motion,
              s.get("label", "")[:22], s["clip"]))
    lst = os.path.join(work, "concat.txt")
    open(lst, "w").write("".join("file '%s'\n" % f for f in files))
    pic = os.path.join(work, "picture.mp4")
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", lst, "-c", "copy", pic])
    return pic, plan, total_cut


def burn(pic, cap_ass, card_ass, total, work):
    out = os.path.join(work, "burned.mp4")
    fonts = "/home/heath/.local/share/fonts"
    vf = ("subtitles=%s:fontsdir=%s,subtitles=%s:fontsdir=%s"
          % (cap_ass, fonts, card_ass, fonts))
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", pic,
         "-t", "%.3f" % total, "-vf", vf, "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", "-an", out])
    return out


# --------------------------------------------------------------------------
# audio mix + mux
# --------------------------------------------------------------------------

def audio_stems(spec, total, vi, mi):
    """The voice + ducked-music filter graph, built ONCE.

    mux() and measure_duck() must apply byte-identical processing or the
    measurement stops describing the thing that shipped. `vi`/`mi` are the input
    indexes for voice and music.

    The bed is loudnorm'd BEFORE the duck. Without that, a fixed `volume=-7dB`
    leaves the music's own loud passages loud, and the measured duck swung from
    0.8 dB to 15.2 dB across one 32s render -- the sidechain can only pull down
    relative to what it is handed. Levelling the bed first makes the duck depth
    a property of the chain rather than of which 30 seconds of the track got used.
    """
    gain = float(spec.get("music_gain_db", -7))
    lufs = float(spec.get("music_lufs", -26))
    fo = round(total - 1.9, 3)
    vfade = max(0.0, total - TAIL - 0.12)
    return (
        "[%(VI)d:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
        "highpass=f=80,loudnorm=I=%(VL).1f:TP=-3:LRA=11,"
        "apad=whole_dur=%(T).3f,afade=t=out:st=%(VF).3f:d=0.125,"
        "atrim=0:%(T).3f,asetpts=PTS-STARTPTS,asplit=2[vx][vk];"
        "[%(MI)d:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
        "atrim=0:%(T).3f,asetpts=PTS-STARTPTS,"
        "loudnorm=I=%(L).1f:TP=-6:LRA=7,volume=%(G).1fdB,"
        "afade=t=in:st=0:d=1.2,afade=t=out:st=%(FO).3f:d=1.9[mu];"
        "[mu][vk]sidechaincompress=threshold=0.055:ratio=4:attack=12:release=420[md]"
        % {"T": total, "VF": vfade, "G": gain, "FO": fo, "L": lufs,
           "VL": float(spec.get("voice_lufs", -18)), "VI": vi, "MI": mi})


def mux(pic, voice, spec, total, dst):
    """v9's chain: duck music ~18-19 dB under voice, -14 LUFS, decay tail."""
    music = os.path.join(MUSIC_DIR, spec["music"])
    if not os.path.exists(music):
        die("music not found: %s" % music)
    fc = (audio_stems(spec, total, 1, 2) +
          ";[vx][md]amix=inputs=2:weights=1 0.85:duration=first:normalize=0,"
          "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]")
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", pic, "-i", voice,
         "-stream_loop", "-1", "-i", music, "-filter_complex", fc,
         "-map", "0:v", "-map", "[ao]", "-c:v", "copy", "-c:a", "aac",
         "-b:a", "192k", "-movflags", "+faststart", dst])
    return dst


def measure_duck(voice, spec, total, words, work):
    """Measure, don't assert: music must sit ~18-19 dB under the voice."""
    music = os.path.join(MUSIC_DIR, spec["music"])
    sv = os.path.join(work, "stem_voice.wav")
    sm = os.path.join(work, "stem_music.wav")
    fc = audio_stems(spec, total, 0, 1)
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", voice,
         "-stream_loop", "-1", "-i", music, "-filter_complex", fc,
         "-map", "[vx]", "-c:a", "pcm_s16le", sv,
         "-map", "[md]", "-c:a", "pcm_s16le", sm])

    # Windows must sit INSIDE continuous speech. Sampling from a bare word
    # start lets a 1.2s window straddle a pause, where the voice mean collapses
    # and the duck reads as 1-6 dB when the mix is actually fine. Require the
    # whole window to be covered by words with no internal gap over 0.12s.
    WIN = 1.0
    wins = []
    for i, w in enumerate(words):
        a = w["start"]
        if a <= 1.0 or a + WIN >= total - 2.0:
            continue
        covered, cur, ok = a, i, True
        while covered < a + WIN and cur < len(words):
            if words[cur]["start"] - covered > 0.12:
                ok = False
                break
            covered = max(covered, words[cur]["end"])
            cur += 1
        if ok and covered >= a + WIN:
            wins.append(round(a, 2))
    if not wins:
        print("    (no continuous-speech window found -- skipping duck measurement)")
        return []
    step = max(1, len(wins) // 6)
    wins = wins[::step][:6]
    rows = []
    for a in wins:
        v = mean_vol(sv, a, WIN)
        m = mean_vol(sm, a, WIN)
        if v is None or m is None:
            continue
        rows.append((a, v, m, v - m))
        print("    t=%5.2f  voice %7.2f dB   ducked music %7.2f dB   "
              "music %5.1f dB under voice" % (a, v, m, v - m))
    return rows


def mean_vol(path, ss, t):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "info", "-ss", "%.3f" % ss,
                        "-t", "%.3f" % t, "-i", path, "-af", "volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", p.stderr)
    return float(m.group(1)) if m else None


# --------------------------------------------------------------------------
# covers + verification frames
# --------------------------------------------------------------------------

COVER_HOOK_STYLE = ("Style: CovHook,Plus Jakarta Sans ExtraBold,86,&H00FFFFFF,&H00FFFFFF,"
                    "&H00101010,&H00101010,-1,0,0,0,100,100,1,0,3,22,0,8,70,70,%d,1")


def covers(pic, spec, base, work):
    """1080x1920 poster + the TRUE 1:1 keeping y=418-1498.

    Rendered from the PICTURE, not the finished master, for two reasons. The
    captions are a motion device rather than a poster element; and the in-video
    hook card lives at MarginV 170, which the 1:1 centre crop slices clean off --
    the first build produced two square covers that were just scenery with no
    words on them at all. So the cover gets its own hook event pushed down to
    MarginV 760, which lands the text inside 418-1498 and survives the crop.
    A cover whose text only reads in 9:16 is half a cover.
    """
    t = float(spec.get("cover_t", 1.0))
    png = base + ".cover.png"
    sq = base + ".cover_square.png"
    hook = spec.get("hook_card")
    ass = os.path.join(work, "cover.ass")
    ev = []
    if hook:
        txt = r"\N".join(l.upper() for l in hook["lines"])
        ev.append("Dialogue: 0,0:00:00.00,0:00:10.00,CovHook,,0,0,0,,%s" % txt)
    mv = int(spec.get("cover_hook_marginv", 760))
    open(ass, "w", encoding="utf-8").write(
        (ASS_HDR % (COVER_HOOK_STYLE % mv, "")) + "\n".join(ev) + "\n")
    fonts = "/home/heath/.local/share/fonts"
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "%.3f" % t,
         "-i", pic, "-frames:v", "1",
         "-vf", "subtitles=%s:fontsdir=%s" % (ass, fonts), png])
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", png,
         "-vf", "crop=1080:1080:0:418", sq])
    return png, sq


def frames(master, base, times):
    d = base + ".frames"
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    out = []
    for t in times:
        p = os.path.join(d, "t%06.2f.png" % t)
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "%.3f" % t,
             "-i", master, "-frames:v", "1", p])
        out.append(p)
    return d, out


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def guard(spec):
    brand = spec.get("brand")
    if brand not in ("realtor", "dossie"):
        die("spec.brand must be 'realtor' or 'dossie'")
    vid = spec["voice_id"]
    if brand == "dossie" and vid == HEATH_CLONE:
        die("VOICE GUARD: Heath's clone (%s) is approved for realtor-brand and "
            "Rust content only, never Dossie. Dossie uses Luna %s. See memory "
            "heath-voice-clone-usage-scope.md." % (HEATH_CLONE, LUNA))
    if brand == "dossie" and vid != LUNA:
        print("  NOTE: dossie brand with non-Luna voice %s" % vid)
    print("  brand=%s voice=%s model=%s" % (brand, vid, spec["model_id"]))


def main():
    if len(sys.argv) < 2:
        die("usage: build_headless_video.py <spec.json>")
    sp = sys.argv[1]
    if not os.path.isabs(sp):
        cand = os.path.join(os.path.dirname(os.path.abspath(__file__)), sp)
        sp = cand if os.path.exists(cand) else os.path.abspath(sp)
    spec = json.load(open(sp, encoding="utf-8"))
    spec.setdefault("model_id", "eleven_v4")
    spec.setdefault("voice_settings", {"stability": 0.3, "similarity_boost": 0.75,
                                       "style": 0.4, "use_speaker_boost": True})
    slug = spec["slug"]
    work = os.path.join(WORK_ROOT, slug)
    os.makedirs(work, exist_ok=True)
    os.makedirs(OUT_ROOT, exist_ok=True)
    base = os.path.join(OUT_ROOT, slug)

    print("== %s ==" % slug)
    guard(spec)

    print("-- gate: footage")
    for s in spec["shots"]:
        p, priv = resolve_clip(s["clip"])
        print("   clear  %s" % s["clip"])

    print("-- voice")
    voice, words, vdur = assemble_voice(spec["beats"], work, spec)
    total = round(vdur + TAIL, 3)
    print("   voice %.2fs  + %.2fs tail  = %.2fs total" % (vdur, TAIL, total))

    print("-- captions")
    cap = base + ".captions.ass"
    supp = float(spec.get("caption_suppress_until",
                          spec.get("hook_card", {}).get("until", 0.0)))
    accent = set(a.upper() for a in spec.get("accent_words", []))
    chunks, ev = build_captions(words, supp, accent, cap,
                                spec.get("caption_rewrite"))
    print("   %d chunks, %d events, suppressed before %.2fs" % (len(chunks), len(ev), supp))
    for c in chunks:
        print("     %6.2f-%6.2f  %s" % (c[0]["start"], c[-1]["end"],
              " ".join(x["text"] for x in c).upper()))

    cards = base + ".cards.ass"
    build_cards(spec, total, cards)

    print("-- picture")
    pic, plan, cutdur = build_picture(spec, total, work)

    print("-- burn")
    burned = burn(pic, cap, cards, total, work)

    print("-- mix")
    master = base + ".mp4"
    mux(burned, voice, spec, total, master)
    duck = measure_duck(voice, spec, total, words, work)

    print("-- covers")
    png, sq = covers(pic, spec, base, work)

    print("-- frames")
    fdir, fs = frames(master, base, spec.get("verify_frames", [0.0, 1.0, 2.9, 3.1]))

    meta = {
        "slug": slug, "brand": spec["brand"], "voice_id": spec["voice_id"],
        "model_id": spec["model_id"], "voice_settings": spec["voice_settings"],
        "music": spec["music"], "duration_sec": ffprobe_dur(master),
        "voice_sec": vdur, "cuts": len(plan),
        "mean_cut_sec": round(cutdur / max(1, len(plan)), 2),
        "shots": [{"clip": s["clip"], "in": round(tin, 2), "dur": round(d, 2),
                   "motion": m, "privacy": s["_priv"]} for s, tin, d, m in plan],
        "caption_chunks": len(chunks),
        "duck_db": [round(r[3], 1) for r in duck],
        "script": [{"id": b.get("id"), "text": b["text"]} for b in spec["beats"]],
        "spec_path": sp,
    }
    json.dump(meta, open(base + ".meta.json", "w"), indent=2)

    print("\n== DONE %s ==" % slug)
    print("   %s  (%.2fs)" % (master, meta["duration_sec"]))
    print("   %s" % png)
    print("   %s" % sq)
    print("   %s" % (base + ".meta.json"))
    print("   frames: %s" % fdir)


if __name__ == "__main__":
    main()
