"""Acoustically-grounded phrase selector (replaces sel.py).

Why this exists: the first render lost the emphatic "five" that is the whole
payoff of the reveal, and doubled "It, it ends Saturday". Both came from
trusting scribe's word timestamps. Scribe labelled that "5." at 26.64-26.68 in
take 160955 -- the envelope shows pure noise floor there; the real word runs
26.24-26.52. Word labels are a guide, not a boundary.

So: build a voice-activity map of each take from the audio itself, snap every
segment edge to a real speech-region edge, and size every pad against the real
silence available:  pad = min(0.10, gap * 0.45).  That is the rule that stops a
pad from swallowing the onset of the word on the other side of the cut -- the
cause of both defects above.

Each segment carries its own head/tail pad so the crossfade in cut.py can be
sized to the silence actually available at that particular join.
"""
import json, sys, array, subprocess, math

SR = 8000
FR = 0.02
PADMAX = 0.10
PADFRAC = 0.45
HOLD_DEF = 0.30

TAKES = ['20260930_160955', '20260930_161136', '20260930_161301']


def pcm(path):
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path,
                          '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    return a


def envelope(a):
    n = int(FR * SR)
    out = []
    for i in range(0, len(a) - n, n):
        s = 0
        for k in range(i, i + n, 2):
            s += a[k] * a[k]
        r = math.sqrt(s / (n / 2))
        out.append(20 * math.log10(r / 32768.0) if r > 0 else -120.0)
    return out


def vad(env, floor, thr_db=15.0, min_speech=0.06, min_sil=0.10):
    thr = floor + thr_db
    on = [e > thr for e in env]
    regs, i = [], 0
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            regs.append([i * FR, j * FR])
            i = j
        else:
            i += 1
    merged = []
    for r in regs:
        if merged and r[0] - merged[-1][1] < min_sil:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [r for r in merged if r[1] - r[0] >= min_speech]


print('building voice-activity maps...', file=sys.stderr)
VADS = {}
for t in TAKES:
    env = envelope(pcm('/home/heath/mw/v7/wav/%s.wav' % t))
    s = sorted(env)
    floor = s[int(len(s) * 0.10)]
    VADS[t] = vad(env, floor)
    print('  %s floor=%.1f dB regions=%d' % (t, floor, len(VADS[t])), file=sys.stderr)

U = json.load(open('/home/heath/mw/v7/units.json'))
WORDS = {}
for t in TAKES:
    d = json.load(open('/home/heath/mw/v7/tr/%s.json' % t))
    WORDS[t] = [w for w in d['words'] if w.get('type') == 'word']

spec = json.load(open(sys.argv[1]))
PLAN, HOLDS = spec['plan'], spec.get('holds', {})
SPEEDS = [1.10, 1.14, 1.18, 1.22]

segs, seg_words, rows = [], [], []

for uid, take, th, tt in PLAN:
    r = U[take][uid]
    ws = WORDS[take][r['a']:r['b'] + 1]
    if th: ws = ws[th:]
    if tt: ws = ws[:-tt]
    regs = [x for x in VADS[take] if x[1] > ws[0]['start'] - 0.02 and x[0] < ws[-1]['end'] + 0.02]
    if not regs:
        regs = [[ws[0]['start'], ws[-1]['end']]]
    a_on, a_off = regs[0][0], regs[-1][1]
    prev_end = max([x[1] for x in VADS[take] if x[1] <= a_on + 0.001], default=0.0)
    next_start = min([x[0] for x in VADS[take] if x[0] >= a_off - 0.001], default=a_off + 5.0)
    gb, ga = a_on - prev_end, next_start - a_off
    head_pad = min(PADMAX, max(0.02, gb * PADFRAC))
    tail_pad = min(PADMAX, max(0.02, ga * PADFRAC))
    hold = HOLDS.get(uid, HOLD_DEF)

    # part boundaries: (start, end, head_pad, tail_pad)
    parts = []
    cur_s, cur_hp = a_on - head_pad, head_pad
    for k in range(1, len(regs)):
        sil = regs[k][0] - regs[k - 1][1]
        if sil > hold:
            ip = min(PADMAX, sil * PADFRAC)
            parts.append((cur_s, regs[k - 1][1] + ip, cur_hp, ip))
            cur_s, cur_hp = regs[k][0] - ip, ip
    parts.append((cur_s, a_off + tail_pad, cur_hp, tail_pad))

    base = len(segs)
    for (b, e, hp, tp) in parts:
        segs.append([take, round(max(0.0, b), 3), round(e, 3), round(hp, 4), round(tp, 4)])
        seg_words.append([])
    # Caption integrity: assign EVERY word of the take whose midpoint lands
    # inside the segment, not just the words of the planned unit. VAD merges
    # regions closer than 100ms, so a segment can legitimately carry a
    # neighbouring line (U03's region swallows U04 -- "they call you, they've
    # changed their mind" is one continuous breath). Captions must describe the
    # audio that is actually there, not the audio we intended.
    for si in range(base, len(segs)):
        b, e = segs[si][1], segs[si][2]
        for w in WORDS[take]:
            mid = (w['start'] + w['end']) / 2.0
            if b <= mid <= e:
                seg_words[si].append({'t': w['text'], 's': w['start'], 'e': w['end'],
                                      'lp': w.get('logprob', 0.0)})
    rows.append((uid, take, len(parts), gb, ga, head_pad, tail_pad,
                 ' '.join(w['text'] for w in ws)))

raw = sum(e - b for _, b, e, _, _ in segs)
xtake = sum(1 for i in range(1, len(segs)) if segs[i][0] != segs[i - 1][0])
print('segments %d | cross-take joins %d | in-take joins %d | raw %.2fs'
      % (len(segs), xtake, len(segs) - 1 - xtake, raw))
for s in SPEEDS:
    print('   %s speed %.2f -> %.2fs' % ('OK' if 21 <= raw / s <= 34 else '!!', s, raw / s))
print()
for uid, take, np_, gb, ga, hp, tp, txt in rows:
    print('%-4s %s sub=%d gapB=%.2f gapA=%.2f padH=%.3f padT=%.3f  %s'
          % (uid, take[-6:], np_, gb, ga, hp, tp, txt[:58]))
print()
missing = [i for i, sw in enumerate(seg_words) if not sw]
print('segments with no words assigned:', missing)

json.dump({'segs': segs, 'raw': round(raw, 3), 'plan': PLAN, 'seg_words': seg_words},
          open('/home/heath/mw/v7/v7b_plan.json', 'w'), indent=1)
print('wrote v7b_plan.json')
