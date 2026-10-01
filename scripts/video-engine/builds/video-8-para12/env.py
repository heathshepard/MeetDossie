"""20ms RMS envelope over a source window -- find true acoustic word boundaries
where scribe's timestamps are unreliable."""
import sys, array, subprocess, math
SR = 8000


def pcm(path):
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path,
                          '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    return a


def rms(a, i, j):
    j = min(j, len(a)); i = max(0, i)
    if j <= i:
        return 0.0
    s = 0
    for k in range(i, j):
        s += a[k] * a[k]
    return math.sqrt(s / (j - i))


def db(x):
    return 20 * math.log10(x / 32768.0) if x > 0 else -120.0


path, a0, b0 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
a = pcm(path)
F = int(0.02 * SR)
t = a0
print('t(s)     dB   bar')
while t < b0:
    v = db(rms(a, int(t * SR), int(t * SR) + F))
    bar = '#' * max(0, int((v + 60) / 2))
    print('%6.3f %6.1f  %s' % (t, v, bar))
    t += 0.02
