"""Is a join distinguishable from an ordinary moment in the same audio?

A splice is audible when it introduces a discontinuity the surrounding material
does not already contain. So rather than asking "is there a level change at the
join" (there always is -- Heath starts a new phrase), ask whether the
short-time level *jump* at each join sits inside the distribution of jumps at
non-join points in the same render.

Metric: max |dLevel| between adjacent 5ms frames within +/-60ms of a point.
Baseline: the same metric at 400 points on a grid, excluding +/-0.25s of any join.
"""
import sys, json
from an import pcm, rms, db, SR

path, metap = sys.argv[1], sys.argv[2]
a = pcm(path)
meta = json.load(open(metap))
segs = meta['segs']
F = int(0.005 * SR)

def maxjump(c):
    fr = [rms(a, c + k * F, c + (k + 1) * F) for k in range(-12, 12)]
    js = [abs(db(fr[k + 1]) - db(fr[k])) for k in range(len(fr) - 1)
          if fr[k] > 0 and fr[k + 1] > 0]
    return max(js) if js else 0.0

joins = meta['joins']
dur = len(a) / SR

base = []
t = 0.5
while t < dur - 0.5:
    if all(abs(t - j) > 0.25 for j in joins):
        base.append(maxjump(int(t * SR)))
    t += 0.08
base.sort()

def pct(v):
    lo = sum(1 for b in base if b < v)
    return 100.0 * lo / len(base)

print('baseline (non-join) max 5ms jump: median %.1f dB  p90 %.1f  p99 %.1f  max %.1f  (n=%d)'
      % (base[len(base) // 2], base[int(len(base) * .90)], base[int(len(base) * .99)],
         base[-1], len(base)))
print()
print('join    t(s)    maxjump   percentile-of-baseline   takes')
flagged = 0
for i, t in enumerate(joins, start=1):
    v = maxjump(int(t * SR))
    p = pct(v)
    tb, ta = segs[i - 1][0][-6:], segs[i][0][-6:]
    x = 'CROSS-TAKE' if tb != ta else ''
    f = ''
    if p > 99.0:
        f = '   <-- outlier, inspect'
        flagged += 1
    print('%4d %7.3f  %8.1f   %6.1f%%                 %s->%s %s%s'
          % (i, t, v, p, tb, ta, x, f))
print()
print('joins above the 99th percentile of ordinary moments: %d of %d' % (flagged, len(joins)))
