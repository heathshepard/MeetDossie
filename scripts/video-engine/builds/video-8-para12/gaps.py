"""How much runtime is sitting in internal pauses that the split guard refused
to cut, and how much of each is genuinely quiet enough to cut safely?"""
import json, sys, array, subprocess, math
BASE = '/home/heath/mw/v8'
FR = 0.02
SRHI = 16000
TAKES = ['20261001_124457', '20261001_124604', '20261001_124712']

ENVHI, FLOORS = {}, {}
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

plan = json.load(open('%s/v8_plan.json' % BASE))
total = 0.0
for i, (t, b, e, hp, tp) in enumerate(plan['segs']):
    env = ENVHI[t]
    thr = FLOORS[t] + 8.0
    i0, i1 = int(b / FR), int(e / FR)
    runs, k = [], i0
    while k < i1:
        if env[k] <= thr:
            j = k
            while j < i1 and env[j] <= thr:
                j += 1
            if (j - k) * FR >= 0.16:
                runs.append((k * FR, j * FR))
            k = j
        else:
            k += 1
    inner = [r for r in runs if r[0] > b + 0.12 and r[1] < e - 0.12]
    s = sum(r[1] - r[0] for r in inner)
    total += s
    print('seg%d %s %.3f-%.3f  internal quiet runs: %s  total %.2fs'
          % (i, t[-6:], b, e, ['%.2f-%.2f' % r for r in inner], s))
print()
print('total internal quiet time across all segments: %.2fs' % total)
