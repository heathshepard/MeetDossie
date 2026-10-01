"""Callout chips -- annotations on the document, deliberately quieter than the
captions (v7c's lesson: the decoration must never out-weigh the words).

Frame coordinates, applied after the crop. Both sit in the band between the
12B(2) line (frame y ~581 at the park) and the caption baseline (~y915), so
they annotate the boxes without covering them or the captions. Sage reads as
the money coming IN under 12B(1); coral as what is still owed, matching the
coral used on "shall not change".

Cues, from the finished-audio transcript:
  16.72 "So the seller's 2% comes in"        -> sage chip  16.80
  19.90 "the other 1% at closing"            -> coral chip 19.40
  20.78 "closing." ends                      -> both out   20.90
"""
HDR = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ChipS,Plus Jakarta Sans ExtraBold,40,&H00101A10,&H00101A10,&H0088A88B,&H0088A88B,-1,0,0,0,100,100,1,0,3,12,0,7,0,0,0,1
Style: ChipC,Plus Jakarta Sans ExtraBold,40,&H00FFFFFF,&H00FFFFFF,&H003C58D1,&H003C58D1,-1,0,0,0,100,100,1,0,3,12,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ts(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return '%d:%02d:%05.2f' % (h, m, s)


POP = r'{\fad(90,120)\t(0,110,\fscx104\fscy104)\t(110,190,\fscx100\fscy100)}'

ev = [
    ('ChipS', 16.80, 20.90, 96, 640, 'SELLER PAYS 2%'),
    ('ChipC', 19.40, 20.90, 600, 640, 'BUYER OWES 1%'),
]

lines = []
for style, s, e, x, y, txt in ev:
    lines.append('Dialogue: 0,%s,%s,%s,,0,0,0,,%s{\\an7\\pos(%d,%d)}%s'
                 % (ts(s), ts(e), style, POP, x, y, txt))

open('/home/heath/mw/v8/chips.ass', 'w').write(HDR + '\n'.join(lines) + '\n')
print('chips.ass -- %d chips' % len(ev))
