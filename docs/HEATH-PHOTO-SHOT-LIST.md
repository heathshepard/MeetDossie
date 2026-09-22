# Heath photo shot list — one session, 20 shots

**What this is for.** `scripts/video-engine/gen-cover.js` builds every Dossie cover out of a real
photo of you. Right now the only footage it has to pull from is `Downloads/22054.mp4`, and every
usable frame in it has you in over-ear headphones, a sleeveless shirt, a lav mic on your chest, lit
by an overhead bulb, in front of an LG washer-dryer and an open linen cabinet. That is the laundry
room. It is real, so it clears the hard rule, and it is the ceiling on how good a cover can look
until this bank exists.

One session gets you 20 reusable shots. Everything below is specified so you can execute it without
asking a follow-up.

---

## 1. Why these specific shots (evidence, not taste)

- **A real face has to be in frame one.** Every video above 50k views in the competitive benchmark
  has a recognisable human on camera in the cover frame; zero open on a brand card
  (`docs/MARKETING-AUDIT-BENCHMARK-2026-09-18.md` §2). Controlled support: Yang, *Behavioral
  Sciences* 2026 (N=656 / N=769) — human presenter vs AI avatar moved trust 3.78 → 4.63 and purchase
  intention 3.75 → 4.21. A 7,431-video creator dataset puts face-on-camera median views at 1.9× faceless
  (12,503 vs 6,630). Benchmark §3.1 has both citations.
- **Rough beats polished.** Tat Londono's 2.7M-follower videos are a phone selfie with a native text
  box. Stronger's case study: "slightly rough, authentic TikTok content consistently outperforms
  polished ads" (benchmark §1 lane c, §3.5). Creative Director Standard §16: *authenticity is more
  important than polish*, and §5: do not make him look like an AI avatar, natural imperfections are
  acceptable. So: your phone, your house, no ring light halo, no retouching.
- **Batch it.** Glennda Baker shoots 30+ in one sitting and posts daily; Natural Write posted 1/day
  for 90 days (benchmark §3.3). A photo bank is the same logic applied to covers — shoot once,
  publish from it for months.
- **A range of faces, not one headshot.** The four cover templates need four different registers:
  a hook needs a serious face, a pain-point cover needs an exasperated one, a founder note needs a
  warm one. One good headshot cannot carry all of them.

---

## 2. Setup — 12 minutes before the first frame

### Background

**Do not shoot in the laundry room.** Named precisely so there's no ambiguity: the room in
`22054.mp4`, with the LG washer/dryer panel over your left shoulder, the open upper cabinet with
folded linens, the botanical wallpaper, the gold towel ring and the skirted folding counter.

That take is the only footage of you I have, so I can't name a second room in your house from
evidence. Run this 60-second test instead and pick two:

1. Stand where you'd sit. Is there **6+ feet of depth behind you**? (Depth is what makes a phone
   photo not look like a mugshot.) A doorway into another room, a hallway, or the long side of the
   living room all pass. A wall two feet behind your head fails.
2. Nothing with **text, a logo, or an appliance panel** in frame.
3. Nothing with a **busy repeating pattern** — the botanical wallpaper is exactly the failure mode.
   Plain, or one large soft shape (a single piece of art, a plant, a bookshelf out of focus).
4. Tones should be **mid or light**. The covers put your photo next to a navy panel on half the
   templates; a dark background plus a dark shirt turns into one black blob at thumbnail size.

Pick **Background A** (clean, neutral — for shots 1-17) and **Background B** (your actual desk with
the monitor on, for shots 18-20). Background B is the one place a little clutter helps: it reads as
"the guy actually builds this."

### Light

- **Face a window.** Window in front of you, not behind you, not to the side if you can help it.
  A window behind you makes the phone expose for the window and leaves your face a silhouette.
- **Turn the overhead light off.** The overhead in `22054.mp4` is directly above you — that's what's
  putting shadow in your eye sockets and a hot shine on your forehead in every frame.
- Best window light: **mid-morning or 2 hours before sunset.** Direct midday sun through glass is
  harsh; if that's all you've got, hang a white sheet over the window.
- Sit/stand **4-6 feet from the window**, not pressed against it.
- **Glasses:** your lenses catch the window in most `22054.mp4` frames. Tip your chin down about
  half an inch, or drop the temple arms a hair so the lenses angle down — the reflection slides off
  the bottom. Check the preview once, then forget it.
- Blot your forehead with a tissue before you start and once in the middle.

### Phone

- **Vertical, 9:16.** Everything downstream is 1080x1920 first.
- **Front camera, video mode, highest resolution your phone offers (4K if available).** Front camera
  because you need to see your own framing, and because that's what actually wins in this niche —
  benchmark §2 lists phone-selfie as the production method on every >50k video sampled.
