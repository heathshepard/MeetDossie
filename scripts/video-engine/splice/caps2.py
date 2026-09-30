"""Burned-in captions, built from a transcript of the FINISHED audio.

Deriving captions from the rendered master (rather than re-mapping source word
timings through the splice arithmetic) makes a caption/audio mismatch
structurally impossible -- there is only one timeline.

Style line and pop-in are locked and must not be altered.
"""
import json, re, sys

SUPP = float(sys.argv[1])        # suppress captions until the hook card clears
OUT = sys.argv[2]

d = json.load(open('/home/heath/mw/v7/sp/tr_final.json'))
ws = [w for w in d['words'] if w.get('type') == 'word']

# scribe mishears one word: he says "anyway", it writes "anymore".
# All three source transcripts agree on "anyway". Captions follow the audio.
FIX = {'anymore.': 'anyway.', 'anymore': 'anyway'}
for w in ws:
    k = w['text'].strip()
    if k.lower() in FIX:
        w['text'] = FIX[k.lower()]
    w['text'] = w['text'].replace('5:00', '5:00').replace('"', '')

HDR = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Plus Jakarta Sans ExtraBold,80,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC0000000,-1,0,0,0,100,100,1,0,3,20,0,8,80,80,175,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

def ts(t):
    t = max(0, t); h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return '%d:%02d:%05.2f' % (h, m, s)

# chunk: 3 words OR 19 chars OR gap > 0.4s
chunks, cur = [], []
for w in ws:
    if cur:
        gap = w['start'] - cur[-1]['end']
        txt = ' '.join(x['text'] for x in cur)
        if len(cur) >= 3 or len(txt) >= 19 or gap > 0.4:
            chunks.append(cur); cur = []
    cur.append(w)
if cur: chunks.append(cur)

POP = r'{\fad(40,60)\t(0,90,\fscx105\fscy105)\t(90,160,\fscx100\fscy100)}'
ACC = r'{\c&H43C5F5&}'          # BGR -- the warm gold accent
WHT = r'{\c&HFFFFFF&}'
EMPH = {'SATURDAY', 'SATURDAYS', '500', '5', 'PM', 'MONDAY', 'NOT', 'NONE',
        'LOST', 'OPTION', 'WEEKEND', 'TERMINATION'}

ev = []
for ci, c in enumerate(chunks):
    s = c[0]['start']; e = c[-1]['end'] + 0.12
    if ci + 1 < len(chunks):
        e = min(e, chunks[ci + 1][0]['start'] - 0.02)
    if e <= s: e = s + 0.25
    if e <= SUPP: continue
    s = max(s, SUPP)
    parts = []
    for w in c:
        clean = re.sub(r"[^A-Za-z0-9%']", '', w['text']).upper()
        t = w['text'].upper()
        parts.append(ACC + t + WHT if clean in EMPH else t)
    ev.append('Dialogue: 0,%s,%s,Cap,,0,0,0,,%s%s' % (ts(s), ts(e), POP, ' '.join(parts)))

open(OUT, 'w').write(HDR + '\n'.join(ev) + '\n')
print('%s -- %d events, %d chunks (suppressed before %.2fs)' % (OUT, len(ev), len(chunks), SUPP))
for ci, c in enumerate(chunks):
    print('  %6.2f-%6.2f  %s' % (c[0]['start'], c[-1]['end'],
                                 ' '.join(x['text'] for x in c).upper()))
