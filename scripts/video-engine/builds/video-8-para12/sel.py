"""Acoustically-grounded phrase selector for video 8 (TREC 20-19 para 12.B).

Direct port of v7's sel2.py -- the version that produced the joins Heath
approved -- with v8 paths, an explicit (take, word_i0, word_i1) plan instead of
a units.json indirection, and one addition: a HEAD-side envelope trim mirroring
the existing tail-side one. v7 only guarded the tail, because that was the edge
that failed. A segment that starts inside a merged VAD region (words closer than
min_sil) would otherwise snap its head back onto the preceding, dropped word.

Everything else is unchanged and must stay unchanged:
  * cut edges snap to real speech-region edges from a per-take VAD map built
    from the audio itself, never to a transcript label;
  * pads are per-side, sized against that take's own silence:
        pad = min(0.09, max(0.02, gap * 0.45))
  * when the word following a unit is NOT the next planned word, the tail is
    pulled back to the quietest 20ms frame between them instead of the region
    edge, so a run-together phrase cannot ship a fragment of a dropped word.
"""
import json, sys, array, subprocess, math

SR = 8000
FR = 0.02
PADMAX = 0.09
PADFRAC = 0.45
HOLD_DEF = 0.30

TAKES = ['20261001_124457', '20261001_124604', '20261001_124712']
BASE = '/home/heath/mw/v8'


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
VADS, ENVS, WORDS = {}, {}, {}
for t in TAKES:
    env = envelope(pcm('%s/wav/%s.wav' % (BASE, t)))
    ENVS[t] = env
    s = sorted(env)
    floor = s[int(len(s) * 0.10)]
    VADS[t] = vad(env, floor)
    d = json.load(open('%s/tr/%s.json' % (BASE, t)))
    WORDS[t] = [w for w in d['words'] if w.get('type') == 'word']
    print('  %s floor=%.1f dB regions=%d words=%d'
          % (t, floor, len(VADS[t]), len(WORDS[t])), file=sys.stderr)


# The VAD envelope above is decoded at 8 kHz and summed with stride 2, i.e. it
# effectively samples at 4 kHz. That is fine for finding speech regions -- it is
# the map v7 shipped with and it stays unchanged -- but it is close to BLIND to
# a fricative, whose energy lives at 5-8 kHz. Measured on this shoot: the final
# /s/ of "box." reads -49 dB on the 8 kHz envelope and -28.8 dB at 16 kHz with
# a 6330/s zero-crossing rate. So the two SAFETY guards below (which only ever
# prevent a deletion, never cause one) run on a full-rate 16 kHz envelope.
SRHI = 16000
ENVHI, FLOORS = {}, {}
print('building full-rate envelopes for the fricative guards...', file=sys.stderr)
for t in TAKES:
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i',
                          '%s/wav/%s.wav' % (BASE, t), '-ac', '1', '-ar', str(SRHI),
                          '-f', 's16le', '-'], capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    n = int(FR * SRHI)
    out = []
    for i in range(0, len(a) - n, n):
        s = 0
        for k in range(i, i + n):
            s += a[k] * a[k]
        r = math.sqrt(s / n)
        out.append(20 * math.log10(r / 32768.0) if r > 0 else -120.0)
    ENVHI[t] = out
    sv = sorted(out)
    FLOORS[t] = sv[int(len(sv) * 0.10)]
    print('  %s hi-rate floor=%.1f dB' % (t, FLOORS[t]), file=sys.stderr)


def envelope_min(take, t0, t1):
    """Time of the quietest 20ms frame in [t0,t1] -- the best place to cut when
    two words are run together and the VAD cannot separate them."""
    env = ENVS[take]
    i0, i1 = max(0, int(t0 / FR)), min(len(env) - 1, int(t1 / FR))
    if i1 <= i0:
        return None
    best = min(range(i0, i1 + 1), key=lambda i: env[i])
    return best * FR


def envelope_max(take, t0, t1):
    """Loudest 20ms frame in [t0,t1], in dB, on the FULL-RATE envelope so that
    fricatives are visible."""
    env = ENVHI[take]
    i0, i1 = max(0, int(t0 / FR)), min(len(env) - 1, int(t1 / FR))
    if i1 <= i0:
        return -120.0
    return max(env[i0:i1 + 1])


# An internal split deletes the span between the two padded edges. That is only
# safe if the span really is silence. The VAD thresholds at floor+15 dB, which
# is ABOVE an unvoiced consonant: /s/, /z/, /t/ and /dʒ/ all sit 8-16 dB over
# the room floor but ~20 dB under a vowel, so a "silence" long enough to split
# on can actually contain the tail of one word and the onset of the next.
# Measured on this shoot: splitting U02 deleted the /nt/ of "percent," and
# splitting U04 deleted the /z/ of "words,". So a split is only taken when the
# whole deleted span stays within SPLIT_QUIET_DB of the room floor.
SPLIT_QUIET_DB = 8.0

