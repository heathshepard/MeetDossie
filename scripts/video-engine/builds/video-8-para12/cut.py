"""Build the spliced master for video 8 from v8_plan.json.

Port of v7's cut.py (the build Heath approved). Join strategy unchanged:
  * every cut lands inside a natural pause, on a real speech-region edge;
  * VIDEO segments hard-concatenate at nominal timestamps -- visible cuts are
    wanted, Heath asked for it to look edited;
  * AUDIO segments carry extra bleed on each internal edge and join with an
    acrossfade sized to the silence that join actually has, so the crossfades
    consume exactly the bleed they were given and audio comes out the SAME
    length as video (a plain chain without bleed drifts out of sync);
  * speed is applied in EXACTLY ONE place: setpts=PTS/S + atempo=S after
    concat. Applying it twice once caused an 18-second A/V drift.
"""
import json, subprocess, sys, os

BASE = '/home/heath/mw/v8'
plan = json.load(open('%s/v8_plan.json' % BASE))
segs = plan['segs']
SPEED = float(sys.argv[1])
OUT = sys.argv[2]
AUDIO_ONLY = len(sys.argv) > 3 and sys.argv[3] == 'audio'

TAKES = ['20261001_124457', '20261001_124604', '20261001_124712']
IDX = {t: i for i, t in enumerate(TAKES)}
BLEED = 0.03
VF = 'crop=1080:1920:180:340,setsar=1,format=yuv420p'

parts = []
n = len(segs)
# Each join's crossfade is sized to the silence that join actually has. The
# bleed must never reach past the retained silence or it pulls in the
# neighbouring word -- the bug that ate v7's reveal. Half-width capped at 80%
# of the smaller pad at that join.
bleed = [0.0] * n
for i in range(1, n):
    bleed[i] = min(BLEED, 0.8 * min(segs[i - 1][4], segs[i][3]))
    assert bleed[i] >= 0.012, 'join %d has only %.3fs of silence' % (i, bleed[i])
for i, (take, b, e, _hp, _tp) in enumerate(segs):
    src = IDX[take]
    if not AUDIO_ONLY:
        parts.append('[%d:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS,%s[v%d]' % (src, b, e, VF, i))
    hb = bleed[i]
    tb = bleed[i + 1] if i < n - 1 else 0.0
    parts.append('[%d:a]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS,'
                 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a%d]'
                 % (src, max(0.0, b - hb), e + tb, i))

acc = 'a0'
for i in range(1, n):
    out = 'x%d' % i
    parts.append('[%s][a%d]acrossfade=d=%.4f:c1=tri:c2=tri[%s]' % (acc, i, 2 * bleed[i], out))
    acc = out
parts.append('[%s]highpass=f=75,atempo=%.5f,aresample=48000[ao]' % (acc, SPEED))

if not AUDIO_ONLY:
    parts.append(''.join('[v%d]' % i for i in range(n)) +
                 'concat=n=%d:v=1:a=0[vc];[vc]setpts=PTS/%.5f,fps=30[vo]' % (n, SPEED))

fc = ';'.join(parts)
cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
for t in TAKES:
    cmd += ['-i', '%s/src/%s.mp4' % (BASE, t)]
cmd += ['-filter_complex', fc]
if AUDIO_ONLY:
    cmd += ['-map', '[ao]', '-c:a', 'pcm_s16le', '-ar', '48000', OUT]
else:
    cmd += ['-map', '[vo]', '-map', '[ao]', '-c:v', 'libx264', '-crf', '16',
            '-preset', 'medium', '-r', '30', '-c:a', 'pcm_s16le', '-ar', '48000', OUT]

raw = sum(s[2] - s[1] for s in segs)
print('%d segs, raw %.3fs -> /%.3f = %.3fs' % (n, raw, SPEED, raw / SPEED), file=sys.stderr)
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    print(r.stderr[-3000:])
    sys.exit(1)

offs = []
acc_t = 0.0
for take, b, e, _h, _t in segs:
    offs.append([take, b, e, round(acc_t / SPEED, 4)])
    acc_t += e - b
meta = {'segs': segs, 'speed': SPEED, 'offsets': offs, 'total': round(acc_t / SPEED, 4),
        'joins': [round(sum(segs[k][2] - segs[k][1] for k in range(i)) / SPEED, 4) for i in range(1, n)],
        'cross_take': [i for i in range(1, n) if segs[i][0] != segs[i - 1][0]]}
json.dump(meta, open(os.path.splitext(OUT)[0] + '.json', 'w'), indent=1)
print('OK %s  total=%.3f' % (OUT, meta['total']))
