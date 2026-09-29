# Past-Client Review Request Campaign — DRAFT, nothing sent

Built 2026-09-17. Every message below is a **draft only**. Nothing goes out until Heath
approves the exact wording of each one and it is sent by hand (or via the Phone Link
poller script, per [[sms-history-and-phone-link-poller]]) — never auto-sent.

Source list: `C:\Users\Heath\OneDrive\Clients\past-client-outreach-list.csv` (94 rows,
built from real SMS history + OneDrive closing-doc folders), cross-checked against
`docs/CUSTOMERS.md`, the do-not-contact list, and Heath's current active-deal roster.
This file contains no PII beyond what's already in that private CSV — treat this doc
itself as containing real client names/phones/addresses; it lives in a public repo
only until Heath asks for it to move, per CLAUDE.md data-handling rules. **Flagging
this now: this doc should probably move to a `.tmp/`-style private location rather
than `docs/` long-term — Heath's call.**

---

## 1. Links

- **Google review link (tested 2026-09-10, confirmed opens the review box):**
  `https://search.google.com/local/writereview?placeid=ChIJO2JbuzOAVSoRwa3PvvV6NYk`
  — this is the "Shepard Real Estate Team" profile, the one Heath actually controls
  (see [[heath-google-business-profile]]).
- **Zillow review link — NOT VERIFIED, blocking item.** I could not resolve a live
  Zillow URL for Heath's agent profile. Confirmed from real Zillow email receipts
  (`kw-mail.py`) that a real profile with real 5-star reviews exists (Ryan Castro,
  Chip Angle, Gaylan Fayadh, Jenny Prado all published 2024, "Best of Zillow" status
  2023), but every attempt to render zillow.com — WebFetch, and a real Chromium
  session via `scripts/_lib/brokerage-browser.js` — got **HTTP 403 "Access to this
  page has been denied"**, including the tracking-redirect link from Zillow's own
  review-notification email. This looks like Zillow's WAF blocking automated/
  datacenter traffic outright, not a wrong URL — I could not "look" at the real page
  to confirm it, so per the never-guess rule I did NOT construct one.
  **Action needed from Heath:** log into the Zillow Premier Agent dashboard →
  Profile → "Share your profile" (or the review-request tool) and paste the real
  link here. Takes him under a minute logged in; nothing I can substitute for it.
  **Until that link is filled in, the 7 Zillow-assigned drafts below are on hold —
  swap them to Google if Heath wants to launch before he gets the Zillow link.**

---

## 2. Who qualified, and why

**20 clients qualified** — real closed transactions (contract + a closing-stage
document: CD/HUD settlement statement, warranty deed, or receipted contract found
in their OneDrive folder), a "client" (not PRO/cold/unknown) tag on the source CSV,
a reachable phone number, not on the do-not-contact list, not a current active deal,
and no record of the deal ending badly.

**Excluded, with reason:**

| Name | Reason |
|---|---|
| Elizabeth Lee | On the standing do-not-contact list ([[do-not-contact-list]]) — not a client anyway, a real estate professional Heath has a negative history with. |
| Kanika Jain / Ketan Thakkar | **Explicitly checked per instructions — the Low Oak earnest-money dispute parties ([[low-oak-earnest-money-dispute]]).** They do not appear in the past-client CSV at all (their Serene Creek / Low Oak deals live in the live `transactions` table, not this list), but flagging them by name here so they are never added to a review campaign — the dispute just settled 9/15 and a review ask to them now would be tone-deaf at best. |
| Aum Patel / Lily Arendt, the Whytes, the Lintons | Current active listings (Pfeiffers Gate, Nopalito, Wild Cherry) — mid-transaction, checked against the CSV (none appear in it) and against Heath's live 9-row `transactions` set. Not review-campaign material yet. |
| Kim Paqueo | 311 Rilla Vista is one of Heath's 9 **current** rows in the live `transactions` table ([[transactions-table-is-multi-tenant]]) — very recent purchase (FHA cert + executed contract on file, last text 2026-08-26). Too soon / possibly not fully closed yet. Hold for a future batch once confirmed closed. |
| Kevin Long | Real closed deal (431 Hays St, full contract file on record) but **no phone or email on file** — can't be reached. |
| Mohammad Razi | Folder only contains a *proposed* listing agreement for 18706/18796 Millhollow — no contract, no closing doc. Unverified whether this ever closed. |
| Blake Farrar | No documents at all in his OneDrive folder despite recent (2026-08-11) text contact. Can't verify a closed transaction happened. |
| Juan Garcia, Kyle Campbell, Roger Bell, Levi Thomet | Pre-approval/offer/proof-of-funds documents only — no contract or closing-stage document found. Real relationships, unverified closings. Held in the Tier-2 pool below, not this campaign. |
| Phil Green, Jeremy Dean, Carter Blackburn, Chris Bruce, Josh Sisam | Tagged "PRO" on the source list (banker/lender/wealth mgmt/agent/attorney) — not past clients. |
| Everyone tagged "cold" or "unknown" on the source CSV | Never confirmed as an actual client relationship. |

