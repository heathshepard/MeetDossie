# Headless realtor bank — 2026-10-11 to 2026-10-15

Five headless videos (Heath's cloned voice over footage we own, no camera time) built
2026-10-09 for posting Sun 10/11 → Thu 10/15 while Heath is away. Lane: `heath-realtor`
only. Built by `scripts/headless-video/build_headless_video.py` from the specs in
`scripts/headless-video/specs/bank-1009-*.json`. Gate: `api/_lib/verify-video-script.js`
on this file; `scripts/check-video-quality-cli.js` (`--orientation vertical_long`) and
`scripts/video-engine/check-join-audibility.js` on each render.

Every contract fact below was read from `pdftotext -layout scripts/trec-forms/20-19.pdf`
(TREC No. 20-19, footer rev 05-04-2026, 12 pages) on 2026-10-09 and is quoted verbatim in
each section's FACT VERIFICATION block. Market figures come only from the connectMLS pull
Heath ran 2026-10-03 (recorded in `scripts/headless-video/specs/boerne-market-correction.json`
`_fact_verification`); nothing else on disk is a real pull, so nothing else is used.

Length: the prior realtor headless builds measured ~160 spoken words/min at 1.12x, so at
1.18x the 45-60s window is roughly 130-170 words. Each script below sits in that window.

TTS note: the clone pronounces the town "Bernie" (confirmed by Heath, memory
`heath-voice-clone-settings-locked.md`); the spec beats spell it that way for the voice and
`caption_rewrite` puts BOERNE back on screen. This file is the human-readable script of record
and spells it Boerne.

---

## VIDEO 1 — Boerne vs San Antonio: what September's numbers mean for a buyer this month

**Posts:** Sun 2026-10-11 07:00 CT · **Keyword:** DEADLINES → `https://meetdossie.com/marketing/trec-deadline-checklist.html`

**Cover hook text:** `BOERNE SELLERS TOOK 96 CENTS ON THE DOLLAR`

**Stake:** A buyer who writes at full list in Boerne this month gives up the four percent the average September seller already came down — on a $600,000 house that is $24,000 left on the table — and a missed contract date afterward can still terminate the deal.

### SCRIPT

If you are buying in Boerne this month, the September numbers just handed you leverage.

Fifty Boerne homes closed in September. Average sale price, six hundred twenty five thousand. Average days on market, one hundred seven. And the average seller took ninety six cents on the dollar against list.

San Antonio, same filters, same month. Three hundred thirty seven thousand average, ninety six days, ninety nine cents on the dollar.

So San Antonio sellers are barely moving off list. Boerne sellers, on average, came down four percent. On a six hundred thousand dollar house, that four percent is twenty four thousand dollars.

`[REHOOK]`

But those numbers are averages, one month, fifty sales. A fresh listing in a hot pocket is not negotiating. A house sitting past a hundred days probably is. Ask your agent for days on market before you write an offer.

`[CTA]`

`[KEYWORD]`

Comment DEADLINES and I will send you every date in the Texas contract, so the deal you just negotiated does not die on a missed day.

**Word count:** 164 spoken.

### FACT VERIFICATION

- SOURCE: connectMLS, pulled by Heath 2026-10-03, filters Single Residential / City = Boerne / closed sales, September 2026; San Antonio row same filters. Recorded in `scripts/headless-video/specs/boerne-market-correction.json` `_fact_verification` (the only real pull on disk).
- Boerne Sept 2026: 50 closings, average sale price $625,022, average CDOM 107 days, SP:LP 96%. Spoken as "six hundred twenty five thousand" (625,022 rounds down to that), "one hundred seven", "ninety six cents on the dollar against list" (= 96% average sale-to-list).
- San Antonio Sept 2026, same filters: $337,087 average, 96 days, 99% SP:LP. Spoken as "three hundred thirty seven thousand", "ninety six days", "ninety nine cents on the dollar".
- "came down four percent": 100% − 96% = 4%, stated as an average, never as a per-house promise.
- "$24,000 on a $600,000 house": 600,000 × 0.04 = 24,000 — illustrative arithmetic on a round figure the script names, not a market statistic.
- AVERAGES, NOT MEDIANS: "average" is spoken in every stat line and the sample-size caveat ("one month, fifty sales") is spoken, not just noted here.
- DELIBERATELY NOT USED: San Antonio's −1.2% YoY (not re-derivable — no prior-year SA average on disk); the 17.3% YoY Boerne price drop (already the subject of `heath-realtor-boerne-market-correction-2026-10-04`, posting 10/09); any months-of-inventory figure (our own calculation, not a connectMLS output).
- Keyword DEADLINES → the live checklist at meetdossie.com/marketing/trec-deadline-checklist.html (HTTP 200 on 2026-10-09; its ¶5.A/¶6.B/¶7.B rows were spot-checked against the form). No other video_library row owns DEADLINES.

---

## VIDEO 2 — TREC ¶6.B: the title commitment clock starts on the title company's desk

**Posts:** Mon 2026-10-12 07:00 CT · **Keyword:** TITLE → `https://meetdossie.com/marketing/trec-deadline-checklist.html`

**Cover hook text:** `THE DEADLINE THAT STARTS ON TITLE'S DESK`

**Stake:** If the title commitment is not delivered inside the 20 days plus the automatic extension, ¶6.B lets the buyer terminate and takes the earnest money back to the buyer — the listing side has handed over a free exit and a dead deal.

### SCRIPT

One deadline in the Texas contract does not start on the effective date. That deadline starts on the title company's desk.

Paragraph six B. Within twenty days after the title company receives a copy of this contract, the seller shall furnish to the buyer a commitment for title insurance.

Receives. Not the effective date. The twenty day clock starts the day the title company gets the contract in hand. If nobody sends the executed contract to title, that clock never started.

Miss the twenty days, and the time extends automatically, up to fifteen more days or three days before closing, whichever comes first.

`[REHOOK]`

But miss the extension too, and the buyer may terminate, and the earnest money goes back to the buyer. That is a free exit, handed over by the listing side.

So send the contract to title the day it is executed, and note the day title received it.

`[CTA]`

`[KEYWORD]`

Comment TITLE and I will send you my checklist of every deadline in the contract.

**Word count:** 166 spoken.

### FACT VERIFICATION

- Primary source: `pdftotext -layout scripts/trec-forms/20-19.pdf`, page 2 foot, read 2026-10-09.
- CORRECTION TO THE BRIEF: the title commitment is **¶6.B**, not ¶6.A. ¶6.A is "TITLE POLICY: Seller shall furnish to Buyer at □ Seller's □ Buyer's expense an owner policy of title insurance". The video cites 6.B.
- VERBATIM ¶6.B first sentence: "B. COMMITMENT: Within 20 days after the Title Company receives a copy of this contract, Seller shall furnish to Buyer a commitment for title insurance (Commitment) and, at Buyer's expense, legible copies of restrictive covenants and documents evidencing exceptions in the Commitment (Exception Documents) other than the standard printed exceptions."
- VERBATIM extension: "If the Commitment and Exception Documents are not delivered to Buyer within the specified time, the time for delivery will be automatically extended up to 15 days or 3 days before the Closing Date, whichever is earlier."
- VERBATIM termination: "If the Commitment and Exception Documents are not delivered within the time required, Buyer may terminate this contract and the earnest money will be refunded to Buyer."
- PROVEN NEGATIVE: "receives a copy of this contract" occurs exactly once in the 12-page form (line 129, ¶6.B); "Within 20 days" occurs exactly once (same line). No other deadline in the form keys off the Title Company's receipt.
- "Send the contract to title the day it is executed" is advice to the viewer, not a claim about Heath's own practice.

---

## VIDEO 3 — TREC ¶5.A: the three-day rule nobody reads right

**STATUS 2026-10-09: BUILT, NOT REGISTERED — CUT FROM THE BANK.** The render passed every measurable gate (joins 0 of 5 above p99, runtime 60.2s inside the 40-90s window, speed-once, decay tail, captions_box_readable 5/5) but failed the vision rule `captions_present` on two consecutive runs (3/5, then 2/5 pairs "changing"), and the brief's rule is cut-after-two. Nothing is wrong with the facts or the audio; the sampled 1s-apart frame pairs land inside long caption chunks on this read. Rebuild candidate for a later day (shorter chunks or a re-paced read), not for 10/13. The 10/13 slot is open.

**Posts:** ~~Tue 2026-10-13 07:00 CT~~ (not scheduled) · **Keyword:** OPTION → `https://meetdossie.com/marketing/trec-deadline-checklist.html`

**Cover hook text:** `THE 3-DAY RULE NOBODY READS RIGHT`

**Stake:** Deliver the option fee late and ¶5.D strips the buyer's unrestricted right to terminate; deliver the earnest money late and ¶5.C lets the seller terminate — a dead deal in either direction.

### SCRIPT

Three days to deliver earnest money. Most agents read that rule wrong.

Paragraph five A. Within three days after the effective date, the buyer must deliver the earnest money and the option fee to the escrow agent. Calendar days, not business days. Sign on Thursday, and day three is Sunday.

Part two. If the last day to deliver falls on a Saturday, Sunday, or legal holiday, the time to deliver is extended until the end of the next day that is not a Saturday, Sunday, or legal holiday. That Sunday rolls to Monday.

`[REHOOK]`

But that weekend extension appears exactly twice in the whole contract, both inside paragraph five A. The extension covers the earnest money, the option fee, and additional earnest money. Nothing else.

Paragraph five B does not roll. Option period ends on a Saturday? The termination notice is due by five p.m. Saturday. Deliver the option fee late, and five D says the buyer loses the unrestricted right to terminate.

`[CTA]`

`[KEYWORD]`

Comment OPTION and I will send you the checklist with every date and which ones roll.

**Word count:** 175 spoken (gate count). First draft (189 words) rendered at 63.6s; trimmed before the final render — hook lost "one of two ways", "Same paragraph, part two" → "Part two", the 5.B scenario became a question, second "paragraph five D" → "five D". No fact, quote or closing line was cut. Dropped lines: none.

### FACT VERIFICATION

- Primary source: `pdftotext -layout scripts/trec-forms/20-19.pdf`, page 2, read 2026-10-09.
- VERBATIM ¶5.A: "A. DELIVERY OF EARNEST MONEY AND OPTION FEE: Within 3 days after the Effective Date, Buyer must deliver to ___ (Escrow Agent) at ___ (address): $___ as earnest money and $___ as the option fee." The "3" is printed form text, not a blank. The form says "days", not "business days".
- VERBATIM ¶5.A(2): "If the last day to deliver the earnest money, option fee, or the additional earnest money falls on a Saturday, Sunday, or Legal Holiday, the time to deliver the earnest money, option fee, or the additional earnest money, as applicable, is extended until the end of the next day that is not a Saturday, Sunday, or Legal Holiday."
- PROVEN NEGATIVE: "Saturday, Sunday, or Legal Holiday" occurs exactly 2 times in the 12-page form (lines 81 and 83), both inside ¶5.A(2). This matches the 2026-09-30 verification recorded in memory `feedback_triple-check-public-facing-facts.md` and the quote used in `dossie-trec-5b-termination-weekend-2026-10-01`.
- VERBATIM ¶5.B: "Notices under this paragraph must be given by 5:00 p.m. (local time where the Property is located) by the date specified." The 5:00 p.m. is printed form text with no blank in that sentence.
- VERBATIM ¶5.D: "If no dollar amount is stated as the option fee or if Buyer fails to deliver the option fee within the time required, Buyer shall not have the unrestricted right to terminate this contract under this paragraph 5."
- VERBATIM ¶5.C (stake only, not spoken): "If Buyer fails to deliver the earnest money within the time required, Seller may terminate this contract or exercise Seller's remedies under Paragraph 15, or both, by providing notice to Buyer before Buyer delivers the earnest money."
- Scenario check: Thursday effective date → day 3 is Sunday → ¶5.A(2) rolls delivery to Monday. Walked on a calendar; this is the Wed–Fri execution trap recorded in memory `friday-execution-option-fee-trap.md`.
- NOT CLAIMED: that any other paragraph's deadline rolls; that ¶5.E's "time is of the essence" reaches outside ¶5.

---

## VIDEO 4 — Why people move to Boerne (Hill Country lifestyle, no contract content)

**Posts:** Wed 2026-10-14 07:00 CT · **Keyword:** BOERNE (engagement question — no DM asset, no automation armed)

**Cover hook text:** `NOBODY MOVES HERE FOR A SPREADSHEET`

**Stake:** Shop the Hill Country off a spreadsheet and you lose the one thing anyone actually moves here for.

### SCRIPT

Nobody moves to the Hill Country for a spreadsheet.

This is Boerne, Texas. Cibolo Creek runs straight through the middle of town, lined with bald cypress that go copper every fall.

There is a bandstand on the Main Plaza. There are ducks that own the pond next to that bandstand, and the ducks know it. Main Street still has the limestone storefronts, and the Hill Country ridge sits right behind the rooftops, so the sunset is part of the address.

Close enough to San Antonio to work there. Far enough that Boerne does not feel like San Antonio.

`[REHOOK]`

But here is what the drone cannot show you. The reason people stay is not the view. The reason people stay is that Boerne still feels like a town, not a suburb.

Drive through once. Park on Main Street. Walk down to the creek. Then try to stop thinking about it.

`[CTA]`

`[KEYWORD]`

If you have already made that drive, comment BOERNE and tell me the first thing that got you.

**Word count:** 165 spoken.

### FACT VERIFICATION

- Zero contract content and zero market statistics by design (Heath: "mixing in some other than paragraph content").
- Every concrete noun is something visible in the footage or recorded in `Media/b-roll/boerne/LIBRARY.md`: Cibolo Creek through town (cibolo-creek-* aerials, "autumn cypress on both banks", "rust-orange autumn colour"), the Main Plaza bandstand/gazebo, the plaza duck pond and ducks, Main Street limestone storefronts and the downtown aerial, the Hill Country ridge behind the rooftops (hill-country-golden aerial, town-overview aerial).
- "Close enough to San Antonio to work there. Far enough that Boerne does not feel like San Antonio." — qualitative, matches the already-approved line in `heath-realtor-boerne-establishing-2026-10-03`. No drive time or mileage is stated because none is verified on disk.
- NOT CLAIMED: that Heath lives in Boerne (he is San Antonio-based, CLAUDE.md §23); population, school, tax or price figures; any personal anecdote.
- Keyword BOERNE is an engagement question, not a DM promise — `dm_keyword` is left NULL so no automation arms and nothing is promised that cannot be delivered.

---

## VIDEO 5 — Autopsy: the day my transaction coordinator went dark

**Posts:** Thu 2026-10-15 07:00 CT · **Keyword:** BACKUP → `https://meetdossie.com/marketing/trec-deadline-checklist.html`

**Cover hook text:** `MY TC WENT DARK. THE AUTOPSY.`

**Stake:** When the one person tracking the file disappears, the ¶5 clocks keep running — a late option fee loses the buyer's right to terminate under ¶5.D, and a late earnest money delivery lets the seller terminate under ¶5.C.

### SCRIPT

My transaction coordinator went dark in the middle of a deal. Here is the autopsy.

Mid-transaction, my coordinator became unreachable. That is when I found out how much of that file sat on one person. The dates, the contacts, the status of every notice. All of that sat with someone I could not reach.

The contract did not care. Paragraph five E says time is of the essence for that paragraph, and strict compliance with the time for performance is required. None of the paragraph five deadlines pause because the person tracking them disappeared.

`[REHOOK]`

But the lesson is not hire a better coordinator. The lesson is that no deadline in your file should have exactly one person who knows about it.

Every date written where you can see it. Every contact in the file, not in someone's head. If the person watching your deadlines vanished tomorrow, could you list every date due this week?

`[CTA]`

`[KEYWORD]`

Comment BACKUP and I will send you the checklist of every deadline in the contract, so the dates live somewhere besides one inbox.

**Word count:** 170 spoken.

### FACT VERIFICATION

- Story: allowlist item 1 in memory `heath-verified-war-stories.md` — "The TC went dark. Heath's transaction coordinator went unreachable mid-transaction. Exposed how much of the process sat on one person with no backup." (Heath confirmed 2026-09-09.) The script states only that: unreachable, mid-transaction, the file sat on one person. No deal, client, address, date, outcome or gender is stated or implied; "someone I could not reach" is used deliberately.
- NOT USED: allowlist item 2 (the Low Oak earnest-money file) — an active dispute whose memory says to check it before publishing anything; left out entirely rather than risk it while Heath is away.
- "The dates, the contacts, the status of every notice" describes what a coordinator holds in general, not a claim about what was or was not lost on that file.
- VERBATIM ¶5.E: "E. TIME: Time is of the essence for this paragraph and strict compliance with the time for performance is required." The script says "for that paragraph" and does not stretch it to any other paragraph.
- ¶5 scope: A = delivery of earnest money and option fee, B = termination option (notice by 5:00 p.m.), C/D = failure to timely deliver, so "the paragraph five deadlines" is accurate.
- The closing lines are advice to the viewer ("Every date written where you can see it"), not a claim about a system Heath built or a resource he hands out.
- Keyword BACKUP → the live checklist (HTTP 200 on 2026-10-09). No other video_library row owns BACKUP.
