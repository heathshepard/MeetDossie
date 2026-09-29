# HEATH PHOTO SHOT LIST — cover-image bank
**Rewritten 2026-09-22 by Sage.** (A version existed 2026-09-21 and was lost with an orphaned git
worktree. This is the rebuild, written against the actual sample covers rather than from memory.)

**Purpose:** one photo bank that feeds every video cover image we generate, so we stop pulling
frame-grabs out of video files. Every face in `Media/covers-proto/` today is a still lifted from
`dossie_trial_01` — headphones on, kitchen cabinets behind him, blown-out window on the right.
That is what these shots replace.

---

## READ FIRST

**Do not shoot in the laundry room.** Hard surfaces made the 2026-09-21 recording sound hollow
and no plugin fully removes reverb (`founder-video-recording-rules`). Even though this is a
*photo* shoot, shoot it in the room you will record video in next — a room with soft furnishings:
couch, rug, curtains, bed, upholstered chairs. You are scouting the audio room and banking photos
at the same time. If the room sounds dead when you clap once, it's the right room.

**No over-ear headphones.** In any frame. Ever.

**Shoot wider than the crop.** Every one of these gets cropped by a generator, and three of the
four layouts crop differently. Frame the *person*, not the composition — leave headroom and leave
space below the chin. A shot that is already perfectly composed is a shot that can only be used
one way.

---

## THE FOUR LAYOUTS YOU ARE FEEDING

Consumed by `scripts/video-engine/gen-cover.js`. Sample output: `Media/covers-proto/`. Existing
face sources are `Media/covers-proto/faces/*.png` at **1700 x 1900** (aspect 0.895).

| Layout | What it looks like | What it needs from a photo |
|---|---|---|
| **`face-headline`** | Big headline top-left; a tall face panel bottom-right bleeding off the right and bottom edges. See `01-pain-almost-lost-my-mind` and `06-tell-me-what-youd-want`. | Panel is roughly **0.65 tall-portrait**. His head sits in the **top 45%** of that panel, chin near the panel's vertical middle, chest and shoulders running off the bottom. Needs a **chest-up** frame with real space below the chin. He sits slightly **right of center**; the left edge of the panel should be background, not shoulder. |
| **`face-icons`** | Headline + a 6-tile icon grid + a **shorter, near-square** face panel bottom-right. See `02-everything-in-your-head`. | Panel is roughly **square**. Head fills ~60% of it. Needs a **tighter head-and-shoulders** crop available from the same frame. |
| **`face-shot`** | Product screenshot in the middle + a small **circular** face badge, ~350 px diameter, bottom-left. See `03-trec-deadlines-real-ui` and `05-morning-brief-real-ui`. | Must read as a face at **350 px**. Eyes centered in the circle, nothing distracting behind the head, expression legible at thumbnail size. Squinting or a half-blink is invisible at full size and obvious at 350 px. |
| **`text-hero`** | **Dark navy** background, headline only, small circular badge ~290 px bottom-right. See `04-why-i-started-building`. | Same circular requirement, but it sits on navy `#1A1A2E`. A shot with a blown-out white window behind his head punches a hole in the dark layout. Needs at least a few frames with a **darker, moodier** background. |

**Practical translation:** shoot **portrait 4:3**, **chest-up**, subject slightly right of center,
with headroom above and room below the chin. That single framing yields all four crops. Anything
tighter than chest-up kills `face-headline`.

---

## TECHNICAL SETUP — one person, one phone, one tripod

| Setting | Value | Why |
|---|---|---|
| Orientation | **Portrait**, 4:3, highest resolution | Every crop is portrait or square. 16:9 landscape throws away the pixels you need. |
| Camera | **Rear camera**, not the selfie cam | Selfie cam is softer and distorts a face at close range. Frame with the timer, not the screen. |
| Distance | **5–6 feet**, phone at **eye height** | Closer than 4 ft and his nose grows. Phone below eye height is the single worst thing you can do to a face. |
| Tripod height | Lens level with his eyes, dead level (no tilt) | A tilted phone makes verticals lean and the crops look drunk. |
| Light | One **window at 45 degrees** off his face, him facing *into* it. Overcast is ideal. | No hard shadow, no raccoon eyes, no blown window behind him. |
| Never | Window **behind** him | That's the current problem in `02-everything-in-your-head`. |
| Ceiling lights | **Off**, or at least not the only source | Overheads make eye sockets dark. |
| Shutter | **3-second timer, burst of 5** per shot | One blink ruins a single frame; five frames always has a keeper. |
| Format | JPEG or HEIC, whichever is default — don't overthink it | The generator resizes anyway. |
| Focus/exposure | **Tap his face, then lock** (long-press) before each group | Auto-exposure drifting between frames makes a bank unusable. |
| Glasses | Tilt the arms down **2–3 mm at the ears** so the lenses angle slightly forward | Kills the window reflection without the glasses looking crooked. |
| Background distance | Stand **4+ feet off the back wall** | Separation. A face pressed against a wall reads flat at 350 px. |