# A word-final fricative can sit below the VAD threshold and outside the pad, so
# the cut lands between the vowel and its own /s/. That shipped "bok." for
# "box." on the first pass of this build. Where nothing follows that we need to
# protect, extend the tail through any contiguous above-floor burst.
TAIL_RECOVER_DB = 6.0
TAIL_RECOVER_MAX = 0.30


spec = json.load(open(sys.argv[1]))
PLAN, HOLDS = spec['plan'], spec.get('holds', {})
HEAD_AT = spec.get('head_at', {})
SPEEDS = [1.10, 1.14, 1.18, 1.22]

segs, seg_words, rows = [], [], []


def unit_words(take, i0, i1):
    return WORDS[take][i0:i1 + 1]


for pi, entry in enumerate(PLAN):
    uid, take, i0, i1 = entry
    ws = unit_words(take, i0, i1)
    regs = [x for x in VADS[take] if x[1] > ws[0]['start'] - 0.02 and x[0] < ws[-1]['end'] + 0.02]
    if not regs:
        regs = [[ws[0]['start'], ws[-1]['end']]]
    a_on, a_off = regs[0][0], regs[-1][1]

    # ---- TAIL guard (v7, unchanged) -------------------------------------
    # A VAD region only splits on >=100ms of silence, so when Heath runs two
    # phrases together the region can extend past the line we are keeping and
    # into the first syllable of a line we are dropping.
    nxt = WORDS[take][i1 + 1] if i1 + 1 < len(WORDS[take]) else None
    nxt_planned = None
    if pi + 1 < len(PLAN) and PLAN[pi + 1][1] == take:
        nxt_planned = unit_words(PLAN[pi + 1][1], PLAN[pi + 1][2], PLAN[pi + 1][3])[0]
    carries_next = nxt is not None and nxt_planned is not None and \
        abs(nxt['start'] - nxt_planned['start']) < 0.001
    trimmed_tail = False
    if nxt is not None and not carries_next and a_off > nxt['start'] - 0.02:
        m = envelope_min(take, ws[-1]['end'] - 0.08, nxt['start'] + 0.12)
        if m is not None and m > ws[-1]['end'] - 0.12:
            a_off = m
            trimmed_tail = True

    # ---- HEAD guard (new in v8) -----------------------------------------
    # Mirror of the above for the leading edge: if the word BEFORE this unit is
    # not the word the previous planned segment ended on, and the VAD region has
    # swallowed it (words closer than min_sil), pull the head forward to the
    # quietest frame between them rather than snapping back onto a dropped word.
    prv = WORDS[take][i0 - 1] if i0 > 0 else None
    prv_planned = None
    if pi > 0 and PLAN[pi - 1][1] == take:
        prv_planned = unit_words(PLAN[pi - 1][1], PLAN[pi - 1][2], PLAN[pi - 1][3])[-1]
    carries_prev = prv is not None and prv_planned is not None and \
        abs(prv['end'] - prv_planned['end']) < 0.001
    trimmed_head = False
    if prv is not None and not carries_prev and a_on < prv['end'] + 0.02:
        m = envelope_min(take, prv['end'] - 0.12, ws[0]['start'] + 0.08)
        if m is not None and m < ws[0]['start'] + 0.12:
            a_on = m
            trimmed_head = True

    # ---- TAIL fricative recovery (new in v8) ----------------------------
    # Only where there is room: never run past the next word's onset.
    limit = (nxt['start'] - 0.06) if nxt is not None else (a_off + TAIL_RECOVER_MAX)
    limit = min(limit, a_off + TAIL_RECOVER_MAX)
    # A word-final fricative is separated from its own vowel by a real dip (the
    # stop closure), so a contiguous scan never reaches it: "box." reads -49 dB
    # at 55.39 and -28.8 dB at 55.53. Scan the whole window instead, and extend
    # only if the burst BEGINS close enough to the edge to belong to this word.
    recovered = 0.0
    if not trimmed_tail and limit > a_off:
        thr = FLOORS[take] + TAIL_RECOVER_DB
        hot = []
        t_sc = a_off
        while t_sc + FR <= limit:
            if envelope_max(take, t_sc, t_sc + FR) > thr:
                hot.append(t_sc)
            t_sc += FR
        if hot and hot[0] - a_off <= 0.15:
            new_off = min(limit, hot[-1] + FR)
            if new_off > a_off:
                recovered = new_off - a_off
                a_off = new_off

    # ---- explicit head override ----------------------------------------
    # The VAD region before "Read the sentence..." opens on a 0.20s inhale
    # (envelope peaks -24.4 dB at 12.72, the word itself starts 12.90). The
    # breath is real delivery, but this unit already follows a hard cut from
    # "...covered, right?", so it reads fine entering on the breath's tail --
    # and the runtime is needed to stay inside TikTok's 34s window. Forced to
    # the quietest frame between the inhale and the word.
    ha = HEAD_AT.get(uid)
    if ha is not None and ha > a_on:
        a_on = ha

    prev_end = max([x[1] for x in VADS[take] if x[1] <= a_on + 0.001], default=0.0)
    next_start = min([x[0] for x in VADS[take] if x[0] >= a_off - 0.001], default=a_off + 5.0)
    # A trimmed edge sits INSIDE a VAD region, so the neighbouring region edge is
    # far away and the proportional pad would happily run into the very word the
    # trim just removed. Clamp the pad against the dropped word.
    if trimmed_tail:
        next_start = min(next_start, nxt['start'])
    if trimmed_head:
        prev_end = max(prev_end, prv['end'])
    gb, ga = a_on - prev_end, next_start - a_off
    head_pad = min(PADMAX, max(0.02, gb * PADFRAC))
    tail_pad = min(PADMAX, max(0.02, ga * PADFRAC))
    hold = HOLDS.get(uid, HOLD_DEF)

    parts = []
    skipped = 0
    cur_s, cur_hp = a_on - head_pad, head_pad
    for k in range(1, len(regs)):
        sil = regs[k][0] - regs[k - 1][1]
        if sil > hold and regs[k][0] > a_on and regs[k - 1][1] < a_off:
            ip = min(PADMAX, sil * PADFRAC)
            cut_a, cut_b = regs[k - 1][1] + ip, regs[k][0] - ip
            if envelope_max(take, cut_a, cut_b) > FLOORS[take] + SPLIT_QUIET_DB:
                skipped += 1          # not real silence -- a consonant lives here
                continue
            parts.append((cur_s, cut_a, cur_hp, ip))
            cur_s, cur_hp = cut_b, ip
    parts.append((cur_s, a_off + tail_pad, cur_hp, tail_pad))

    base = len(segs)
    for (b, e, hp, tp) in parts:
        segs.append([take, round(max(0.0, b), 3), round(e, 3), round(hp, 4), round(tp, 4)])
        seg_words.append([])
    # Caption integrity: assign EVERY word of the take whose midpoint lands
    # inside the segment, not just the words of the planned unit.
    for si in range(base, len(segs)):
        b, e = segs[si][1], segs[si][2]
        for w in WORDS[take]:
            mid = (w['start'] + w['end']) / 2.0
            if b <= mid <= e:
                seg_words[si].append({'t': w['text'], 's': w['start'], 'e': w['end'],
                                      'lp': w.get('logprob', 0.0)})
    rows.append((uid, take, len(parts), gb, ga, head_pad, tail_pad,
                 trimmed_head, trimmed_tail, recovered, skipped,
                 ' '.join(w['text'] for w in ws)))