- **Lens at eye level.** Not below (chin/nostril angle), not above (shrinks you). Stack it on books
  on a counter or use a tripod — the point is it does not move for the whole session.
- **3.5 to 4 feet from your face.** Closer than that distorts your nose; further and the front
  camera gets soft.
- **Lock exposure and focus:** tap and hold on your face until **AE/AF LOCK** appears. Do this once
  per background. This is the single biggest quality difference and it takes two seconds.
- **Framing:** centre yourself, one fist of headroom above your hair, frame cutting around
  mid-chest. The generator re-crops, so don't try to compose for the cover — just be sharp, lit,
  and centred.

### Wardrobe

- **Two solid shirts, no logos, no thin stripes** (stripes moiré on a phone sensor).
- Shirt 1: mid-tone — sage, dusty blue, olive, warm grey. Reads clean against both the blush and the
  navy cover themes.
- Shirt 2: light — white, cream, light blue. This is the one to wear against Background B.
- A collared button-down or a plain crew both work. A blazer does not — it reads corporate, which
  Standard §1 explicitly names as the thing to avoid.
- **Take the headphones off. Take the lav mic off.** No audio is being recorded.

---

## 3. The 20 shots

Shoot them in this order — it runs from easy to emotionally harder, which is the order that
actually works when you're doing it alone.

**For every shot: record 10 seconds of video while doing the thing, then stop.** Do not try to hold
a pose for a still. You are harvesting frames, which is what the generator does anyway (§4), and
your face does something honest in the middle of a sentence that it never does when you're posing.
Where a shot says "say the line," say it out loud — the expression follows the words.

