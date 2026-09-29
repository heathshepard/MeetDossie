# Heath's Voice Clone — Recording Script

Owner: Atlas. Purpose: source audio for an ElevenLabs Instant Voice Clone of
Heath, used ONLY for his own listing videos (`target_owner='heath-realtor'`).
Never used for Dossie product content — Bill/Luna stay Dossie's voices. See
`scripts/voice-select.js` for the brand-separation rule enforced in code.

## Before you hit record

- **Quiet room, soft furnishings.** A bedroom or the office with the door
  closed beats a bare tile kitchen or a car — hard surfaces bounce sound and
  echo ruins a clone. No fan, no HVAC running, no TV in another room.
- **Phone ~8 inches from your mouth, same distance the whole time** — don't
  drift closer/farther as you talk. If you've got a wired headset mic, that's
  even more consistent than the phone.
- **Turn off notifications** so nothing dings mid-take.
- **One continuous take.** Don't stop and restart on a small stumble — a
  natural stumble is fine and actually helps the clone (it's how you really
  talk). Only restart if something loud interrupts you (dog barks, phone
  rings, etc).
- Read it like you're talking to a client standing next to you, not reading
  news. If a line feels stiff out loud, say it your own way — the words don't
  have to be exact, the point is your natural cadence and pacing.

Total should land around 2-3 minutes. Don't pad it — more isn't better if the
quality drops toward the end.

## The script

Read straight through, no pauses between sections.

---

Hey, I'm Heath Shepard, REALTOR with Keller Williams City View out here in
Boerne. Been doing this a while now, mostly Hill Country stuff — Boerne, San
Antonio, out toward the ranches.

Let's walk this one. You come up the driveway and it's already different —
mature oaks, some real acreage, not a postage-stamp lot. Inside, kitchen's
been redone, not just "updated" — new counters, new cabinets, appliances
that actually work. Primary's on the main floor, which out here matters more
than people think. Back patio looks out over the property, and honestly
that view alone sells half the buyers I bring through.

Couple things I always tell people up front. The option period — that's your
inspection window, usually about ten days. During that time you can walk for
any reason, no explanation needed, you just lose the option fee, which is
usually a couple hundred bucks. It's not a trap, it's there to protect you.
Get your inspector out early, don't wait till day nine.

And Boerne itself — it's grown a ton the last few years, but it hasn't lost
the small-town feel. Main Street's still Main Street. You're twenty-five,
thirty minutes to San Antonio if you need the city, but you come home to
actual quiet. That's the trade people are making when they move out here,
and for most of my clients it's an easy one.

If you're thinking about buying or selling out this way, reach out. I'll
walk you through it straight, no pressure, and I'll tell you if a house isn't
right for you just as fast as I'll tell you if it is.

---

## Format, filename, where to drop it

- **Format:** `.m4a` (iPhone Voice Memos default) or `.wav`. Either works —
  don't convert or compress it yourself, send it as recorded.
- **Filename:** anything, doesn't matter.
- **Drop it here:** `Media/voice-clone/heath-source-recording.m4a` (or `.wav`
  if that's what you recorded). That folder's already set up and already
  gitignored — the raw recording never goes into GitHub.

Once the file's in that folder, tell Atlas/Cole "recording's dropped" and the
clone gets built from there — you don't need to do anything else.

## What happens next (for reference, not something you need to run)

```
node scripts/create-voice-clone.js "Media/voice-clone/heath-source-recording.m4a"
```

This uploads the file to ElevenLabs, creates the clone, and saves the
resulting voice ID to `scripts/config/heath-voice-clone.json` so the listing
video generator can find it. Full details in `docs/ENV.md`.

## The consent/ethics/TREC fine print (read once)

- **Consent:** ElevenLabs requires the speaker's consent to clone a voice.
  You cloning your own voice from your own recording satisfies that — no
  separate paperwork needed. Don't clone anyone else's voice without their
  explicit sign-off.
- **The voice ID is sensitive, treat it like an API key.** Anyone who has
  both the ElevenLabs API key AND this voice ID can generate audio that
  sounds like you. It's stored outside git (see `docs/ENV.md`) for that
  reason — don't paste it into Telegram, a public doc, or anywhere outside
  this repo's ignored config file.
- **It's still you, legally.** A video narrated by the cloned voice is still
  Heath Shepard speaking as a licensed Texas REALTOR. Every TREC advertising
  rule that applies to something you said on camera applies exactly the same
  way to something the clone says for you — brokerage name, no
  misrepresentation, no price claims you wouldn't make live. The clone
  doesn't create any distance from that. See `docs/SALES-PLAYBOOK.md` for
  the advertising rules already in force.
- **Scope:** this voice is for Heath's own realtor content only
  (`target_owner='heath-realtor'`). It never gets used for Dossie product
  videos — Bill and Luna are Dossie's voices and mixing them would blur two
  separate brands. Enforced in `scripts/voice-select.js`.