**Before the first shot:** take one test frame, open it, pinch to 100%, look at his eyes. If you
can't see the catchlight, move the window. If you see the window *in his lenses*, tilt the
glasses.

---

## WARDROBE

Bring **three tops** and shoot every group in the one that's on. Don't change mid-group.

| Top | Use | Note |
|---|---|---|
| **A — Navy or charcoal button-down**, sleeves rolled, collar open, no tie | Default. Groups 1, 2, 4. | Reads as a working agent, not a corporate headshot. Contrasts hard against the blush `#F5E6E0` covers. |
| **B — Light grey or oatmeal crew / henley** | Group 3 and the `text-hero` badges. | A dark shirt disappears into the navy `#1A1A2E` background of `text-hero`. Something lighter is mandatory for at least a few badge frames. |
| **C — Plain quarter-zip or a polo**, mid-tone | Group 5, the environment shots. | Optional. Gives the bank a second "day." |

**Do not wear:** anything **coral, blush or salmon** (that's the accent color — he'll merge into
the highlight boxes). Pure white (blows out). Pure black (dies on navy). Fine checks, herringbone
or thin stripes (moiré). **Any KW branding, logo, name badge or lanyard** — this is Dossie
content, and co-branding it confuses whose product it is.

**Grooming:** beard trimmed, hair deliberately anything (it does not need to be neat — §16,
authenticity over polish, and the audience is agents not models). Glasses **clean**. Wipe the
lenses right before you start; smudges are invisible in the room and enormous at 350 px.

---

## THE SHOTS — 20, in 5 groups

> **Read the eyeline column carefully.** "To lens" means to the lens, not to the screen. Put a
> small sticker just above the lens and look at *that*.

### GROUP 1 — THE HERO SET (face-headline)
*The big bottom-right panel. This is the group that does the most work; if you only shoot one
group, shoot this one. Top B in wardrobe, or A.*

**1. The direct address**
- **Framing:** chest-up, subject slightly right of frame center, generous headroom, 6+ inches of space below the chin.
- **Expression:** neutral-serious, mouth closed, relaxed jaw. Not stern, not smiling. The face you make when someone's telling you a number you don't like.
- **Pose/hands:** squared to camera, shoulders down, hands out of frame.
- **Eyeline:** straight to lens.
- **Wardrobe:** A.
- **Background:** room, 4+ ft behind.
- **Feeds:** `face-headline` — the default cover for problem/pain headlines. This replaces `heath-serious.png`.

**2. The mid-sentence**
- **Framing:** identical to #1. Do not move the tripod.
- **Expression:** caught talking — mouth open on a consonant, eyebrows slightly up. Say a real sentence out loud and let the burst catch the middle of it.
- **Pose/hands:** same.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-headline` on question-style headlines ("How many times have you almost..."). Replaces `heath-explaining.png`.

**3. The three-quarter turn**
- **Framing:** same distance; body rotated ~20 degrees to his left so his right shoulder comes forward.
- **Expression:** neutral, slight warmth at the eyes.
- **Pose/hands:** shoulder forward, chin brought back toward camera.
- **Eyeline:** to lens over the near shoulder.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-headline` — the variant that stops the bank looking like one photo used twelve times.

**4. The listening face**
- **Framing:** same as #1.
- **Expression:** attentive, head tipped 5 degrees, mouth closed, eyebrows neutral. The "go on, I'm following" face.
- **Pose/hands:** still.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-headline` on second-person headlines ("Tell me what you'd want Dossie to do"). Replaces `heath-listening.png`.

**5. The flat unimpressed**
- **Framing:** same as #1.
- **Expression:** deadpan. One eyebrow marginally up if it happens naturally, don't force it. The face for "that's not how the option period works."
- **Pose/hands:** still, shoulders square.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-headline` on correction/myth-busting headlines. We have nothing like this today.

**6. The half-smile**
- **Framing:** same as #1.
- **Expression:** closed-mouth half-smile, eyes engaged. Warm but not grinning. A full teeth-out smile reads like a stock headshot and gets rejected under §16.
- **Pose/hands:** still.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-headline` on founder-note and win/result headlines.

### GROUP 2 — THE ICON-PANEL SET (face-icons)
*Shorter, near-square panel. Move the tripod in about a foot, or just plan to crop tighter — but
shoot it deliberately so the crop is clean. Same wardrobe as Group 1, no change.*

**7. Tight neutral**
- **Framing:** head-and-shoulders, head occupying ~55–60% of frame height, still slightly right of center.
- **Expression:** neutral-serious, same as #1.
- **Pose/hands:** square.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-icons` default.

