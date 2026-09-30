# TREC 20-19 — BONUS ROUND · TWO MORE SCRIPTS TO FILM

**Written 2026-09-30.** The six-video changes series (`docs/SCRIPTS-TREC-20-19-SERIES.md`) is
**done** — all six filmed, five published live, the sixth (¶21 fax) filmed and sitting in
`/home/heath/mw/v6/` waiting on editing, not on a script. Nothing below restarts or renumbers that
series. These are two additional, real, independently-verified scripts for the same form so
today's filming sitting isn't wasted waiting on V6's edit.

**Source of truth for every fact below:** `scripts/trec-forms/20-19.pdf` (TREC No. 20-19, footer
05-04-2026, 12 pages) and `.tmp-atlas-master-v2-resale.pdf` (TREC No. 20-18, 11 pages), both
extracted page-by-page with `pdftotext -layout` on 2026-09-30 — same method the original series
doc used, re-run fresh rather than trusted from memory. Every citation below quotes the actual
extracted text; nothing is carried over from `data/hadley-knowledge/trec-20-19.md` without being
checked against the PDF first.

**Format:** same verbatim camera-script conventions as the main series — `` `[FACE]` ``,
`` `[SCREEN: ...]` ``, `` `[pause]` ``, `` `[CORE]` ``/`` `[OPTIONAL]` `` for the two-cut split
(`docs/DUAL-CUT-PRODUCTION.md`). Three new tags, added per `docs/SCRIPT-SPEC.md` and gated by
`api/_lib/verify-video-script.js`: `` `[REHOOK]` `` (the mid-script "but…" pivot),
`` `[CTA]` `` (the call-to-action chunk), `` `[KEYWORD]` `` (the natural comment-trigger line).
All three are plain marker lines to the existing renderer (`scripts/video-engine/script-format.js`'s
`MARKER_LINE_RE` matches any backticked bracket line) — they carry no words, attach to the
following chunk, and do **not** change CORE/OPTIONAL cut assignment. Shoot both at the series'
~157 wpm pace, same seat, same wardrobe, same session as V6 if the edit isn't ready yet.

**Gate check before filming:**
```bash
node -e "console.log(require('./api/_lib/verify-video-script.js').validateScriptFile(require('fs').readFileSync('docs/SCRIPTS-TREC-20-19-BONUS-AND-OPTION-PERIOD.md','utf8')))"
```

## SHOT LIST — both scripts, same build as `dossie_water_FINAL_V8.mp4`

Per `docs/VIDEO-PRODUCTION-RECIPE.md`, this format's "b-roll" IS the real contract scrolling
behind a matted talking-head subject with circle annotation on the cited paragraph — not stock
footage. No Pexels/generic b-roll is used or needed for either script below.

