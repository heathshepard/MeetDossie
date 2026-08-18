# facebook.com/HeathShepardRealtor — Weekly Posting Cadence (DRAFT)

Status 2026-08-17: **not connected to Zernio yet.** Blocked on Heath's manual
OAuth re-auth click (see `docs/PIPELINE.md` Social Media Accounts section and
`scripts/finish-realtor-page-zernio-setup.js`). Nothing below posts until that
exists. This is draft-only, ready to execute the moment access is granted.

## Why this exists

Heath has posted NEITHER his own listings/market updates NOR organic Dossie
content to this Page so far. His words: he's worried that if the first thing
his real clients see is Dossie content, it reads like he's neglecting their
listings for a side project. Fix: interleave both from week one, and make the
Dossie posts read as a founder talking about a real tool he built — never ad
copy, never positioned above his actual listing work.

## Real data used (verified, not invented)

- **23 Nopalito, San Antonio TX 78261** — Heath's active listing. List
  $1,295,000 (cut from $1,425,000 → $1,395,000 → $1,345,000 → $1,295,000,
  ~9% total), MLS #1916402, 4,495 sqft, 4bd/4ba, 3.48 acres, Sendero Ranch,
  287+ days on market as of 2026-08-01 (higher now). Rent-to-own conversation
  in progress with one prospect (do not post buyer-specific deal details —
  general market/price-history framing only).
  **Freshness flag: this is 16 days stale as of today. Confirm current price
  and status in connectMLS before the first post goes out** — a further price
  cut to ~$1,245,000 was under consideration as of 8/1.
- **104 Wild Cherry, Boerne** — do NOT use as an "active listing" post. Per
  the 2026-08-12 repair amendment, option period expired 2026-08-14; this is
  very likely under contract/pending now, not for-sale content. **Confirm
  actual status before using it at all** — if pending, a "sold soon" or
  "under contract" post is fine; an active-listing pitch is not.
- No other active listings are confirmed in memory. **Do not draft more
  listing posts than there are real, confirmed-active listings** — if Heath
  has others live, they need to be named before slotting them in.
- Dossie facts for founder-voice posts: built because filing/deadline
  tracking on his own deals was the actual daily pain (TREC deadlines,
  option periods, disclosures); $29/mo founding price now closed (10
  members locked for life); current pricing $79-149/mo Solo. Never invent a
  stat that isn't in `CLAUDE.md` / `docs/CUSTOMERS.md`.

## Weekly cadence (2 posts/week to start — matches Facebook Page cap of
2/day used elsewhere in the pipeline, deliberately far under that; this is a
personal Page building trust, not a brand channel to max out)

| Day | Type | Content |
|---|---|---|
| Tue | Listing / market update | 23 Nopalito price-history angle: "Priced this one down three times this year to meet the market — here's what that actually looks like from the seller's side." Real numbers, no hype. Photo from the listing. Ends with his direct line, not a link. |
| Fri | Dossie, founder voice | Short, first-person, grounded in one specific real pain: e.g. "Spent Saturday morning making sure an option period deadline didn't slip on a deal that wasn't even mine to worry about digitally — built the thing I wished I had years ago." No pitch language, no "sign up now," no urgency copy. One line, maybe a screenshot, never a hard CTA. |

## Week-by-week draft (first 4 weeks, ready once access exists)

**Week 1**
- Tue: 23 Nopalito — the price-cut history as a market-conditions story ("Hill Country luxury has taken a real correction this year — here's one file's actual numbers"). Educates, doesn't beg for a buyer.
- Fri: Dossie founder post #1 — why he built it (TC paperwork overwhelm, not a sales pitch). No link in the post itself; link in first comment if at all.

**Week 2**
- Tue: Wild Cherry status update (confirm status first — "under contract" post if true, otherwise substitute a general Boerne/San Antonio market-conditions note using only verified public data, not a specific unlisted property).
- Fri: Dossie founder post #2 — one specific feature explained through the lens of a real problem it solved (e.g. missed-disclosure follow-up), not a feature list.

**Week 3**
- Tue: 23 Nopalito — different angle (the property itself: guard-gated, 3.48 acres, Joe Stubblefield design — lead with what makes it worth the drive, not the price cut again).
- Fri: Dossie founder post #3 — a "built this because a client almost got burned by X" story, grounded and specific, credit-worthy to a real event he can stand behind publicly (needs Heath's sign-off on which story is fair to tell publicly).

**Week 4**
- Tue: Market update, general (Boerne/San Antonio conditions, no specific listing — keeps the feed from reading as "buy my listing" every single week).
- Fri: Dossie founder post #4 — milestone/traction note IF a real one exists by then (e.g., a customer number that's actually true that week) — otherwise another grounded feature-through-a-story post.

## Rules for whoever executes this

1. Never post a listing that isn't currently confirmed active in MLS that day.
2. Dossie posts are first-person, from Heath, never third-person persona
   voice (that's the Brenda/Patricia/Victor system on the MeetDossie Page —
   different channel, different voice, do not cross-contaminate).
3. No stacking two listing posts or two Dossie posts back-to-back — always
   interleave.
4. Every post through Telegram approval before it goes out, same as the
   existing DossieMarketingBot flow, until Heath says otherwise.
