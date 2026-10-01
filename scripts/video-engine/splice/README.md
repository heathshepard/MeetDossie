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

### 2b. When the VAD cannot separate two words, cut at the envelope minimum

A VAD region only splits on >=100ms of silence. Where Heath runs two phrases
together, the region for the line being KEPT extends into the first syllable of
a line being DROPPED. That shipped an audible "they-" fragment at -23dB:
*"...they call you. [they-]"* before the cut.

So when the word following a unit is not the word the next planned segment
starts with, `sel2.py` pulls the tail back to the quietest 20ms frame between
the two words instead of using the region edge. **The pad must be clamped
against that dropped word too** — a tail trimmed to an envelope minimum sits
*inside* a VAD region, so the next region edge is far away and the
proportional pad happily puts the syllable straight back. 0.09s of pad
restored the -16dB onset of "to" onto the end of "...the end of Monday".

### 3. Crossfade with bleed, so audio and video stay the same length (`cut.py`)

A plain `acrossfade` chain shortens audio by `d * (n-1)`. With 13 joins that is
0.78s of A/V drift by the end. Instead each internal edge is pulled with extra
bleed, so the crossfades consume exactly the material they were given:

    sum = S + 2*sum(b_i)  ->  after crossfades of 2*b_i each  ->  S

The half-width `b_i` is **per join**, capped at 80% of the smaller pad at that
join. A fixed 30ms bleed fails wherever a pad is tighter than that — an
envelope-minimum tail trim can leave 20ms — and the bleed then reaches past the
retained silence into the neighbouring word, which is the original bug.

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
| `caps3.py` | burned-in captions built from a transcript of the FINISHED audio, so a caption/audio mismatch is structurally impossible (`caps2.py` is the superseded top-band version) |
| `an.py` | pure-python PCM analysis (no numpy on this box): f0, RMS, envelope |
| `joins2.py` | the join-vs-baseline audibility test |
| `matte2.js` | RVM alpha matte streamed through ffmpeg pipes, with no `sharp` dependency (sharp is missing from this repo's node_modules; onnxruntime-node is present). Needs `NODE_PATH=<repo>/node_modules`. |

`align.py`'s `UNITS` list is per-script and must be edited for a new video.
Everything else is script-agnostic.

## Caption placement (learned on video 7, the hard way)

Heath watched the first spliced cut and said *"there's no transcriptions."*
They were there, and the quality gate had scored captions 3/3. They were
simply invisible:

- **Opacity.** `BackColour &HC0000000` is alpha 0xC0 — about **25% opaque**,
  not 75%. Over a full-bleed page of 11px contract body text, the document
  read straight through the box. Fully opaque (`&H00101010`) is the only
  setting that survives a dense background.
- **Position.** `Alignment 8` put captions in the top band of a 1920px frame,
  while the face sat bottom-right and every callout was mid-frame. The eye
  never travelled there. `Alignment 2` with `MarginV 1005` puts the caption
  baseline at ~y915 — lower-centre, above the CTA card, clear of his head.
- **Hierarchy.** Callout chips at font 46 were louder than the captions. The
  element carrying the actual words must win: chips went to font 40 and the
  document window moved ~400px so the highlighted clauses sit ABOVE the
  caption band instead of competing with it.

Everything else in the locked Style line is unchanged — typeface, weight,
size 80, colours, `BorderStyle 3`, `Outline 20`, the pop-in, and the
3-words / 19-chars / 0.4s-gap chunking.

**The gate's `captions_present` check passed this.** It samples frames and
asks a vision model whether caption text is visible — which it was, to a model
reading pixels directly. It does not measure contrast between the caption fill
and what is behind it. That check is worth tightening to assert the caption
box is opaque, or to measure local contrast, otherwise it will keep passing
captions a human cannot read.