| # | Shot | Expression | Pose / gesture | Eyeline | Framing | Feeds |
|---|---|---|---|---|---|---|
| **A — direct to camera** ||||||
| 1 | Dead serious | Mouth closed, jaw set, no smile at all | Square to camera, still, hands out of frame | Straight into the lens | Chest up | `face-headline`, `text-hero` — the pain hooks |
| 2 | Serious, chin down | Same, chin dropped ~1 inch, eyes looking up into the lens | Square, still | Up into the lens | Shoulders up, tighter | `text-hero` |
| 3 | "I know" half-smile | One corner of the mouth, eyes doing the work | Square, slight head tilt right | Lens | Chest up | `face-headline`, `face-shot` |
| 4 | Lean-in | Neutral-intense, brows slightly down | Lean 4-6 inches toward the lens, elbows on the desk | Lens | Chest up | `face-headline` — hook covers |
| 5 | Eyebrows up | "Can you believe this" — brows high, mouth slightly open | Square, small shrug in the shoulders | Lens | Chest up | `face-icons`, pain covers |
| **B — mid-explanation** ||||||
| 6 | Mid-sentence | Mouth open on a vowel, alive | Say: *"You've got inspections, appraisal, financing, title, earnest money…"* while one hand moves | Lens | Chest up, hand allowed in frame | `face-headline`, `face-shot` |
| 7 | Counting it off | Focused, explaining | Count on your fingers — one, two, three — hand at chest height, inside the frame | Lens | Waist up | `face-icons` |
| 8 | Open palms | Reasonable, matter-of-fact | Both palms up and open at chest height | Lens | Waist up | `face-shot` |
| **C — pointing / gesturing** ||||||
| 9 | Point at the lens | Direct, slight challenge | Index finger extended toward the camera, arm about 2/3 out — **don't jam it into the lens**, it distorts | Lens | Waist up | `face-headline` — the "this is you" covers |
| 10 | Point, held low | Same but calmer | Finger pointed at the lens from chest height, elbow tucked | Lens | Chest up | `text-hero` |
| 11 | Thumb over shoulder | Dismissive/aside | Thumb jerked back over your right shoulder, head turned slightly the other way | Lens | Waist up | `face-shot` |
| **D — confident / authority** ||||||
| 12 | Arms crossed, straight | Neutral, unbothered | Arms crossed, shoulders squared, weight even | Lens | Waist up, standing | `text-hero`, `face-shot` |
| 13 | Arms crossed, half-smile | Warmer version of 12 | Same, torso turned 15° off-axis, head back to the lens | Lens | Waist up, standing | `face-headline` |
| 14 | Hands in pockets | Relaxed authority | Hands in pockets, body 3/4 turned, head square to the lens | Lens | Thigh up, standing | `text-hero`, wide covers |
| **E — pain / exasperation** (the reference cover's whole energy) ||||||
| 15 | Hand to forehead | Eyes closed, brow pinched | Palm or fingertips to the forehead, head tipped forward | Closed | Chest up | `face-icons`, pain covers |
| 16 | Hand over mouth | Staring into the middle distance, worn out | Hand over mouth and chin, elbow propped | **Off-camera**, about 30° to your left | Chest up | `face-icons` |
| 17 | Both hands up | "What am I supposed to do with this" | Both hands up, palms out, shoulders up, mouth slightly open | Lens | Waist up | `face-icons`, `face-headline` |
| **F — warm / human** ||||||
| 18 | Real laugh | Actually laughing | Trick that works: force three sharp exhale-laughs, the fourth one goes real. Record through all four | Lens | Chest up | `text-hero` — founder notes |
| 19 | Warm, talking to one person | Soft, open, small smile | Say: *"If you're an agent, tell me what you'd want Dossie to do."* | Lens | Chest up | `face-headline` (the "tell me" cover), founder covers |
| **G — at work** (Background B, desk, monitor on, a real Dossie page open) ||||||
| 20 | At the laptop | Concentrating, not performing | 3/4 profile, hand on the trackpad, eyes on the screen. Then, without stopping the recording, **look up into the lens** — that gives you two usable frames from one take | Screen, then lens | Waist up, desk in frame | `face-shot`, B-roll |

**Insurance passes (5 extra minutes, worth it):** re-shoot **1, 9, 15, 19** in your second shirt.
Four extra takes, and it doubles the wardrobe options in the bank.

**Time:** 12 min setup + 20 shots × ~90 s = ~30 min + shirt change and Background B move ~8 min +
transfer ~5 min. **Call it 55-60 minutes.**

---

## 4. After the session

Drop the clips in `Media/photo-bank/2026-MM-DD/` named `shot-01.mov`, `shot-02.mov`, … (Media/ is
gitignored, so nothing here gets committed — that's intentional.)

Pull a frame out of any clip:

```bash
cd /mnt/c/Users/Heath/Projects/MeetDossie
~/.local/bin/ffmpeg -ss 4.5 -i Media/photo-bank/2026-MM-DD/shot-01.mov -frames:v 1 \
  Media/covers-proto/faces/heath-serious-v2.png
```

Scrub for the frame first — a 1-frame-per-second contact sheet of a whole clip:

```bash
~/.local/bin/ffmpeg -i Media/photo-bank/2026-MM-DD/shot-01.mov \
  -vf "fps=1,scale=240:-1,tile=5x2" -frames:v 1 /tmp/sheet.png
```

Then build a cover with it:

```bash
node scripts/video-engine/gen-cover.js \
  --headline "How many times have you almost lost your mind on one transaction?" \
  --highlight "almost lost your mind" \
  --kicker "Real estate agents" \
  --template face-headline \
  --photo Media/covers-proto/faces/heath-serious-v2.png \
  --name pain-almost-lost-my-mind
```

If the face sits wrong in the frame, nudge it with `--photo-pos "50% 24%"` rather than re-cropping
the PNG. Add `--guides` to see Instagram's 4:5 and 1:1 centre-crop boxes over the result, and
`--safe tiktok` when the cover is going to TikTok — that profile also clears TikTok's own left,
right and bottom chrome (`docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §3).

Note: `--extract-faces` has crop constants tuned to `22054.mp4` specifically. New footage goes in
through `--photo`, not through `--extract-faces`.

---

## 5. What not to do

- **No ring light.** It puts a donut in your glasses and it is the single most obvious "this is an
  ad" tell. Window light only.
- **No beauty filter, no skin smoothing, no eye-contact correction.** Standard §5 names all three.
- **No stock, no AI-generated stand-in, ever** — not for a placeholder, not "just to test the
  layout." The generator has no slot for one for exactly this reason.
- **Don't shoot against a green screen** hoping for a cut-out. There's no matting model on this
  machine (no `sharp`, no `onnxruntime-node`, no weights), so the covers frame you as a panel or a
  circle instead. If a true cut-out ever becomes worth it, that's a separate decision with a
  separate dependency.
- **Don't do hair and makeup.** Standard §16. The whole point is that you look like an agent who
  actually closes deals, not a SaaS landing page.

---

*Written 2026-09-22 alongside `scripts/video-engine/gen-cover.js`. Sources for every performance
claim are in `docs/MARKETING-AUDIT-BENCHMARK-2026-09-18.md` §1-§3; creative constraints are
`docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md` §5, §9, §13, §16 and the per-platform cover spec is
`docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §3.

Note: `DOSSIE-CREATIVE-DIRECTOR-STANDARD.md` and `MARKETING-AUDIT-BENCHMARK-2026-09-18.md` are
present in the working tree but not yet committed to `staging`, so the two cross-references above
will not resolve for anyone who checks this branch out clean until those land.*