**8. Tight mid-sentence**
- **Framing:** as #7.
- **Expression:** talking, mid-word.
- **Pose/hands:** square.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-icons` on list/enumeration covers ("Remember all of it" + 6 tiles).

**9. Tight, slight lean in**
- **Framing:** as #7, but he leans about 4 inches toward the lens.
- **Expression:** engaged, brows slightly drawn, mouth closed.
- **Pose/hands:** forearms may enter the bottom of frame, resting on a table — that's fine and reads well behind an icon grid.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-icons` on urgency/problem covers.

### GROUP 3 — THE BADGE SET (face-shot and text-hero)
*Small circular crops, 290–350 px. Everything here has to survive being shrunk to the size of a
postage stamp. **Change to wardrobe B for shots 12 and 13.***

**10. Badge neutral, light background**
- **Framing:** head-and-shoulders, head **dead center**, head occupying ~50% of frame height, equal space left and right. Centered, not offset — this is the one group where centering matters, because the circle is centered.
- **Expression:** neutral, eyes wide open and clearly readable, mouth closed, chin very slightly down.
- **Pose/hands:** square, out of frame.
- **Eyeline:** straight to lens. **No looking away in this group at all** — an off-axis eyeline in a 350 px circle reads as shifty.
- **Wardrobe:** A.
- **Background:** the brightest, cleanest part of the room.
- **Feeds:** `face-shot` badge over product screenshots.

**11. Badge warm**
- **Framing:** as #10.
- **Expression:** closed-mouth half-smile, eyes crinkled.
- **Pose/hands:** square.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** same.
- **Feeds:** `face-shot` on positive/result covers; also the fallback avatar anywhere in the app.

**12. Badge for dark layouts — neutral**
- **Framing:** as #10.
- **Expression:** neutral-serious.
- **Pose/hands:** square.
- **Eyeline:** to lens.
- **Wardrobe:** **B (light grey / oatmeal).**
- **Background:** move him so the background behind his head is a **darker** part of the room — an open doorway, a bookcase, a shaded wall. Not a window.
- **Feeds:** `text-hero` badge on the navy `#1A1A2E` covers. Without this shot, every dark cover has a bright halo around his head.

**13. Badge for dark layouts — engaged**
- **Framing:** as #12.
- **Expression:** mid-sentence or half-smile, whichever comes out natural in the burst.
- **Pose/hands:** square.
- **Eyeline:** to lens.
- **Wardrobe:** B.
- **Background:** same dark field as #12.
- **Feeds:** `text-hero` variant, so founder-note covers aren't all the same badge.

### GROUP 4 — THE PRACTITIONER SET (authority, hands, paper)
*This is the group we have zero of, and it is the group that proves he's a working agent rather
than a founder with a laptop. Back to wardrobe A.*

