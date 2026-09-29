# Heath's Voice Clone — Recording Script V2 (range pass)

Owner: Atlas. Purpose: better source audio for Heath's ElevenLabs voice clone
(`voice_id=i41TA0Q36AUrp4axERi3`, currently an Instant Voice Clone). Same
brand-separation rule as V1: this voice is for Heath's own realtor content
only — never Dossie's, Bill/Luna stay Dossie's voices, enforced in
`scripts/voice-select.js`.

**Why V2 exists.** The first recording (2:01, one continuous calm listing
walk) produced a usable but flat clone — "close but not natural enough," per
Heath. A clone only sounds as alive as its source. One register in, one
register out. This script gives the model five different emotional/pacing
registers to learn from: calm narration, technical explanation, an energetic
story, pushback/objection handling, something short and punchy, and something
slow and reassuring. Read naturally — don't perform "acting," just let
yourself actually shift tone the way you do talking to a real client versus
telling Chelsea a story versus calming down a nervous first-timer.

## Target length

**15-20 minutes of clean audio total.** Two things are riding on this
duration, from ElevenLabs' own account state (confirmed via the API,
2026-09-12):

- **Professional Voice Cloning (PVC) is already unlocked on Heath's Creator
  plan** — `can_use_professional_voice_cloning: true`, 1 professional voice
  slot available, 0 used. No plan upgrade needed to try it.
- The ElevenLabs API does not expose a minimum-audio-duration or
  training-turnaround number anywhere Atlas could query (subscription,
  voices, or model endpoints) — that's a training-pipeline detail ElevenLabs
  doesn't surface via API. Their public product docs (not verified here via
  API, so treat as secondhand) suggest PVC wants substantially more than the
  2 minutes V1 used — commonly cited in the 30-minute range for best results,
  with clear improvement even below that. 15-20 minutes of good, varied
  audio is a safe middle ground: enough to meaningfully upgrade either an
  Instant Clone rebuild or a first PVC attempt, without asking Heath for an
  hour he doesn't have.
- If PVC turns out to need more once training is attempted, this script can
  be extended — better to send a strong 15-20 minutes now than delay for a
  number nobody can currently confirm.

## Before you hit record — same rules as V1, repeated because they matter more at this length

- **Quiet room, soft furnishings, one consistent mic distance the whole
  time.** Bedroom or closed-door office over a kitchen or car.
- **Phone ~8 inches from your mouth, same distance throughout.** Wired
  headset mic beats phone-on-table if you have one.
- Turn off notifications.
- **You do NOT have to record this in one sitting.** Six sections, six
  different energies — it's fine (better, even) to record section by section
  across a day or two, as long as each section is one continuous take and the
  room/mic setup stays the same. Don't stop mid-section for a small stumble —
  a natural stumble helps the clone. Only restart a section if something loud
  interrupts (dog barks, phone rings).
- **Actually shift energy between sections.** Don't read all six in the same
  flat "recording voice." Section 2 should sound like you're actually
  irritated at a dumb deadline mistake. Section 3 should sound like you're
  mid-story with a friend, not narrating. If a section feels stiff reading it
  as written, say it in your own words — cadence and real emotion matter more
  than hitting the exact script.

## The script — six sections, read straight through each one

Leave a 2-3 second pause between sections if recording in one sitting (easier
to split the file later); no pause needed if recording separately.

---

### 1. Calm narration (listing walk) — same register as V1, ~2 min

Hey, I'm Heath Shepard, REALTOR with Keller Williams City View out here in
Boerne. Been doing this a while now, mostly Hill Country stuff — Boerne, San
Antonio, out toward the ranches.

Let's walk this one. You come up the driveway and it's already different —
mature oaks, some real acreage, not a postage-stamp lot. Inside, kitchen's
been redone, not just "updated" — new counters, new cabinets, appliances
that actually work. Primary's on the main floor, which out here matters more
than people think. Back patio looks out over the property, and honestly
that view alone sells half the buyers I bring through.

Boerne itself has grown a ton the last few years, but it hasn't lost the
small-town feel. Main Street's still Main Street. You're twenty-five, thirty
minutes to San Antonio if you need the city, but you come home to actual
quiet.

---

### 2. Technical explanation (TREC deadlines) — precise, a little more clipped, ~3 min

This is the part where you slow down and get specific — like you're making
sure someone doesn't miss a deadline that costs them money.

Okay, let's talk about the option period, because more people mess this up
than you'd think. In Texas, when your offer gets accepted, you negotiate an
option period — usually seven to ten days. That's your window to have the
place inspected and back out for literally any reason, no explanation
required. You just forfeit the option fee, which is usually two, three
hundred bucks. Cheap insurance.

Here's the mistake I see constantly. People treat day one and day ten the
same, and they're not. If your inspector can't get out until day eight, you've
got two days to read a forty-page report, decide if you want repairs, and
either terminate or move forward. That's not enough time to think straight.
Get your inspector booked the day you go under contract, not the day before
the option period ends.

