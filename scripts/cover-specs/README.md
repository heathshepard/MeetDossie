# Cover specs

One JSON per video, consumed by `node scripts/generate-video-cover.js --spec <file>`.

A spec exists so a cover is **reproducible** — the frame, the crop and the words are
recorded, not retyped from shell history. Re-running a spec yields a byte-identical
cover, so regenerating a whole grid is safe.

## Fields

| field | meaning |
|---|---|
| `id` | `video_library.id`. Also seeds the accent colour when `accent` is omitted. |
| `video` | source mp4 the face frame is pulled from |
| `face-ts` | timestamp (seconds) of the frame to use — pick one with his **eyes open** and looking at camera |
| `face-rect` | `x:w:y:h` in the source's 1080x1920 frame: the head-and-shoulders box to cut out |
| `head-box` | `x:w:y:h` of his HEAD *within that cut-out*. Drives scale and centring. |
| `mask` | optional `rx:ry:cyFrac` override for the ellipse that hides the background |
| `hook` | 3-5 words, the specific claim. Not a byline, not the brand name. |
| `kicker` | small line above (e.g. `TEXAS AGENTS`); optional |
| `accent` | optional; omit to let the id pick one and keep neighbouring tiles distinct |
| `out` | where to write. Always `{video stem}.cover.png` next to the mp4 so that `scripts/queue-finished-videos.py` finds it. |

## Picking the numbers

`face-ts` / `face-rect` / `head-box` are set by eye today. Contact-sheet the video,
pick a frame, then crop-probe it to read off the boxes. They are explicit rather than
auto-detected because the RFB-320 ONNX weights that
`scripts/video-engine/face-detect-lib.js` needs are not installed here — there is no
`scripts/video-engine/models/`. Wiring that detector up to fill these three fields is
the obvious next improvement.

## The test that matters

Render the cover, then look at `{out}_square.png` **at 150px**. That is the real size
of a tile on a phone grid. If his face is not instantly recognisable and the hook is
not readable at that size, the cover has failed regardless of how good it looks at
full resolution.