**Tier-2 pool (54 more "client"-tagged rows, no closing document verified) exists in
the source CSV** — real names, real phone numbers, real text history, but I didn't
open all 54 OneDrive folders to confirm a closing (time-boxed this session to the
highest-confidence set). Reasonable next step once this first batch is running:
verify a handful more per week the same way (look for a CD/HUD/warranty deed in
their folder) and add them to a Batch 3+.

---

## 3. The Google/Zillow split

**13 Google / 7 Zillow**, weighted toward Google on purpose: the Google Business
Profile carries only 2 reviews today and is Heath's own stated highest-value target
(see [[heath-google-business-profile]] — "getting reviews from 2 to 20 out-earns
any website change"). Zillow already has an established base — at least 5 real
reviews confirmed via email going back to 2023/2024, plus Best of Zillow status —
so it needs the boost less urgently, but still gets a meaningful slice so it keeps
growing too.

Of the 6 clients who **already left Heath a Zillow review** (Nena Tiukinhoy, Gaylan
Fayadh, Patrick Ng, Ryan Castro, Chip Angle, Jenny Prado — confirmed via Zillow's
own "A Review About You From ___" email receipts), **all 6 are routed to Google**
this time — asking them for the platform they haven't already given feels like
newer ground, not a re-ask.

---

## 4. The list, sequence, and drafts

Ordered best-relationship-first (real SMS text-volume with Heath as the proxy for
relationship strength, then recency). **10/day max**, two batches.

### DAY 1

| # | Name | Phone | Property | Platform | Texts w/ Heath | Last contact |
|---|---|---|---|---|---|---|
| 1 | Nena Tiukinhoy | +19086598872 | 1407 W Mistletoe | Google | 6,494 | 2025-08-02 |
| 2 | Mike Berg | +13184263533 | 117 W Evergreen St | Zillow | 3,858 | 2026-08-17 |
| 3 | Patrick Ng | +12102016661 | 307 Hartline / 309 Jeanette / 624 Jamie Sue (3 deals) | Google | 1,573 | 2025-04-11 |
| 4 | Christian Hollinger | +16309177989 | 302 Hollenbeck Ave | Google | 1,352 | 2025-08-06 |
| 5 | Ryan Castro | +18305346350 | 8346 Exbourne St | Google | 1,104 | 2024-10-30 |
| 6 | Remy Linden | +15307489017 | 9011 Chinon | Zillow | 755 | 2025-07-23 |
| 7 | Amber Hamilton | +18594626074 | 210 Atwater Dr | Google | 419 | 2025-01-27 |
| 8 | Jenny Prado | +12108436056 | (address unconfirmed — buyer closing on file) | Google | 293 | 2025-04-15 |
| 9 | Brian Taylor | +18032884245 | 5132 Storm King | Zillow | 239 | 2024-10-29 |
| 10 | Darren Sliva | +14024156218 | 270 Briarwood Cir (also 520 Main St — repeat client) | Google | 197 | 2023-12-15 |

**#1 Nena Tiukinhoy — call her instead of texting.** 6,494 messages is the single
highest-volume relationship on the entire 94-name list by a wide margin. That's
worth a real conversation, not a text he could ask for a review on live, with a
follow-up text carrying just the link afterward.

**Drafts (text unless noted):**

1. **Nena** — *(phone call primary; text as follow-up carrying the link)* — "Hey
   Nena! Been thinking about you guys since 1407 Mistletoe closed — if you've got a
   minute, would you mind dropping me a quick Google review? [GOOGLE LINK]"
2. **Mike** — "Hey Mike! Glad Evergreen worked out the way it did — if you've got 60
   seconds, I'd really appreciate a quick Zillow review from you. [ZILLOW LINK]"
3. **Patrick** — "Hey Patrick! Between Hartline, Jeanette, and Jamie Sue you've kept
   me busy — would you mind leaving me a Google review when you get a sec? [GOOGLE
   LINK]"
4. **Christian** — "Hey Christian! Hope Hollenbeck's still treating you well — if you
   don't mind, a quick Google review would go a long way for me. [GOOGLE LINK]"
5. **Ryan** — "Hey Ryan! Hope Exbourne's still cash-flowing — any chance you'd drop
   me a Google review too, same way you did on Zillow? [GOOGLE LINK]"
6. **Remy** — "Hey Remy! Hope Chinon's treating you right — could I ask a favor and
   get a quick Zillow review from you? [ZILLOW LINK]"
7. **Amber** — "Hey Amber! Hope you're settled in at Atwater — if you have a minute,
   I'd appreciate a quick Google review. [GOOGLE LINK]"
8. **Jenny** — "Hey Jenny! You said you'd work with me again — would you mind saying
   that on Google too? [GOOGLE LINK]"
9. **Brian** — "Hey Brian! Hope Storm King's still a good fit — any chance you'd
   leave me a quick Zillow review? [ZILLOW LINK]"
10. **Darren** — "Hey Darren! Two deals together now between Briarwood and Main St —
    would you mind dropping me a Google review when you get a chance? [GOOGLE LINK]"

### DAY 2

| # | Name | Phone | Property | Platform | Texts w/ Heath | Last contact |
|---|---|---|---|---|---|---|
| 11 | James Dorough | +17576921526 | 10839 Otter Pass | Zillow | 193 | 2023-08-30 |
| 12 | Jeremy Clark | +12057179597 | 10317 Devon Wheel (Waterwheel) | Google | 166 | 2022-07-29 |
| 13 | Lauren Reeves | +17133054988 | 225 W Apacheria Pass | Zillow | 84 | 2024-07-05 |
| 14 | Jeff Milburn | +19792550460 | 105 Towne View Cir / Lot 321 Highland Meadows | Google | 75 | 2022-04-27 |
| 15 | Chip Angle (Ellwyn Richard Angle) | +13109897004 | 168 Oak Fields Dr, Floresville | Google | 146 | 2024-07-26 |
| 16 | Gaylan Fayadh | +12107245765 | 7671 Pecos Ridge | Google | 0 | (no SMS on file) |
| 17 | Jon Marnon | +19562128198 | 514 Graham | Zillow | 0 | (no SMS on file) |
| 18 | Nathan & Angela Fry | +12517160139 | (address unconfirmed — closing docs on file) | Google | 0 | (no SMS on file) |
| 19 | Brian Wilganowski | +12105858006 | 108 Sandy Oaks | Zillow | 0 | (no SMS on file) |
| 20 | Douglas York | +17135307500 | Lot 19 (his oldest file — Phyllis Browning era) | Google | 0 | (no SMS on file) |

**Drafts:**

11. **James** — "Hey James! Hope Otter Pass is still home sweet home — could you do
    me a favor and leave a quick Zillow review? [ZILLOW LINK]"
12. **Jeremy** — "Hey Jeremy! It's been a minute since Devon Wheel closed — any
    chance you'd leave me a quick Google review? [GOOGLE LINK]"
13. **Lauren** — "Hey Lauren! Hope Apacheria Pass is treating you well — would you
    mind a quick Zillow review when you have a sec? [ZILLOW LINK]"
14. **Jeff** — "Hey Jeff! Hope Highland Meadows worked out great for you — could I
    ask for a quick Google review? [GOOGLE LINK]"
15. **Chip** — "Hey Chip! Hope Oak Fields is still good to you — would you mind
    dropping me a Google review too? [GOOGLE LINK]"
16. **Gaylan** — "Hey Gaylan! Hope Pecos Ridge is still home — any chance you'd
    leave me a Google review as well? [GOOGLE LINK]"
17. **Jon** — "Hey Jon! Hope Graham is treating you and Linda well — could you do me
    a favor and leave a Zillow review? [ZILLOW LINK]"
18. **Nathan** — "Hey Nathan! Hope you and Angela are settled in and loving the new
    place — would you mind a quick Google review? [GOOGLE LINK]"
19. **Brian W.** — "Hey Brian! Hope Sandy Oaks is still a great fit — any chance
    you'd leave me a quick Zillow review? [ZILLOW LINK]"
20. **Douglas** — "Hey Douglas! It's been a while since we closed on Lot 19 — would
    you mind a quick Google review when you get a chance? [GOOGLE LINK]"

---

## 5. Open items before any of this sends

1. **Zillow link** — Heath needs to pull his real public/review-request URL from the
   Zillow Premier Agent dashboard. Blocks the 7 Zillow-assigned drafts.
2. **Heath approves each exact wording** before anything sends — standing rule, no
   exceptions.
3. Property addresses for Jenny Prado and Nathan & Angela Fry came back garbled from
   PDF text extraction (a font-encoding issue, not a missing document) — the closing
   docs exist and confirm real closings, just without a machine-readable address
   string. Not a blocker, just noted.
4. Kim Paqueo (311 Rilla Vista) should be revisited once that transaction is
   confirmed fully closed and enough time has passed to feel natural — not urgent
   this cycle.
