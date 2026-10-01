"""Did any cut edge clip a consonant?

The VAD in sel.py thresholds at floor+15 dB, which is above a word-final
fricative: /s/ sits ~16 dB over the room floor but ~20 dB under the vowel, so a
speech region can END BEFORE the /s/ does and the pad (<=90ms) may not reach it.
That is how "box." became "bok." on the first v8 pass.

A decay tail is fine to cut into -- it is the same sound fading. A SEPARATE,
high-zero-crossing burst sitting above the room floor after the edge is not: it
is a distinct phoneme that the edit would delete.

So for every segment edge, measure the 120ms just outside it and flag anything
that is both >=8 dB above that take's room floor AND high-ZCR (fricative-like)
or simply loud (>=12 dB above floor, i.e. any phoneme at all).
"""
import json, sys, array, subprocess, math
SR = 16000
BASE = '/home/heath/mw/v8'
TAKES = ['20261001_124457', '20261001_124604', '20261001_124712']


def pcm(path):
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path,
                          '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    return a


A = {t: pcm('%s/wav/%s.wav' % (BASE, t)) for t in TAKES}

FLOOR = {}
for t in TAKES:
    a = A[t]
    n = int(0.02 * SR)
    fr = []
    for i in range(0, len(a) - n, n):
        s = sum(float(a[k]) * a[k] for k in range(i, i + n, 4))
        r = math.sqrt(s / (n / 4))
        fr.append(20 * math.log10(r / 32768.0) if r > 0 else -120.0)
    fr.sort()
    FLOOR[t] = fr[int(len(fr) * 0.10)]
    print('%s room floor %.1f dB' % (t, FLOOR[t]))


def stats(t, t0, t1):
    a = A[t]
    i0, i1 = max(0, int(t0 * SR)), min(len(A[t]), int(t1 * SR))
    seg = a[i0:i1]
    n = len(seg)
    if n < 100:
        return None
    zc = sum(1 for k in range(1, n) if (seg[k - 1] < 0) != (seg[k] < 0))
    rms = math.sqrt(sum(float(x) * x for x in seg) / n)
    db = 20 * math.log10(rms / 32768.0) if rms > 0 else -120.0
    return db, zc * SR / n


plan = json.load(open('%s/v8_plan.json' % BASE))
segs = plan['segs']
words = {}
for t in TAKES:
    d = json.load(open('%s/tr/%s.json' % (BASE, t)))
    words[t] = [w for w in d['words'] if w.get('type') == 'word']

print()
print('seg  take   edge      t(s)     outside_dB  over_floor  ZCR     verdict  last/next word')
bad = 0
for i, (t, b, e, hp, tp) in enumerate(segs):
    for edge, tt, wins in (('tail', e, (e, e + 0.12)), ('head', b, (b - 0.12, b))):
        s = stats(t, wins[0], wins[1])
        if s is None:
            continue
        db, zcr = s
        over = db - FLOOR[t]
        # which word is just outside this edge
        if edge == 'tail':
            w = next((x['text'] for x in words[t] if x['start'] >= e - 0.05), '-')
        else:
            w = next((x['text'] for x in reversed(words[t]) if x['end'] <= b + 0.05), '-')
        verdict = 'ok'
        if over >= 12.0:
            verdict = 'PHONEME-OUTSIDE'
            bad += 1
        elif over >= 8.0 and zcr > 3500:
            verdict = 'FRICATIVE-CLIPPED'
            bad += 1
        print('%3d  %s %-5s %8.3f  %9.1f  %9.1f  %6.0f  %-18s %s'
              % (i, t[-6:], edge, tt, db, over, zcr, verdict, w))
print()
print('edges with a phoneme sitting outside the cut: %d' % bad)
