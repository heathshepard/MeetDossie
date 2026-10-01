"""Burned-in captions, built from a transcript of the FINISHED audio.

Deriving captions from the rendered master (rather than re-mapping source word
timings through the splice arithmetic) makes a caption/audio mismatch
structurally impossible -- there is only one timeline.

Style line and pop-in are LOCKED by founder-video-production-standard.md §4 and
must not be altered: Plus Jakarta Sans ExtraBold 80, BorderStyle 3, Outline 20,
Alignment 2 (bottom-centre), MarginV 1005 -> baseline ~y915, above the CTA card
and clear of his head. 3-word / 19-char / 0.4s-gap chunking.
"""
import json, re, sys

SUPP = float(sys.argv[1])        # suppress captions until the hook card clears
OUT = sys.argv[2]

d = json.load(open('/home/heath/mw/v8/sp/tr_c.json'))
ws = [w for w in d['words'] if w.get('type') == 'word']

# Scribe renders his spoken "two percent" / "three percent" / "one percent"
# inconsistently -- sometimes as words, sometimes as "2%"/"3%"/"1%". The numeral
# is both shorter on screen and the form's own unit, so normalise TO the numeral
# and drop the now-redundant "percent". Captions still match the audio word for
# word in meaning; this only changes how the number is written.
NUM = {'two': '2%', 'three': '3%', 'one': '1%'}
fixed = []
skip = False
for i, w in enumerate(ws):
    if skip:
        skip = False
        continue
    k = w['text'].strip().lower().rstrip('.,')
    nxt = ws[i + 1]['text'].strip().lower().rstrip('.,') if i + 1 < len(ws) else ''
    if k in NUM and nxt == 'percent':
        tail = ws[i + 1]['text'].strip()[len(nxt):]
        fixed.append({'text': NUM[k] + tail, 'start': w['start'], 'end': ws[i + 1]['end']})
        skip = True
    else:
        fixed.append({'text': w['text'], 'start': w['start'], 'end': w['end']})
ws = fixed
for w in ws:
    w['text'] = w['text'].replace('"', '').replace("'", "'")

HDR = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Plus Jakarta Sans ExtraBold,80,&H00FFFFFF,&H00FFFFFF,&H00101010,&H00101010,-1,0,0,0,100,100,1,0,3,20,0,2,80,80,1005,1

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
if cur:
    chunks.append(cur)

POP = r'{\fad(40,60)\t(0,90,\fscx105\fscy105)\t(90,160,\fscx100\fscy100)}'
ACC = r'{\c&H43C5F5&}'          # BGR -- the warm gold accent
WHT = r'{\c&HFFFFFF&}'
# Accent the NUMBERS only. The first pass also gold-accented SHALL/NOT/CHANGE,
# which made the whole "SHALL NOT CHANGE." caption gold -- and that caption lands
# on top of the 55%-black scrim behind the clause cutaway, where gold on near-
# black reads far weaker than the white-on-black everywhere else. An accent that
# covers every word in the chunk is not an accent anyway. The emphasis on that
# line is carried by the coral highlight drawn on those exact words in the form.
EMPH = {'2%', '3%', '1%', '12B', '12B.'}

ev = []
for ci, c in enumerate(chunks):
    s = c[0]['start']; e = c[-1]['end'] + 0.12
    if ci + 1 < len(chunks):
        e = min(e, chunks[ci + 1][0]['start'] - 0.02)
    if e <= s:
        e = s + 0.25
    if e <= SUPP:
        continue
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
