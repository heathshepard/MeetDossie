# Video 8 — TREC 20-19 ¶12.B brokerage compensation

Reproducible build recipe for `v8_SPLICED.mp4`, made to the bar set in
`founder-video-production-standard.md` (the standard Heath fixed by approving
v7c on 2026-10-01).

Media is gitignored, so the working tree for this build lives outside the repo
at `/home/heath/mw/v8/` (same layout as `/home/heath/mw/v7/`). These scripts are
the recipe; they all hard-code that path.

## Source

Three takes filmed 2026-10-01, uploaded to the Google Drive folder "Trec forms"
(`1AID-LJPr2KYpXlYb9_foMb87FnHEs0gJ`), 2560x1440 HEVC @30:

| take | id | bytes | duration |
|---|---|---|---|
| `20261001_124457` | `1q3FZNn99_pQRc7NuLLCAMoioqmhsX_q2` | 152,311,676 | 56.44s |
| `20261001_124604` | `1yLGvg1awHeMfVPwDGIaVjYxxOqKkMaaS` | 155,400,712 | 57.58s |
| `20261001_124712` | `1dGY4_lAhOUHZ1qW7aHiu3pRRdgvzoM9L` | 152,046,236 | 56.34s |

## Order of operations

```
ffmpeg -i src/$T.mp4 -vn -ac 1 -ar 16000 wav/$T.wav   # per take
scribe  wav/$T.wav -> tr/$T.json                       # ElevenLabs scribe_v1, word timestamps
python3 words.py                                       # per-take word dump w/ logprobs (take selection)
python3 sel.py plan_f.json                             # VAD map -> segment list   -> v8_plan.json
python3 edgecheck.py                                   # did any cut edge clip a consonant?
python3 cut.py 1.18 v8_master.mov                      # spliced master (video)
python3 cut.py 1.18 v8_voice.wav audio                 # spliced master (audio) -- the one that ships
node   matte2.js --in v8_master.mov --w 640 ...        # RVM alpha -> alpha8.mkv
scribe  sp/voice_c.wav -> sp/tr_c.json                 # transcript of the FINISHED audio
python3 caps.py 2.55 v8.ass                            # captions, from that transcript only
python3 mkchips.py                                     # callout chips
bash mkstrip.sh                                        # blank 20-19 pages 6-8 -> strip8.png
bash mkbg.sh                                           # scroll + clause highlights -> bgdoc.mp4
bash mkbg2.sh                                          # clause-recording cutaway  -> bg8.mp4
node   shot.js                                         # hook/CTA card HTML -> PNG
bash mkmov.sh                                          # cards -> qtrle .mov
bash comp.sh                                           # composite               -> v8_pic.mp4
bash mux.sh                                            # music + loudnorm        -> v8_SPLICED.mp4
bash mkcover.sh                                        # 1080x1920 + true 1:1 covers
```

## Gates

```
node ../../check-join-audibility.js --audio v8_voice.wav --joins v8_master.json
node runscriptgate.js      # api/_lib/verify-video-script.js, with deliveredWords
node rungate.js            # api/_lib/verify-video-quality.js
bash musiclevel.sh         # measured ducking depth, not asserted
```

## Two defects this build found and fixed, worth keeping

**The VAD is blind to fricatives.** `sel.py`'s speech map is decoded at 8 kHz and
summed with stride 2 — effectively 4 kHz — so a word-final `/s/` is invisible to
it. The final `/s/` of "box." reads −49 dB there and −28.8 dB at 16 kHz with a
6330/s zero-crossing rate. The first pass cut between the vowel and its own `/s/`
and shipped "bok.", and it split units at "silences" that were really consonant
clusters (deleting the `/nt/` of "percent," and the `/z/` of "words,"). The VAD
itself is unchanged — it is what v7c shipped with — but the two *safety* guards
(`SPLIT_QUIET_DB`, `TAIL_RECOVER_DB`) now run on a full-rate 16 kHz envelope.
They can only ever prevent a deletion, never cause one. `edgecheck.py` is the
check that catches this class of defect.

**`overlay ... eof_action=pass` deletes the subject, it does not hold him.** The
background was built 0.09s longer than the master, so for the last 0.09s the
overlay had no input and the background passed through alone — and `tpad` then
cloned that presenter-less frame for the whole 0.33s outro. 0.42s of the first
render had nobody in it. The background is now pinned to the master's exact
duration (`mkbg.sh`, `D=33.366667`).
