# Multi-take splice pipeline

Built 2026-09-30 for TREC 20-19 video 7. Replaces the "score whole takes, use
the best one alone" rule that `multi-take-splice-workflow.md` adopted after
video 2 came back choppy.

**Why the reversal.** Video 2 was choppy because it had nine cross-take joins
made by trusting transcript word timestamps as cut points. The problem was
never that splicing is choppy — it was that those joins were built on bad
boundaries. Heath records three takes so the cut can use the best version of
every line; throwing two takes away to dodge a seam gives up the whole point.
So the engineering problem here is **making joins inaudible**, not avoiding
them.

## The three things that make a join inaudible

### 1. Cut on acoustics, never on labels (`sel2.py`)

ElevenLabs `scribe_v1` word timestamps are a guide, not a boundary. On take
`20260930_160955` it labelled the emphatic final "5." of the reveal at
26.64-26.68 — a 40ms word, in a window the envelope shows is pure noise floor.
The real word runs 26.24-26.52. The first build cut there and **silently lost
the payoff word of the whole video**.

`sel2.py` therefore builds a voice-activity map of each take from the audio
itself (20ms RMS envelope, threshold = noise floor + 15dB, 100ms minimum
silence) and snaps every segment edge to a real speech-region edge.

### 2. Size every pad against the silence that actually exists

A flat pad swallows the neighbouring word. With a flat 0.12s tail, take
`20260930_161301`'s "period." ran into the onset of "It" and the render said
*"It, it ends Saturday."* — the exact doubling the old workflow note warns
about, reintroduced by a different route.

    pad = min(0.10, gap_to_adjacent_speech * 0.45)

computed per side, per segment, from that take's own VAD map.

### 3. Crossfade with bleed, so audio and video stay the same length (`cut.py`)

A plain `acrossfade` chain shortens audio by `d * (n-1)`. With 13 joins that is
0.78s of A/V drift by the end. Instead each internal edge is pulled with 30ms
of extra bleed, so the crossfades consume exactly the material they were given:

    sum = S + 0.06*(n-1)  ->  after n-1 crossfades of 0.06  ->  S

Video is hard-concatenated at the nominal timestamps. Visible cuts are wanted;
audible ones are not.

## Verifying it worked, rather than asserting it

`joins2.py` answers "is this join audible" the only way that means anything:
by asking whether the short-time level discontinuity at each join sits inside
the distribution of discontinuities at non-join moments in the same render.
Asking "is there a level change at the join" is useless — there always is, the
speaker starts a new phrase.

Video 7 result: baseline non-join max 5ms jump had median 8.4dB / p99 20.4dB;
**0 of 13 joins exceeded the 99th percentile**, both cross-take joins included.

Always re-transcribe the finished audio and diff it against the intent. That
step, and only that step, caught both defects above.

## Speed

`atempo` preserves pitch — measured f0 median 119-121Hz, identical p10/p90, at
every speed from 1.00 to 1.22. The ceiling is articulation rate and
intelligibility, not pitch, so find it by re-transcribing each speed and
watching confidence. Video 7 chose **1.18** (best sum-logprob of any speed
tested; 1.22 degraded it and pushed the worst word to -0.66).

**Speed is applied in exactly one place** — `setpts=PTS/S` + `atempo=S` after
concat, inside `cut.py`. A second speed stage once caused 18s of A/V drift.

## Files

| file | does |
|---|---|
| `align.py` | locates each script phrase in every take, scores it (disfluencies, doubled words, sum/min logprob, internal hesitation, words-per-second) |
| `sel2.py` | VAD map per take, acoustic edge snapping, gap-proportional pads, emits the segment plan |
| `cut.py` | bleed-compensated crossfade splice + the single speed stage |
| `caps2.py` | burned-in captions built from a transcript of the FINISHED audio, so a caption/audio mismatch is structurally impossible |
| `an.py` | pure-python PCM analysis (no numpy on this box): f0, RMS, envelope |
| `joins2.py` | the join-vs-baseline audibility test |
| `matte2.js` | RVM alpha matte streamed through ffmpeg pipes, with no `sharp` dependency (sharp is missing from this repo's node_modules; onnxruntime-node is present). Needs `NODE_PATH=<repo>/node_modules`. |

`align.py`'s `UNITS` list is per-script and must be edited for a new video.
Everything else is script-agnostic.
