import json, sys
TAKES = ['20261001_124457', '20261001_124604', '20261001_124712']
for t in TAKES:
    d = json.load(open('/home/heath/mw/v8/tr/%s.json' % t))
    ws = [w for w in d['words'] if w.get('type') == 'word']
    ev = [w for w in d['words'] if w.get('type') not in ('word', 'spacing')]
    print('#' * 26, t, 'words', len(ws), 'events',
          [(e.get('type'), e.get('text'), round(e.get('start', 0), 2)) for e in ev])
    for i, w in enumerate(ws):
        gap = (w['start'] - ws[i - 1]['end']) if i else 0.0
        mk = ' <<<' if gap > 0.30 else ''
        print('%3d %7.2f %7.2f %-20s lp=%7.3f gap=%.2f%s'
              % (i, w['start'], w['end'], w['text'], w.get('logprob', 0), gap, mk))
    print()
