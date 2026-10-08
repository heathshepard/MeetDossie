# TREC 20-19 SERIES — VIDEOS 2 THROUGH 6 · VERBATIM CAMERA SCRIPTS
**Written 2026-09-25 · every word written out · read exactly as written**

Video 1 (¶7.I Seller's Water Disclosure) is shot and published. These are the other five.
Format matches the proven Video 1 cut: one rule per video, opens mid-consequence, 3-line chunks,
series CTA.

**Source of truth for every fact below:** `scripts/trec-forms/20-19.pdf` — TREC No. 20-19,
footer revision stamp 05-04-2026, 12 pages — extracted page-by-page with `pdftotext -layout`
on 2026-09-25. Prior-form comparisons come from `.tmp-atlas-master-v2-resale.pdf` (TREC No. 20-18,
11 pages). Form number and effective date cross-checked live at
`trec.texas.gov/forms/one-four-family-residential-contract-resale` on 2026-09-25: **Form ID 20-19,
Effective Date 07/01/2026.**

`data/hadley-knowledge/trec-20-19.md` v2 was used only as an index of *what* changed. Every quoted
line in the verification tables was read off the PDF, not off that file.

---

## RECORDING BLOCK — READ ONCE, THEN SHOOT ALL FIVE

**Shoot all five in one sitting. Same seat, same distance, same shirt every take** — navy or
charcoal, no KW branding, no over-ear headphones. If the wardrobe or the framing changes between
videos the series stops looking like a series.

| | |
|---|---|
| **Camera** | 4K30. **6-8 feet back**, zoomed to a medium shot. Distance is what hides the eye offset. |
| **Script** | Directly under the lens. Big type. Not off to the side. |
| **Preview** | Off, or flip the phone. Watching your own face is what causes the blank. |
| **Audio** | Confirm the DJI lav is the phone's **actual input source** before take one. Gain 0. |
| **Room** | Soft furnishings. Not the laundry room — hard surfaces made the 09-21 audio hollow and no plugin removes reverb. |
| **Takes** | **Three to four of each script.** Slate each one out loud: "video four, take two." |
| **Pauses** | Free. `[pause]` is one beat. Land the last word of every sentence, then breathe. |
| **Flubs** | Free. Say the line wrong, stop, say it again clean, **keep rolling.** Do not restart the take. Do not apologize to the camera. |
| **Order** | Shoot in order 2 → 6. The CTA counts up and you'll keep the count straight. |

**Marks:** `**bold**` is the one word in that line that carries it — lean on it.
`[pause]` on its own line is a beat.
`` `[CORE]` `` and `` `[OPTIONAL]` `` are **not spoken** — same as `` `[FACE]` ``. Read straight
past them. They tell the editor which chunks make the 30-second cut and which only make the long
one; see below.

---

## THE TWO CUTS — WHY EVERY CHUNK IS TAGGED

Each script produces **two videos from one take**, and the tags decide which lines are in which.

| Cut | Contents | Target | Goes to |
|---|---|---|---|
| **core** | CORE only | 21-34s | TikTok, Instagram Reels |
| **full** | CORE + OPTIONAL | 40-90s | YouTube Shorts, Facebook, LinkedIn |

Same 9:16 frame for both. Only the length differs. `scripts/video-engine/produce-variants.js`
builds both off one master without re-matting; full detail in `docs/DUAL-CUT-PRODUCTION.md`.

CORE always carries the hook, the one rule **with its condition**, and the CTA. Each script's
`### CORE MUST CARRY` block lists the exact phrases the short cut has to keep — those are the
qualifiers from MUST BE EXACT and MUST NOT SAY that a length trim would delete without noticing,
turning a true statement into a false one on camera. `script-format.js` fails the parse if one
goes missing.

**Check the tagging before you shoot:**

```bash
node scripts/video-engine/script-format.js docs/SCRIPTS-TREC-20-19-SERIES.md
```

### PACE — read this before take one

Both cuts come off the **same take**, so both are read at the same speed. That makes the two
length windows one constraint on one number, and the tool solves it:

| Video | CORE words | FULL words | Pace at which BOTH cuts land in-window |
|---|---|---|---|
| 2 — ¶12.B compensation | 90 | 138 | **159-207 wpm** |
| 3 — ¶8 disclosure | 88 | 142 | **156-213 wpm** |
| 4 — ¶6.E(12) moved | 84 | 116 | **149-174 wpm** |
| 5 — ¶22 regrouped | 71 | 128 | **126-192 wpm** |
| 6 — ¶21 fax | 83 | 105 | **147-157 wpm** |

**Shoot the series at about 157 wpm.** That is the only speed all five nearly agree on — a touch
brisker than the 140 wpm the published Video 1 measures at, and well short of a rushed read.

Video 2's floor (158.8) sits **1.3 wpm above** Video 6's ceiling (157.5), so there is no single
speed that satisfies all five on paper. The gap is inside the noise of a word-count estimate and
the real arbiter is the gate on the rendered file — but if Video 2's core comes back a half-second
long, that is the reason, and one word out of its core fixes it. Video 6 is the tight one in the
other direction: only 20 of its 105 words are OPTIONAL, because almost everything in it is
load-bearing.

**Before take one, roll three minutes of nothing** — the drive, the weather, lunch. Do not stop the
recording when Video 2 starts. Those three minutes get deleted; their only job is to get past the
part where the red dot is new.

---

## SERIES MAP

| Video | The one rule | Status |
|---|---|---|
| 1 | ¶7.I Seller's Water Disclosure — the termination right that outlives the option period | **Published** |
| 2 | ¶12.B Brokerage Compensation — the blank at 12.A(1)(b) flipped meaning | below |
| 3 | ¶8 Broker or Sales Agent Disclosure — renamed, 8.B deleted, scope is wider than agents think | below |
| 4 | ¶6.E ends at (11) — old (12) Required Notices moved into ¶22 | below |
| 5 | ¶22 regrouped into five named groups — two boxes added, one removed | below |
| 6 | ¶21 Notices — fax is no longer a delivery method | below |

**Deliberately not spoken anywhere in the series** (housekeeping, low consequence, and each one
would break the one-rule-per-video rule): ¶20 renamed FEDERAL → GOVERNMENTAL with a new 20.B; ¶17
"Listing Broker, Other Broker" → "Seller's broker, Buyer's broker"; the page-11 inter-broker
compensation disclosure line deleted; ¶5 lowercasing "option fee"; ¶7.B(3) wording. All are real and
all are verified — they are just not 30 seconds of content each. If you want a bonus seventh short,
the page-11 deletion is the only one with a story ("the last piece of the settlement cleanup").

---

# VIDEO 2 — WHERE THE SELLER CONTRIBUTION WENT

**Hook summary:** The blank you've used all year to make the seller pay the buyer's broker is still
there, in the same spot — and it now expressly excludes brokerage compensation.

**Cover hook text:** `PUT IT IN 12A AND IT NEVER REACHES YOUR BROKER`

### SCRIPT

`[CORE]`

`[FACE]`

You're writing an offer and you want
the seller to help pay
your buyer's side.

So you go to twelve-A-one-B.
Same blank you've used all year.

[pause]

`[SCREEN: page 6, ¶12.A(1)(b)]`

In twenty-nineteen that blank flipped meaning.
It now reads **"other than
brokerage compensation."**

`[SCREEN: page 7, ¶12.B]`

Your number goes in a new paragraph. **Twelve-B.**
Brokerage compensation.
It runs **both** directions.

`[OPTIONAL]`

Seller toward what the buyer owes the buyer's broker.
Buyer toward what the seller owes the seller's broker.
Dollars or a percent. Check one.

[pause]

`[CORE]`

`[FACE]`

Read the bold line above those boxes.
A contribution is **applied to** what your client owes you.
It does not **change** it.

`[OPTIONAL]`

Buyer rep says two and a half, seller gives two —
your client still owes the rest.
Say that at the table, not at closing.

`[CORE]`

That's two of six.
Follow for the other four.
Save this before your next offer.

**Word count: 139 spoken words.** Runtime: 0:42 at 200 wpm / 1:00 at 140 wpm. See the runtime note at the bottom of this file.
**CORE only: 93 words** — 0:28 at 200 wpm. **CORE + OPTIONAL: 139 words** — 0:42 / 1:00.

### CORE MUST CARRY
- "other than brokerage compensation"
- "applied to"
- "does not"
- "change it"

*Why these four: the entire hook is that ¶12.A(1)(b) now **excludes** brokerage compensation, so
dropping the exclusion phrase inverts the video's own claim. And the form's bolded line is that a
contribution is "applied to and shall not change" what each side already owes its own broker — a
core cut that says a seller contribution goes toward the buyer's broker WITHOUT that sentence
describes a commission agreement, which it is not. The OPTIONAL two-row breakdown and the
two-and-a-half arithmetic are elaboration; the qualifier is not.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "twelve-A-one-B" | **Page 6, ¶12.A(1)(b)** |
| "It now reads *other than brokerage compensation*" | Page 6, verbatim: "(b) an amount not to exceed $_____________ to be applied to Buyer's Expenses **other than brokerage compensation or contributions under Paragraph 12B below.**" |
| "a new paragraph, twelve-B" · "Brokerage compensation" | **Page 7**, verbatim heading: "B. BROKERAGE COMPENSATION: Brokerage compensation is not set by law and is fully negotiable." |
| "runs both directions" / the two rows | Page 7, verbatim: "(1) Seller will pay (check one box only): $_____ or ______% of the Sales Price to be applied toward the brokerage compensation owed by Buyer to Buyer's broker." and "(2) Buyer will pay (check one box only): $_____ or ______% of the Sales Price to be applied toward the brokerage compensation owed by Seller to Seller's broker." |
| "Dollars or a percent. Check one." | Page 7, "(check one box only): $_________ or ______%" |
| "applied to … does not change" | Page 7, bolded in the form: "The contributions under 12B(1) and 12B(2) below shall be **applied to and shall not change** the parties' obligations to pay compensation pursuant to those agreements." |
| The premise that 12.A(1)(b) used to be the contribution blank | 20-18 page 7, ¶12.A(1)(b): "the following amount to be applied to brokerage fees that Buyer has agreed to pay: $_____ or _____% of the Sales Price (check one box only)". 20-19's (b) is 20-18's old (c) renumbered. Same position on the page, opposite function — that is the whole hook. |

### MUST NOT SAY
- **Do not say the old ¶12.B "moved here."** 20-18's ¶12.B was an expense-overage termination right
  ("If any expense exceeds an amount expressly stated in this contract for such expense to be paid
  by a party, that party may terminate this contract unless the other party agrees to pay such
  excess"). It was **struck, not relocated.** The new ¶12.B is brokerage compensation, a completely
  different thing. This is the single easiest way to be wrong on camera in this video.
- **Do not say "FHA and VA non-allowables" for ¶12.C.** The adopted ¶12.C says "a governmental loan
  program regulation" and names no program. 20-18's old 12.B did name FHA, VA and the Texas Veterans
  Land Board; 20-19's 12.C does not. Don't carry the old names forward.
- Do not name a commission percentage as typical or customary anywhere in this video. "Two and a
  half" here is an arithmetic example in a named buyer-rep agreement, not a market rate — keep the
  line exactly as written.
- Do not say brokerage compensation is "set" by anything. The form's own first line is "not set by
  law and is fully negotiable."

---

# VIDEO 3 — PARAGRAPH EIGHT IS WIDER THAN YOU THINK

**Hook summary:** The disclosure you think only applies when you're the buyer or seller also catches
your parent's house, your kid's house, and an LLC you own eleven percent of.

**Cover hook text:** `IN WRITING. BEFORE. NOT AT CLOSING.`

### SCRIPT

`[CORE]`

`[FACE]`

You're selling a house through an LLC
you own a piece of.
You figure the other side can tell.

[pause]

Texas law says that goes in writing.
And paragraph **eight** just got rebuilt
around exactly that.

`[OPTIONAL]`

`[SCREEN: 20-18 ¶8 beside 20-19 ¶8]`

It used to be Brokers and Sales Agents,
with an A and a B.
Now it's **Broker or Sales Agent Disclosure.** One block.

The old eight-B is **deleted.**
That was the brokers' fees line.
What's left is the disclosure.

[pause]

`[CORE]`

`[FACE]`

The scope is wider than agents think.
You. Your spouse, your parent, your child.
An entity you own more than **ten percent** of.

`[OPTIONAL]`

A trust you're the trustee of,
or that you or they are a beneficiary of.

`[CORE]`

In writing.
**Before** you enter into a contract of sale.
Not at closing. Not in the MLS remarks.

That's three of six.
Follow for the rest, and save this one.

**Word count: 142 spoken words.** Runtime: 0:43 / 1:01.
**CORE only: 109 words** — 0:33 at 200 wpm. **CORE + OPTIONAL: 142 words** — 0:43 / 1:01.

### CORE MUST CARRY
- "more than ten percent"
- "in writing"
- "before you enter into a contract of sale"

*Why: MUST NOT SAY already bans the bare "ten percent" — the form says "**more than** 10%", and
exactly ten percent does not trigger the duty. "More than" is three syllables that a length trim
would delete without noticing. Likewise the duty is meaningless without its timing: "in writing
**before** entering into a contract of sale" is the whole rule, and a core cut that keeps the
scope list but loses the timing tells an agent the disclosure can wait. The A/B rename and the
deleted 8.B are genuinely structural and belong in OPTIONAL — MUST NOT SAY notes the disclosure
itself is NOT new, so nothing load-bearing leaves with them.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "paragraph eight" | **Page 5 (heading) continuing onto page 6**, 20-19 |
| "Now it's Broker or Sales Agent Disclosure" | Page 5, verbatim heading: "8. BROKER OR SALES AGENT DISCLOSURE:" — single unlettered block |
| "It used to be Brokers and Sales Agents, with an A and a B" | 20-18 page 6, verbatim: "8. BROKERS AND SALES AGENTS:" with "A. BROKER OR SALES AGENT DISCLOSURE:" and "B. BROKERS' FEES:" |
| "The old eight-B is deleted. That was the brokers' fees line." | 20-18 ¶8.B verbatim: "BROKERS' FEES: All obligations of the parties for payment of brokers' fees are contained in separate written agreements." No equivalent line appears anywhere in 20-19's ¶8. |
| "spouse, parent, child … more than ten percent … trust … trustee … beneficiary" | Pages 5-6, verbatim: "Texas law requires a real estate broker or sales agent who is a party to a transaction or acting on behalf of a spouse, parent, child, business entity in which the broker or sales agent owns **more than 10%**, or a trust for which the broker or sales agent acts as a trustee or of which the broker or sales agent or the broker or sales agent's spouse, parent or child is a beneficiary, to notify the other party **in writing before entering into a contract of sale**." |
| "In writing. Before you enter into a contract of sale." | Same sentence, page 6 |
| "or that you or they are a beneficiary of" | "they" in the script refers to the spouse/parent/child named in the line immediately before it — which is exactly the form's list. Do not widen it to "your family." |

### MUST NOT SAY
- **Do not say this disclosure is new.** It is not. The *paragraph* was renamed and 8.B was deleted;
  the disclosure text itself is carried over from 20-18 ¶8.A essentially word for word. The change
  is the structure, not the duty.
- **Do not say "ten percent."** The form says "**more than** 10%." Exactly ten percent does not
  trigger it. This is the kind of thing the sharpest person watching will catch.
- **Do not add in-laws, siblings, or business partners.** The list is spouse, parent, child, a >10%
  entity, and the trust clause. Nothing else.
- Do not state a penalty or a consequence for failing to disclose. The form states the duty; it
  states no remedy. Anything past that is legal advice.

---

# VIDEO 4 — THE NOTICE LINE THAT MOVED

**Hook summary:** You go to list the district notices at 6.E(12) and there is no 6.E(12) — the
paragraph now ends at eleven, and the liability moved to a different page.

**Cover hook text:** `6E(12) IS GONE. THE LIABILITY ISN'T.`

### SCRIPT

`[CORE]`

`[FACE]`

You're down in the title notices
looking for six-E-twelve
to list your district notices.

It isn't there.

[pause]

`[SCREEN: page 4, ¶6.E(11)]`

In twenty-eighteen, six-E ran to **twelve.**
In twenty-nineteen it stops at **eleven.**
Eleven is the mold remediation certificate.

`[OPTIONAL]`

One through eleven didn't move.
Same items, same numbers, same order.
Only twelve left.

[pause]

`[CORE]`

`[SCREEN: page 9, ¶22 Statutory Disclosures line]`

It's in paragraph **twenty-two** now,
under a group heading called
Statutory Disclosures and Notices.

`[OPTIONAL]`

Utility, water, drainage, public improvement,
and other district notices.
You list them right there.

`[CORE]`

`[FACE]`

And the bold notice under that line says
a seller's failure to provide them **may** give
your buyer remedies or a right to terminate.

`[OPTIONAL]`

Same trap. New address.

`[CORE]`

That's four of six.
Follow for the rest, and save this.

**Word count: 116 spoken words.** Runtime: 0:35 / 0:50. Shortest of the five.
**CORE only: 86 words** — 0:26 at 200 wpm / 0:37 at 140 wpm.
**CORE + OPTIONAL: 116 words** — 0:35 at 200 wpm / 0:50 at 140 wpm.

> **This script's LONG cut is the one at risk.** At a punchy 200 wpm the full read lands at 0:35,
> which is UNDER the 40-second floor of the long vertical lane, and the producer will refuse to
> queue it. Deliver this one at the measured 140 wpm (0:50) or ship it as a single short.

### CORE MUST CARRY
- "may"
- "in twenty-nineteen it stops at"

*Why "may": MUST NOT SAY calls this "the most consequential possible error in this video." The
form says a seller's failure "**may** provide Buyer with remedies or rights to terminate." Drop
one three-letter word and a conditional becomes a guarantee of a termination right that does not
exist. It is the shortest word in the script and the most expensive one to lose. "In twenty-nineteen
it stops at" holds the change to the right form — without it the core states that ¶6.E ends at
eleven full stop, which is false of the 20-18 contracts still in force.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "six-E ran to twelve" in 20-18 | 20-18 page 4, verbatim: "(12) REQUIRED NOTICES: The following notices have been given or are attached to this contract (for example, utility, water, drainage, and public improvement districts)" |
| "In twenty-nineteen it stops at eleven" | **Page 4**, 20-19 — ¶6.E's last item is "(11) CERTIFICATE OF MOLD REMEDIATION"; ¶7 PROPERTY CONDITION begins on the next line. There is no (12) and no (13). |
| "Eleven is the mold remediation certificate" | Page 4, verbatim: "(11) CERTIFICATE OF MOLD REMEDIATION: If the Property has been remediated for mold, Seller must provide to Buyer each certificate of mold damage remediation issued under §1958.154, Occupations Code, during the 5 years preceding the sale of the Property." |
| "One through eleven didn't move" | Items (1)–(11) are unrenumbered and substantively unchanged between the two forms. |
| "paragraph twenty-two … Statutory Disclosures and Notices" | **Page 9**, group heading "Statutory Disclosures and Notices" |
| "Utility, water, drainage, public improvement, and other district notices" | Page 9, verbatim checkbox: "The following utility, water, drainage, public improvement, and other district notices (list all that have been given or are attached):" |
| "may give your buyer remedies or a right to terminate" | Page 9, bolded in the form: "NOTICE: Seller's failure to provide applicable Statutory Disclosures and Notices **may** provide Buyer with remedies or rights to terminate this contract." |

### MUST NOT SAY
- **Do not say "will give your buyer a right to terminate."** The form says **"may provide Buyer
  with remedies or rights to terminate."** Keep the "may." Overstating a termination right on camera
  is the most consequential possible error in this video.
- Do not say the notices requirement was "removed" or "relaxed." It moved paragraphs and kept its
  warning. The duty is the same.
- Do not renumber anything. Saying "everything shifted up one" is wrong — (1) through (11) are
  untouched.
- Do not call ¶6.E "the title commitment section." ¶6.E is TITLE NOTICES; the Commitment is ¶6.B.

---

# VIDEO 5 — THE ADDENDA LIST GOT RE-SORTED

**Hook summary:** If you find an addendum box by where it sits on the page, in 20-19 you're checking
a different box than you think.

**Cover hook text:** `SAME SPOT. DIFFERENT BOX.`

### SCRIPT

`[CORE]`

`[FACE]`

You go to check an addendum box
in the spot it's always been.
In twenty-nineteen, that's a different box.

[pause]

`[SCREEN: page 9, ¶22]`

Paragraph twenty-two isn't one long
two-column list anymore.
It's **five** named groups.

Financial. Leases. Additional Tests and Reports.
Statutory Disclosures and Notices.
And Other.

Everything got re-sorted underneath those headers.
So read the header.
Don't find the box by muscle memory.

[pause]

`[OPTIONAL]`

`[FACE]`

Two boxes are **new** to the list.
Release of liability on an assumed loan,
and restoration of the seller's VA entitlement.

And Non-Realty Items.
One came off as its own box —
the improvement district assessment notice.

And the part that never changes.
Every box you check has a document attached.
Every document attached has a box checked.

`[CORE]`

That's five of six. One left.
Follow along, and save this.

**Word count: 129 spoken words.** Runtime: 0:39 / 0:55.
**CORE only: 74 words** — 0:22 at 200 wpm / 0:32 at 140 wpm. Both inside the 21-34s window.
**CORE + OPTIONAL: 129 words** — 0:39 / 0:55.

> **The two OPTIONAL chunks move together and must never be split.** "Two boxes are new" is
> satisfied by the Release-of-Liability/VA-Entitlement addendum (ONE box) and Non-Realty Items
> (the second). They sit in different chunks. Tagging one CORE and one OPTIONAL would leave the
> core saying "two boxes are new" and then naming one — a miscount on camera about the exact
> thing the video is counting.

### CORE MUST CARRY
- "five"
- "named groups"
- "read the header"

*Why: the whole rule is that ¶22 is now five named groups and you must read the header rather than
find a box by position. A core cut that keeps the hook and the CTA but loses the count or the
instruction states a problem and no rule. The addenda themselves are examples — correct, verified,
and not the rule.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "five named groups" and the five names, in order | **Page 9**, verbatim group headers in this order: "Financial" · "Leases" · "Additional Tests and Reports" · "Statutory Disclosures and Notices" · "Other" |
| "isn't one long two-column list anymore" | 20-18 page 8, ¶22 is a two-column ungrouped checkbox grid — confirmed by layout extraction |
| "Release of liability on an assumed loan, and restoration of the seller's VA entitlement" | Page 9, verbatim: "Addendum for Release of Liability on Assumed Loan and/or Restoration of Seller's VA Entitlement". **Absent from the 20-18 list** — confirmed by full-list diff. |
| "Non-Realty Items" | Page 9, verbatim: "Non-Realty Items Addendum". **Absent from the 20-18 list** — confirmed. |
| "the improvement district assessment notice" came off | 20-18 page 8 has a standalone checkbox: "Addendum containing Notice of Obligation to Pay Improvement District Assessment". No such checkbox exists anywhere in 20-19. |

### MUST NOT SAY
- **Do not say any addendum form number.** 20-19 prints none — ¶22 names every addendum by name
  only, and so do ¶7.B, ¶7.C and ¶7.I. Numbers quoted from outside the contract are a weaker
  citation than the form itself and several in our own files are unverified. Say names.
- **Do not say the improvement district notice was "eliminated."** It came off ¶22 as a *standalone
  checkbox*; the obligation is picked up by the district-notices line in the same paragraph — which
  is Video 4's topic. "Came off as its own box" is the accurate phrasing and it's what's written.
- **Do not say there's a ¶22 checkbox for the Seller's Disclosure Notice, the Water Disclosure, or
  an Amendment to Contract.** There is not one for any of the three. The SDN is elected at ¶7.B, the
  Water Disclosure at ¶7.I, and an Amendment is a post-execution instrument.
- Don't claim a count of total boxes. Don't say "twenty-two boxes" or similar — no count was verified.

---

# VIDEO 6 — FAX IS NOT A DELIVERY METHOD

**Hook summary:** Fax came out of ¶21 — but the fax lines are still printed elsewhere in the
contract, which is exactly how someone talks themselves into using one.

**Cover hook text:** `THAT FAXED NOTICE ISN'T A NOTICE`

### SCRIPT

`[CORE]`

`[FACE]`

You fax the notice
the way you always have.
Under twenty-nineteen, that's not a delivery method.

[pause]

`[SCREEN: 20-18 ¶21 beside 20-19 ¶21]`

Paragraph twenty-one used to read
mailed, hand-delivered,
or transmitted by **fax** or electronic transmission.

Now it reads mailed, hand-delivered,
sent by **overnight courier**,
or transmitted by electronic transmission.

Courier's in. Fax is **out.**

[pause]

`[SCREEN: page 9 attorney block, then page 12 receipts]`

And here's where somebody talks themselves into it.
Fax only left **twenty-one.**
The attorney blocks still print a fax line.

`[OPTIONAL]`

So do the escrow receipts on the last page.
But those are contact fields.
They are not a way to give notice.

`[CORE]`

`[FACE]`

That's six of six. That's the series.
Save this one, follow for what's next.

**Word count: 105 spoken words.** Runtime: 0:32 / 0:45. Closest to the 30-34s target.
**CORE only: 85 words** — 0:26 at 200 wpm / 0:36 at 140 wpm.
**CORE + OPTIONAL: 105 words** — 0:32 at 200 wpm / 0:45 at 140 wpm.

> **Only 20 words are OPTIONAL here and that is on purpose.** This script is already the shortest
> of the five and its qualifier ("fax only left ¶21") is the reason the video exists. There is
> almost nothing in it that can be cut, which means the long cut runs 0:45 at the measured pace
> and 0:32 at a punchy one — the latter is under the long lane's 40s floor. Shoot it at the
> measured pace or publish it as a single short to both lanes.

### CORE MUST CARRY
- "fax only left"
- "twenty-one"
- "the attorney blocks still print a fax line"

*Why: MUST NOT SAY is explicit — "Do not say 'fax was removed from the contract.' It was removed
from ¶21 only." A trim that drops the qualifier leaves the video saying fax is gone from a
contract that still prints fax fields on pages 9 and 12, which is the error "a detail person
catches in three seconds, and it's the reason this video exists." The escrow-receipt half of that
qualifier can be OPTIONAL because the attorney-block half already carries the exception; both
halves going would not be survivable.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| The 20-18 wording | 20-18 page 8, verbatim: "21. NOTICES: All notices from one party to the other must be in writing and are effective when mailed to, hand-delivered at, or transmitted by **fax or** electronic transmission as follows:" |
| The 20-19 wording | **Page 8**, verbatim: "21. NOTICES: All notices from one party or their agent to the other must be in writing. Notices are effective when mailed to, hand-delivered at, **sent by overnight courier to**, or transmitted by electronic transmission to the other party or their agent." |
| "Fax only left twenty-one" | Page 8 contains no instance of "fax". Fax fields confirmed still present on **page 9** (¶23 attorney blocks, "Fax: ( )" for both Buyer's and Seller's attorney) and on **page 12** (three of the four escrow receipt blocks carry a Fax field). |
| "the escrow receipts on the last page" | Page 12 of 12 — the receipts page |

### MUST NOT SAY
- **Do not say "fax was removed from the contract."** It was removed from ¶21 only. The attorney
  blocks on page 9 and the receipts on page 12 still have fax fields. Saying it left the contract
  is the error a detail person catches in three seconds, and it's the reason this video exists.
- **Do not tell anyone their fax notice is void, invalid, or ineffective.** Say what the form says:
  fax is not among ¶21's listed delivery methods. Whether a particular notice was effective is a
  lawyer's question about a specific fact pattern.
- Do not say email replaced fax. Electronic transmission was already a method in 20-18. The method
  that is genuinely **new** is overnight courier.
- This video covers ¶21 only. Do not fold in ¶20, ¶17 or the page-11 deletion — one rule per video,
  and those are cosmetic by comparison.

---

## RUNTIME — READ THIS BEFORE SHOOTING

| Video | Words | At 200 wpm (short-form pace) | At 140 wpm (the pace the Video 1 long cut was measured at) |
|---|---|---|---|
| 2 — ¶12.B compensation | 139 | 0:42 | 1:00 |
| 3 — ¶8 disclosure | 142 | 0:43 | 1:01 |
| 4 — ¶6.E(12) moved | 116 | 0:35 | 0:50 |
| 5 — ¶22 regrouped | 129 | 0:39 | 0:55 |
| 6 — ¶21 fax | 105 | 0:32 | 0:45 |

**Only Video 6 hits 30–34 seconds, and only at a punchy short-form pace, and that is worth knowing before you
sit down rather than after.** The brief's own two constraints disagree with each other: 110–130
spoken words cannot be 30–34 seconds unless the delivery runs about 225 words per minute, and the
published Video 1 file measures Heath at 140. At 140 wpm, a true 32-second read is **about 75
words** — roughly half of what's written here, which is not enough room to state a rule, carry its
exception, and close a series.

**Recommendation: shoot these as written and let them land in the 40–60 second band.** The rules
need the exception line to pass the practitioner test, and cutting the exception is worse than being
twenty seconds long. These are TikTok and Reels safe (45s is the Instagram ceiling referenced in the
brief; at 200 wpm every one of these clears it, and at 140 wpm only Videos 2 and 3 reach a minute).

**If a hard 30–34 second cut is required,** the trim is the same in every script and it should be an
editing decision, not a rewrite: drop the opening `[FACE]` chunk and start on the screen-recording
line. That removes 20–24 words per video and costs the mid-consequence cold open — which is the part
that makes them work. Flag it back before doing that.

---

## GATE BEFORE PUBLISH

1. Every finished cut gets graded against `docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md` §17. Heath is
   not the checker.
2. **No war story appears in any of these five scripts, and none should be ad-libbed in.**
   `heath-verified-war-stories` has exactly two approved entries and neither fits these rules. If a
   take drifts into the Low Oak file, that take goes to Hadley before publish — active dispute, no
   names, no address, no dates, mechanism only.
3. No addendum form numbers spoken anywhere in the series. 20-19 prints none.
4. Nothing in these scripts states a legal consequence the form itself does not state.
