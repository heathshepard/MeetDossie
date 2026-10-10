# Short-form build specs of record

One `*.spec.json` per finished video built by `scripts/build-shortform-video.py`,
plus the `*.vo-*.txt` script each voice clip was synthesised from
(`scripts/gen-listing-voiceover.py --voice-id 6rOxfAnZpbM3VIEhFaeV` for Dossie/Luna).

A spec here is the record of HOW the mp4 that reached `video_library` was made:
capture window per segment, crop, zoom, caption style, VO offsets, card copy. The
captured frames it points at live outside the repo (`/mnt/c/Users/Heath/dossie-cap-*`)
and are not committed; the spec plus those frames rebuilds the file byte-for-byte:

```
python3 scripts/build-shortform-video.py --spec <spec> --out <mp4> --work <workdir> --cover-out <hook.png>
node scripts/emit-vo-transcript-sidecar.js --spec <spec> --video <mp4>
```

Covers for these come from `scripts/cover-specs/<id>.json` via
`scripts/generate-video-cover.js`, written to `scripts/headless-video/covers/`.

## 2026-10-09 — the two Dossie product rerenders

`dossie-talk-to-dossie-1005` and `dossie-trec-deadlines-1005` failed the gate's
`captions_box_readable` rule twice each. Looking at the frames (not the gate):
3-word cues at size 88 render boxes as narrow as ~230px, below the 35%-of-row
width the gate scans for, and on the talk video they sat directly on Dossie's
answer bubble. Both also narrated in Heath's clone on Dossie-branded content and
the deadlines spec started clip 1 while clip 0 was still speaking. The `_rebuild`
key in each spec lists every change; `captions.band_width` is the new builder
option that draws a fixed-width opaque band under every cue.