Same thing with the financing deadline. Most contracts have a separate date
for your loan to be approved, and if you blow through it without an
extension in writing, the seller can technically walk and keep your earnest
money. I've seen buyers assume "we're still working on it" is good enough.
It's not. If you need more time, you get an amendment signed before the
clock runs out — not after.

And earnest money versus option fee — people conflate these constantly.
Option fee is small, non-refundable, buys you the right to walk. Earnest
money is bigger, and it's at risk if you break contract outside your
option period without a valid reason. Two different pots of money, two
different rules.

---

### 3. Story with energy — animated, faster, real stakes, ~3 min

Tell this like you're telling Tom or Chelsea over a beer, not presenting.
Let yourself get a little worked up in the middle — that's the point.

So I had a deal a while back — under contract, option period, everything
looking clean. And the buyer's agent calls me the day before the option
expires, day nine of ten, and says "hey, we need three more days." Three
more days! On day nine! I said, absolutely not, we've got a title company
closing in two weeks, you can't just show up the day before and ask for an
extension like it's nothing.

So now I'm on the phone back and forth, trying to get my sellers comfortable
with a short extension without blowing the whole closing timeline, because
here's the thing nobody tells you — a lot of these extensions, if you don't
handle them right, they can actually cost you real money if the deal falls
through later. I ended up writing up a proper amendment, got everybody to
sign same day, and we still closed on time. But that near-miss is exactly
why now, every single time, the second we execute a contract, I'm already
telling my clients "let's talk about protecting ourselves on time," before
it's ever a problem. Learned that one the expensive way.

---

### 4. Common objection, answered — direct, a little challenging, ~2 min

Someone's pushing back on you here. Answer like you actually believe it, not
like you're reading a rebuttal script.

I get this one all the time — "why do I need an agent, I can just look on
Zillow myself." Fair question. Here's my honest answer. You can absolutely
find a house on Zillow. What you can't do on Zillow is know that the seller's
actually motivated because they're relocating in six weeks, or that the
comp two streets over sold for less because it backed up to the highway, or
that the inspection report you're about to get is going to list nine things
and only three of them actually matter. That's the job. Anybody can open a
door. Knowing what to do once you're standing in it, and what to fight for
after — that's what you're paying for. And honestly, on most deals, the
seller's paying it, not you.

---

### 5. Short and punchy — a few standalone lines, fast, confident

Read these as separate, complete thoughts. Don't blend them together.

Price it right the first time. You don't get a second first impression.

If your inspector finds something scary, don't panic — call me before you
do anything else.

I'll tell you if a house isn't right for you just as fast as I'll tell you
if it is.

Every day your house sits overpriced, buyers start wondering what's wrong
with it.

---

### 6. Slow and reassuring — calming a nervous client, ~2 min

Slow down here. Lower energy, warmer, like you're sitting across from
someone who's genuinely stressed and you're talking them down.

Hey, I know this is a lot right now. Buying a house is one of the biggest
things you'll ever sign your name to, and it's normal to feel like
everything's moving too fast. So let's just slow down for a second.

Nothing happens without you saying yes first. Every deadline we've got, I'm
tracking it before you even have to ask. If something looks off in that
inspection report, we're not going to rush a decision — we'll walk through
it together, line by line, and you'll understand exactly what you're
agreeing to before you agree to it. You're not doing this alone. That's
genuinely the whole job. Take a breath. We've got time to get this right.

---

## Format, filename, where to drop it

- **Format:** `.m4a` or `.wav`, whatever's native to your recorder. Don't
  compress or convert it — send as recorded.
- **One file per section is fine, or one file for the whole thing** — either
  works, name them so the order is obvious if you split them, e.g.
  `heath-v2-01-narration.m4a` through `heath-v2-06-reassuring.m4a`.
- **Drop it here:** `Media/voice-clone/v2/` (create the folder if it's not
  there — `Media/` is already gitignored, nothing here goes into GitHub).

Once it's dropped, tell Atlas/Cole "V2 recording's in" and the rebuild
happens from there.

## What happens next (reference only — not something you need to run)

If going Instant Clone route (faster, what's live today):
```
node scripts/create-voice-clone.js "Media/voice-clone/v2/<files>"
```

If going Professional Voice Cloning (higher quality, not instant — training
takes time after upload, exact turnaround not available from the API as of
2026-09-12; expect longer than the few-seconds Instant Clone build):
PVC is created via a separate `/v1/voices/pvc` creation + training flow, not
the same one-shot endpoint V1 used. Atlas will confirm the exact steps once
the recording's in — this hasn't been built yet since PVC has been unused
(0 of 1 slots) until now.

## The consent/ethics/TREC fine print — unchanged from V1, still applies

- Cloning your own voice from your own recording satisfies ElevenLabs'
  consent requirement — no separate paperwork.
- The voice ID is sensitive — treat it like an API key. Never paste it into
  Telegram, a public doc, or anywhere outside this repo's ignored config.
- It's still you, legally, for every TREC advertising rule — see
  `docs/SALES-PLAYBOOK.md`.
- Scope stays `target_owner='heath-realtor'` only, enforced in
  `scripts/voice-select.js`. Never used for Dossie product content.