| Script beat (teleprompter line group) | Shot |
|---|---|
| `[FACE]` chunks (cold open, the "here's what changes" pivot, the closing beat, CTA) | **Talking head.** Matted subject, full frame, 4K30, 6-8 ft back per the main series' recording block. |
| `` `[SCREEN: 20-18 page 10, Broker Information]` `` / `` `[SCREEN: 20-19 page 11, Broker Contact Information]` `` (Script 1) | **Document-scroll b-roll.** `scripts/video-engine/doc-scroll.js` over the actual 20-18/20-19 PDF pages, `annotate.js` circles the cited block (the disclosure line's old location / its absence on the new page). |
| `` `[SCREEN: page 2, ¶5.B]` `` (Script 2) | **Document-scroll b-roll** on 20-19 page 2, circle-annotate ¶5.B's "5:00 p.m." clause specifically — the annotation IS the accuracy proof, not decoration. |
| `[OPTIONAL]` elaboration chunks with no `[SCREEN]` tag immediately before them (e.g. "The old page split Other Broker...", "And the weekend rule in five-A-two...") | **Talking head**, matted, same as `[FACE]` — no new b-roll needed, these are spoken elaboration over the subject, consistent with how the main series' OPTIONAL chunks are shot. |
| `[pause]` markers | No shot change — a beat within whichever shot is already running. |

Both scripts shoot in the same sitting as V6, same seat/distance/wardrobe, same DJI lav input
check. Order: Script 1 (bonus) then Script 2 (option period) — slate each take out loud
("bonus, take one" / "option period, take one").

---

# VIDEO 7 — BONUS: THE FEE LINE ON PAGE 11 IS GONE

Not part of the numbered six. This is the bonus the main series doc already flagged as real,
verified, and "the last piece of the settlement cleanup" — the page-11 inter-broker compensation
disclosure line, deleted in 20-19.

**Hook summary:** The broker-to-broker fee note that used to sit on the signature page in 20-18
is gone in 20-19 — compensation now lives in exactly one place on the contract, ¶12.B, and if
that box is empty there's nothing else in the file backing up a co-broke split.

**Cover hook text:** `THE FEE LINE ON PAGE 11 IS GONE`

**Stake:** Leave paragraph 12.B blank on a co-broke file and there's nothing left on this contract
naming what the other side owes you — the backup line that used to catch that is gone, and you
could lose your only paper trail to the commission you're counting on.

### SCRIPT

`[CORE]`

`[FACE]`

You co-broke a deal
the way you always have.
You figure the broker page has you covered.

`[pause]`

`[SCREEN: 20-18 page 10, Broker Information]`

In twenty-eighteen, that page
carried a line under the broker boxes.
A fee, a percent, a promise between brokers.

`[SCREEN: 20-19 page 11, Broker Contact Information]`

In twenty-nineteen, that whole page
got renamed and rebuilt.
And that line is gone. Not moved. Gone.

`[pause]`

`[OPTIONAL]`

The old page split Other Broker and Listing Broker
side by side, with that disclosure
printed underneath both boxes.

The new page runs Seller's broker,
Buyer's broker, then Intermediary,
one block at a time. No disclosure line anywhere in it.

`[REHOOK]`

But here's what that actually changes.
Your separate co-broke agreement still stands.
That part of the law didn't move.

`[OPTIONAL]`

What moved is the backup.
This contract used to restate your split for you.
Now the only place it lives is paragraph twelve-B.

`[CORE]`

`[FACE]`

So the box at paragraph twelve-B isn't optional paperwork.
It's the only place in this file
that ties your check to this deal.

`[CTA]`

`[KEYWORD]`

That's the bonus round on twenty-nineteen.
Comment BONUS and I'll walk you through
exactly what changed, box by box.

**Word count: 177 spoken words** (verified via `scripts/video-engine/script-format.js`'s own
parser, not hand-counted). Runtime: 0:53 at 200 wpm / 1:16 at 140 wpm.
**CORE only: 95 words** — 0:29 at 200 wpm / 0:41 at 140 wpm.
**CORE + OPTIONAL: 177 words** — 0:53 / 1:16. Feasible pace band: 168-265 wpm (both cuts land
in-window at any speed in that range — confirmed with `paceBand()`).

### CORE MUST CARRY
- "Not moved. Gone."
- "twelve-B"

*Why: the whole hook is that the disclosure line was deleted, not relocated — "Not moved. Gone."
is the three words that keep a length trim from turning "deleted" into "moved somewhere else,"
which is the exact confusion the video exists to prevent. "Twelve-B" anchors where compensation
now lives; a core cut that names the deletion but never says where the real disclosure lives
leaves an agent with a problem and no fix.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "In twenty-eighteen, that page carried a line under the broker boxes" | 20-18 page 10, verbatim heading "BROKER INFORMATION" with a two-column "Other Broker Firm / Listing Broker Firm" block, followed by: "Disclosure: Pursuant to a previous, separate agreement, Listing Broker has agreed to pay Other Broker a fee (☐ $______________ or ☐ _____% of the Sales Price). This disclosure is for informational purposes and does not change the previous agreement between brokers to pay or share a commission." |
| "In twenty-nineteen, that whole page got renamed" | 20-19 page 11, verbatim heading "BROKER CONTACT INFORMATION" (not "BROKER INFORMATION") |
| "And that line is gone. Not moved. Gone." | Full-text search of every page of the extracted 20-19 PDF for "Disclosure", "previous, separate agreement", and "pay or share a commission" returns zero matches. The sentence does not appear anywhere in the form, not just off page 11. |
| "The old page split Other Broker and Listing Broker side by side" | 20-18 page 10 layout: two columns, "Other Broker Firm ... License No." beside "Listing Broker Firm ... License No.", each with its own represents/associate/team/address fields |
| "The new page runs Seller's broker, Buyer's broker, then Intermediary" | 20-19 page 11 layout: sequential blocks reading "...(Broker Firm) represents Seller only as Seller's agent.", then "...(Broker Firm) represents Buyer only as Buyer's agent.", then a separate "Intermediary" heading with "...(Broker Firm) represents Seller and Buyer as an intermediary." |
| "the only place it lives is paragraph twelve-B" | 20-19 page 7, ¶12.B "BROKERAGE COMPENSATION: Brokerage compensation is not set by law and is fully negotiable" — the paragraph is described in full in the main series' Video 2 script; this video does not re-explain it, only points to it. |

### MUST NOT SAY
- **Do not say the disclosure line was "moved" anywhere.** It was deleted. There is no paragraph,
  page, or footnote in 20-19 carrying equivalent text — confirmed by a full-text search of the
  extraction, not a page-by-page skim.
- **Do not say a broker can no longer get paid for a co-broke agreement.** The underlying
  broker-to-broker fee-sharing agreement referenced by the old disclosure is a separate contract
  between the brokers; nothing in 20-19 voids it. What changed is that this specific contract no
  longer restates it as a courtesy line — that's a paperwork change, not a compensation change.
- **Do not re-explain ¶12.B's mechanics.** That is Video 2's job. This video only points to where
  compensation now lives; naming the two-way structure again duplicates the series' own
  one-rule-per-video rule.
- Do not name a commission percentage or imply one is typical — same rule as the rest of the
  series.

---

# VIDEO — OPTION PERIOD BONUS: 5 PM ISN'T A BLANK

Standalone, not numbered with the changes series — this paragraph didn't change between 20-18
and 20-19 (confirmed: ¶5.B's text is identical in both forms except "Option Fee" capitalization).
This is a misconception-correction video, not a what-changed video, and the hook says so — it
never claims this is new in 20-19.

**Hook summary:** Agents call the option period ¶23 and treat the notice deadline as flexible.
It's ¶5.B, and 5:00 p.m. is printed text in the form itself — the only blank in that sentence is
the number of days, not the time.

**Cover hook text:** `THE 5 PM CUTOFF ISN'T A BLANK`

**Stake:** Miss the five p.m. cutoff on your last day and your notice may not count as timely —
the unrestricted right to terminate you were counting on may already be gone, and that puts your
buyer's earnest money in play instead of guaranteed back in their pocket.

### SCRIPT

`[CORE]`

`[FACE]`

You tell your buyer
they've got until midnight
on the last day of their option period.

`[pause]`

`[SCREEN: page 2, ¶5.B]`

Paragraph five-B doesn't say midnight.
It says five p.m., local time,
by the date specified. Printed. Not a blank.

`[OPTIONAL]`

The only blank in that sentence
is the number of days.
The five p.m. is typed into the form itself.

`[pause]`

Agents call this paragraph twenty-three.
It isn't. Twenty-three is
consult an attorney before signing.

`[OPTIONAL]`

And the weekend rule in five-A-two,
the one that saves your funding deadline —
that sentence is not repeated anywhere else in this form.
Five p.m. in five-B stands on its own.

`[REHOOK]`

But here's the part that actually bites.
The form doesn't say "five p.m. or so."
It says time is of the essence, strict compliance required.

`[OPTIONAL]`

That's paragraph five-E, the last line
of the whole paragraph.
It's not a suggestion. It's the enforcement clause.

`[CORE]`

`[FACE]`

Send that notice at five-oh-one
and it may not have landed
inside the time the form actually prescribed.

`[CTA]`

`[KEYWORD]`

That's the paragraph that gets misquoted most.
Comment OPTION and I'll show you
exactly how the math lands on your file.

**Word count: 182 spoken words** (verified via `scripts/video-engine/script-format.js`'s own
parser). Runtime: 0:55 at 200 wpm / 1:18 at 140 wpm.
**CORE only: 74 words** — 0:22 at 200 wpm / 0:32 at 140 wpm.
**CORE + OPTIONAL: 182 words** — 0:55 / 1:18. Feasible pace band: 131-211 wpm.

### CORE MUST CARRY
- "five p.m., local time"
- "Printed. Not a blank."
- "may"

*Why: "five p.m., local time" is the corrected fact itself — a core cut that keeps "paragraph
five-B doesn't say midnight" but drops the actual time restates the error's shape without fixing
it. "Printed. Not a blank." is the mechanism (why an agent can't just write in a later time), and
losing it turns a form-based correction into an unsupported assertion. "May" carries the same
job it carries in Video 4 of the main series: the form does not say a late notice automatically
voids the termination right or forfeits earnest money, and a trim that drops "may" for "will" or
"does" states a legal consequence the form itself does not state.*

### MUST BE EXACT
| Spoken | Verified against |
|---|---|
| "Paragraph five-B doesn't say midnight. It says five p.m., local time, by the date specified" | 20-19 page 2, ¶5.B verbatim: "Notices under this paragraph must be given by 5:00 p.m. (local time where the Property is located) by the date specified." |
| "The only blank in that sentence is the number of days" | Same paragraph, verbatim: "...by giving notice of termination to Seller within _____ days after the Effective Date of this contract (Option Period)." The days count is the only underscored blank in ¶5.B; "5:00 p.m." has no blank anywhere near it. |
| "Agents call this paragraph twenty-three. It isn't." | 20-19 page 8, ¶23 verbatim heading: "23. CONSULT AN ATTORNEY BEFORE SIGNING: TREC rules prohibit real estate brokers and sales..." — confirmed to be a different paragraph, about attorney review, not the option period. |
| "the weekend rule in five-A-two... not repeated anywhere else in this form" | 20-19 page 2, ¶5.A(2) verbatim: "If the last day to deliver the earnest money, option fee, or the additional earnest money falls on a Saturday, Sunday, or Legal Holiday, the time to deliver the earnest money, option fee, or the additional earnest money, as applicable, is extended until the end of the next day that is not a Saturday, Sunday, or Legal Holiday." A full-text search of the extracted 20-19 PDF for "Saturday", "Legal Holiday", and "extended until" returns matches ONLY inside ¶5.A(2) — no equivalent weekend/holiday extension sentence exists anywhere else in the form, including ¶5.B. |
| "paragraph five-E... time is of the essence, strict compliance required" | 20-19 page 2, ¶5.E verbatim, the last lettered subparagraph of ¶5: "E. TIME: Time is of the essence for this paragraph and strict compliance with the time for performance is required." |
| "it may not have landed inside the time the form actually prescribed" | ¶5.B verbatim: "If Buyer gives notice of termination **within the time prescribed**..." — the form conditions the fee/earnest-money outcome on notice being within the prescribed time; it does not separately state what happens if notice is late, which is why this script says "may," not "will." |

### MUST NOT SAY
- **Do not say ¶23 is the option period.** ¶23 is "Consult an Attorney Before Signing." This is
  the exact error this video exists to correct — getting it wrong on camera is the single worst
  outcome for this script.
- **Do not say the 5:00 p.m. deadline can be changed, extended, or written into a blank.** There
  is no blank for the time anywhere in ¶5.B. The only blank in that sentence is the number of
  days in the Option Period.
- **Do not say a late termination notice automatically forfeits the buyer's earnest money.** It
  does not, per the form's own text — ¶5.B's stated consequence for a TIMELY notice is that the
  option fee is not refunded and earnest money IS refunded; the form is silent on what happens to
  earnest money after a late notice specifically. Under ¶15 (default/remedies), a seller still has
  to establish default and pursue a remedy — losing the ¶5 unrestricted right to terminate is not
  itself an automatic forfeiture. Say "may" and "in play," not "gone" or "forfeited."
- **Do not claim the ¶5.A(2) weekend/holiday extension applies to the ¶5.B notice deadline.** It
  is written into ¶5.A(2) only, for earnest money/option fee/additional earnest money delivery —
  confirmed by a full-text search, not an assumption. Do not imply a Friday 5:00 p.m. deadline
  rolls to Monday.

### Fulfilling the keyword-trigger promise

Both scripts promise a live follow-up when someone comments the trigger word (BONUS / OPTION) —
not a pre-built document. Nothing named "the plain-English rundown" or "the math walkthrough"
exists as a file today, and per `heath-verified-war-stories.md`'s own caution against inventing
resources that don't exist (a TREC deadline one-pager was invented once and nearly posted), this
is deliberately phrased as a reply Heath or the comment-engagement system can generate on the
spot, not a claim that a document is already sitting somewhere. Wire it through the same
comment-to-DM path already confirmed live (`session-state-2026-09-29-isp-cutover.md`: "Zernio CAN
send DMs") before these post, or answer top-level comments manually — either fulfills the promise
as written.
