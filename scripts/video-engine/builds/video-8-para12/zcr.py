"""Zero-crossing rate + band energy: separates a fricative (/s/) from a voiced
tail or room noise. A /s/ is high-ZCR, high-frequency; a vowel decay is
low-ZCR; room noise sits at the floor in both bands."""
import sys, array, subprocess, math
SR = 16000


def pcm(path):
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path,
                          '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True).stdout
    a = array.array('h')
    a.frombytes(raw[:len(raw) // 2 * 2])
    return a


a = pcm(sys.argv[1])
for label, t0, t1 in [(x.split(':')[0], float(x.split(':')[1]), float(x.split(':')[2]))
                      for x in sys.argv[2:]]:
    i0, i1 = int(t0 * SR), int(t1 * SR)
    seg = a[i0:i1]
    n = len(seg)
    zc = sum(1 for k in range(1, n) if (seg[k - 1] < 0) != (seg[k] < 0))
    rms = math.sqrt(sum(float(x) * x for x in seg) / n)
    db = 20 * math.log10(rms / 32768.0) if rms > 0 else -120
    print('%-22s %6.3f-%6.3f  rms=%6.1f dB   ZCR=%5.0f /s' % (label, t0, t1, db, zc * SR / n))
