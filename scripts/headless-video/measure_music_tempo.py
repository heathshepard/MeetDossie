#!/usr/bin/env python3
"""Measure tempo + loudness of every track in Media/Music/, stdlib only.

Energy in a short-form video comes partly from a bed with real forward motion,
and "energetic" in a filename is not evidence. This picks tracks on a measured
BPM and a measured onset strength instead.

Method: decode to 8 kHz mono PCM, build a ~172 Hz RMS envelope, half-wave
rectify its first difference to get an onset strength signal, then autocorrelate
that over the 60-180 BPM lag range and take the strongest lag. Pure Python --
this box has no numpy/librosa and no pip.

    python3 scripts/headless-video/measure_music_tempo.py
"""
import array
import math
import os
import subprocess
import sys
import wave

MUSIC = "/mnt/c/Users/Heath/Projects/MeetDossie/Media/Music"
SR = 8000
HOP = 46            # ~172 envelope frames/sec


def envelope(path, limit=60.0):
    tmp = "/tmp/_tempo.wav"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-t", str(limit),
                    "-i", path, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le",
                    tmp], check=True, capture_output=True)
    w = wave.open(tmp, "rb")
    raw = w.readframes(w.getnframes())
    w.close()
    s = array.array("h")
    s.frombytes(raw)
    env = []
    for i in range(0, len(s) - HOP, HOP):
        acc = 0
        for j in range(i, i + HOP):
            acc += s[j] * s[j]
        env.append(math.sqrt(acc / HOP))
    os.remove(tmp)
    return env


def onset(env):
    o = []
    for i in range(1, len(env)):
        d = env[i] - env[i - 1]
        o.append(d if d > 0 else 0.0)
    m = sum(o) / len(o) if o else 0.0
    return [x - m for x in o], m


def tempo(path):
    env = envelope(path)
    if len(env) < 200:
        return None, 0.0, 0.0
    o, mean_on = onset(env)
    fps = float(SR) / HOP
    best, bestlag = -1e18, 0
    lo = int(fps * 60.0 / 180.0)
    hi = int(fps * 60.0 / 60.0)
    norm0 = sum(x * x for x in o) or 1.0
    for lag in range(lo, hi + 1):
        acc = 0.0
        for i in range(len(o) - lag):
            acc += o[i] * o[i + lag]
        acc /= (len(o) - lag)
        if acc > best:
            best, bestlag = acc, lag
    bpm = 60.0 * fps / bestlag if bestlag else 0.0
    # onset strength relative to overall level = how percussive/driving it is
    rms = sum(env) / len(env) or 1.0
    drive = mean_on / rms
    return bpm, drive, best / (norm0 / len(o))


def main():
    files = sorted(f for f in os.listdir(MUSIC) if f.endswith(".mp3"))
    if len(sys.argv) > 1:
        files = [f for f in files if any(a in f for a in sys.argv[1:])]
    rows = []
    for f in files:
        p = os.path.join(MUSIC, f)
        try:
            bpm, drive, conf = tempo(p)
        except Exception as e:
            print("%-38s ERROR %s" % (f, e))
            continue
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", p],
            capture_output=True, text=True).stdout.strip() or 0)
        rows.append((f, bpm, drive, conf, dur))
    rows.sort(key=lambda r: -r[2])
    print("%-38s %7s %8s %8s %7s" % ("track", "BPM", "drive", "conf", "len s"))
    for f, bpm, drive, conf, dur in rows:
        print("%-38s %7.1f %8.3f %8.3f %7.0f" % (f, bpm, drive, conf, dur))
    print("\ndrive = mean positive onset / mean RMS (higher = more percussive "
          "forward motion). Sorted by drive.")


if __name__ == "__main__":
    main()