**14. Contract in hand, reading**
- **Framing:** chest-up, printed TREC 20-19 held at chest height, angled so the page is legible-ish but not readable (we don't want a specific legible clause locking the image to one topic).
- **Expression:** concentrating, eyes down on the page, mouth closed.
- **Pose/hands:** both hands on the document, thumbs visible.
- **Eyeline:** **down at the page**, not at the lens.
- **Wardrobe:** A.
- **Background:** room.
- **Feeds:** `face-headline` on contract-education covers — the whole TREC series. Also a legitimate `text-hero` full-bleed background if it's shot clean.

**15. Contract in hand, looking up**
- **Framing:** as #14.
- **Expression:** looking up from the page mid-thought, eyebrows slightly raised.
- **Pose/hands:** document still up, one hand now pointing at a line on it.
- **Eyeline:** **to lens**, over the top of the page.
- **Wardrobe:** A.
- **Background:** room.
- **Feeds:** `face-headline` for the TREC shorts series. This is the single most on-brand frame in the whole list — it is the literal picture of the content.

**16. The count-off**
- **Framing:** chest-up, subject slightly right of center.
- **Expression:** mid-explanation.
- **Pose/hands:** one hand up at chest height, **two fingers extended**, counting. Hand well below the chin so it doesn't crop into the face.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** room.
- **Feeds:** `face-icons` on numbered covers ("three things every offer needs").

**17. The open palm**
- **Framing:** chest-up.
- **Expression:** explaining, relaxed.
- **Pose/hands:** one open palm turned slightly up at chest height — the "here's the thing" gesture. Fingers relaxed, not splayed.
- **Eyeline:** to lens.
- **Wardrobe:** A.
- **Background:** room.
- **Feeds:** `face-headline` on explainer covers. Also the best single frame for a thumbnail with a lot of headline text.

### GROUP 5 — ENVIRONMENT (backgrounds and full-bleed)
*Wider frames with room for text over them. Nobody's face has to be readable in these. Wardrobe C
if you want the visual variety, otherwise stay in A.*

**18. At the desk, working, wide**
- **Framing:** **wide**, portrait, him at the left third of frame at a desk with a laptop open; the right two-thirds is empty wall/room.
- **Expression:** working. Not performing.
- **Pose/hands:** typing or holding a pen over a printed page.
- **Eyeline:** **at the screen**, not the camera.
- **Wardrobe:** C or A.
- **Background:** whatever the room is. Lived-in is correct here.
- **Feeds:** `text-hero` full-bleed with a dark gradient over the empty side. The "you didn't get your license to do this at 10pm" cover.

**19. The over-shoulder**
- **Framing:** camera behind and slightly above his right shoulder, laptop or printed contract visible in the lower frame, his head soft in the foreground.
- **Expression:** n/a, face mostly out of shot.
- **Pose/hands:** hand on the trackpad or the page.
- **Eyeline:** n/a.
- **Wardrobe:** any.
- **Background:** the screen / the page is the subject.
- **Feeds:** `text-hero` and `face-shot` background plates. Also stills for video B-roll under §9 of the Creative Director Standard, which requires B-roll to illustrate what's being said.

**20. The empty room, no person**
- **Framing:** wide portrait of the room — the desk, the chair, the contract on the table, nobody in it.
- **Expression:** n/a.
- **Pose/hands:** n/a.
- **Eyeline:** n/a.
- **Wardrobe:** n/a.
- **Background:** the whole frame is background.
- **Feeds:** `text-hero` when a cover shouldn't have a face on it at all. We currently have nothing for this and default to a flat gradient, which is why the dark covers look like SaaS stock.

---

## BACKUPS — 4 more, shoot if there's light left

**B1. Hero set, wardrobe B.** Repeat shots #1, #2 and #6 in the light top. Insurance for any
cover where the navy shirt collides with the layout.

**B2. Arms crossed, chest-up.** Neutral expression, to lens, wardrobe A. Reads as "I'll wait."
Useful on contrarian-opinion covers. Only one frame needed — it's a strong pose and overusing it
gets smug.

**B3. Phone to ear, three-quarter.** Standing, mid-call, looking off-camera. Feeds any cover
about client communication, the "your phone is the transaction" angle.

**B4. Laughing, genuine.** Say something actually funny and burst it. Do not pose this one. Per
`docs/NICHE-VIDEO-RESEARCH-2026-09-22.md` §5a, the longest-running ad in the entire
transaction-coordination category — **903 days** — is a TC laughing about what agents expect TCs
to do. If we ever make that video, this is its cover, and a fake laugh will kill it.

---

## TOTAL SHOOT TIME

| Phase | Time |
|---|---|
| Room selection + clap test, move a lamp, clear the background | 12 min |
| Tripod set, test frame, exposure lock, glasses check | 8 min |
| Group 1 — hero set (6 shots) | 12 min |
| Group 2 — icon panel (3 shots) | 5 min |
| Group 3 — badges, incl. one wardrobe change (4 shots) | 10 min |
| Group 4 — practitioner set (4 shots) | 10 min |
| Group 5 — environment (3 shots) | 8 min |
| Backups (4) | 8 min |
| Review at 100% zoom, delete blinks, keep 3 per shot | 10 min |

**~85 minutes door to door.** Drop Group 5 and the backups and it's **55 minutes** for everything
the four layouts actually require.

---

## DELIVERY

Drop the keepers here, named by shot number and description:

```
/mnt/c/Users/Heath/Projects/MeetDossie/Media/covers-proto/faces/
    01-direct-address.jpg
    02-mid-sentence.jpg
    ...
    15-contract-looking-up.jpg
```

and the wide/environment plates here:

```
/mnt/c/Users/Heath/Projects/MeetDossie/Media/covers-proto/plates/
    18-desk-wide.jpg
    19-over-shoulder.jpg
    20-empty-room.jpg
```

**Three keepers per shot, not one.** The generator picks per cover; a bank with one option per
expression produces twelve covers that look identical, which is exactly the "generic social-media
template" failure the Creative Director Standard §1 lists first.

Leave them full resolution. The generator downsamples; it can't upsample. Existing faces are
1700 x 1900 and that is the floor, not the target.

---

## THE BAR

Before you call the bank done, open three shots at 100% and ask:

1. Are the **eyes sharp**? Not the beard, not the collar — the eyes. If the eyes are soft, reshoot.
2. Is there a **window reflected in the glasses**? Tilt and reshoot.
3. At **350 px**, can you tell what expression that is? Shrink it and look. If it's ambiguous, it's a dead badge.
4. Does he look like **a real agent in a real room**, or like a founder posing for a SaaS landing page? §16 — authenticity over polish, and the audience here can smell the difference immediately.