raw = sum(e - b for _, b, e, _, _ in segs)
xtake = sum(1 for i in range(1, len(segs)) if segs[i][0] != segs[i - 1][0])
print('segments %d | cross-take joins %d | in-take joins %d | raw %.2fs'
      % (len(segs), xtake, len(segs) - 1 - xtake, raw))
for s in SPEEDS:
    print('   %s speed %.2f -> %.2fs cut, %.2fs final (+0.33 tail)'
          % ('OK' if 21 <= raw / s + 0.33 <= 34 else '!!', s, raw / s, raw / s + 0.33))
print()
for uid, take, np_, gb, ga, hp, tp, th, tt, rc, sk, txt in rows:
    print('%-4s %s sub=%d gapB=%.2f gapA=%.2f padH=%.3f padT=%.3f %s%s%s%s %s'
          % (uid, take[-6:], np_, gb, ga, hp, tp,
             'Htrim ' if th else '', 'Ttrim ' if tt else '',
             'rec=%.2f ' % rc if rc else '', 'noSplit=%d ' % sk if sk else '',
             txt[:58]))
print()
missing = [i for i, sw in enumerate(seg_words) if not sw]
print('segments with no words assigned:', missing)

json.dump({'segs': segs, 'raw': round(raw, 3), 'plan': PLAN, 'seg_words': seg_words},
          open('%s/v8_plan.json' % BASE, 'w'), indent=1)
print('wrote v8_plan.json')
