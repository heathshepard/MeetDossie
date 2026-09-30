"""Pure-python audio analysis: f0 (pitch preservation), RMS, and per-join continuity.

No numpy on this box, so everything runs on array('h') at 8 kHz mono.
"""
import array, subprocess, sys, math, json

SR = 8000

def pcm(path):
    raw = subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR),
         '-f', 's16le', '-'], capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    return a

def rms(a, i, j):
    j = min(j, len(a)); i = max(0, i)
    if j <= i: return 0.0
    s = 0
    for k in range(i, j):
        s += a[k] * a[k]
    return math.sqrt(s / (j - i))

def db(x):
    return 20 * math.log10(x / 32768.0) if x > 0 else -120.0

def f0_frame(a, off, n=1024, lo=60, hi=320):
    """autocorrelation f0 on one frame; returns Hz or None if unvoiced"""
    if off + n > len(a): return None
    f = a[off:off + n]
    mean = sum(f) / n
    f = [x - mean for x in f]
    e0 = sum(x * x for x in f)
    if e0 / n < 2.0e5:          # too quiet to be voiced speech
        return None
    lag_lo, lag_hi = int(SR / hi), int(SR / lo)
    best, bestv = None, 0.0
    for lag in range(lag_lo, lag_hi):
        s = 0.0
        for k in range(0, n - lag, 2):     # stride 2 for speed
            s += f[k] * f[k + lag]
        v = s / (n - lag)
        if v > bestv:
            bestv, best = v, lag
    if best is None or bestv / (e0 / n) < 0.30:
        return None
    return SR / best

def f0_profile(path, step=0.05, tmax=None):
    a = pcm(path)
    dur = len(a) / SR
    if tmax: dur = min(dur, tmax)
    out = []
    t = 0.0
    while t < dur - 0.15:
        v = f0_frame(a, int(t * SR))
        if v: out.append(v)
        t += step
    return out, a

def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else 0.0

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'pitch':
        for p in sys.argv[2:]:
            vs, a = f0_profile(p)
            vs = [v for v in vs if 70 < v < 260]
            lo = sorted(vs)[int(len(vs) * .1)] if vs else 0
            hi = sorted(vs)[int(len(vs) * .9)] if vs else 0
            print('%-24s dur=%6.2fs voiced=%4d  f0 median=%6.1fHz  p10=%5.1f p90=%5.1f'
                  % (p.split('/')[-1], len(a) / SR, len(vs), med(vs), lo, hi))
    elif mode == 'joins':
        path = sys.argv[2]; meta = json.load(open(sys.argv[3]))
        a = pcm(path)
        W = int(0.08 * SR)
        print('join   t(s)   before_dB  after_dB   step   cross-take')
        bad = 0
        for i, t in enumerate(meta['joins'], start=1):
            c = int(t * SR)
            b = db(rms(a, c - W - int(0.02 * SR), c - int(0.02 * SR)))
            f = db(rms(a, c + int(0.02 * SR), c + W + int(0.02 * SR)))
            x = 'YES' if i in meta['cross_take'] else ''
            flag = ''
            if abs(b - f) > 6.0: flag = '  <-- STEP'; bad += 1
            print('%4d %7.3f  %8.1f  %8.1f  %6.1f   %-4s%s' % (i, t, b, f, f - b, x, flag))
        print('joins with >6dB step: %d' % bad)
