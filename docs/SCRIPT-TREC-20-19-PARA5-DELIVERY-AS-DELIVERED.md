# VIDEO 9 — Three days to deliver earnest money AND the option fee (as delivered)

Transcript-of-record for `v9_SPLICED.mp4`, written in the `docs/SCRIPT-SPEC.md`
shape so `api/_lib/verify-video-script.js` grades what actually shipped. The
spoken lines are Heath's words off the tape, verbatim — not a script written to
pass a gate.

**Source:** TREC 20-19 ¶5, page 2 of 12. Every claim below was read off
`pdftotext -layout scripts/trec-forms/20-19.pdf` before it reached the edit:

- **¶5.A** — *"Within 3 days after the Effective Date, Buyer must deliver to
  ______ (Escrow Agent) at ______ (address): $______ as earnest money and
  $______ as the option fee."* The **3** is printed form text. The blanks on
  that line are the escrow agent, the address and the two dollar amounts.
- **¶5.A(2)** — *"If the last day to deliver the earnest money, option fee, or
  the additional earnest money falls on a Saturday, Sunday, or Legal Holiday,
  the time to deliver ... is extended until the end of the next day that is not
  a Saturday, Sunday, or Legal Holiday."* The phrase "Saturday, Sunday, or
  Legal Holiday" occurs **exactly twice in the whole 12-page form, both inside
  ¶5.A(2)** — proving the negative: no comparable extension exists anywhere
  else, so an intervening weekend never moves the deadline.
- **¶5.C** — *"If Buyer fails to deliver the earnest money within the time
  required, Seller may terminate this contract or exercise Seller's remedies
  under Paragraph 15, or both, by providing notice to Buyer before Buyer
  delivers the earnest money."*
- **¶5.D** — *"If no dollar amount is stated as the option fee or if Buyer
  fails to deliver the option fee within the time required, Buyer shall not
  have the unrestricted right to terminate this contract under this paragraph
  5."* It is the **option fee**, not the earnest money, that kills the buyer's
  termination right — the tape says exactly this, in all three takes.
- **¶5.E** — *"Time is of the essence for this paragraph and strict compliance
  with the time for performance is required."*
- **¶11** — *"Real estate brokers and sales agents are prohibited from
  practicing law and shall not add to, delete, or modify any provision of this
  contract unless drafted by a party to this contract or a party's attorney."*
- **Effective Date** — defined nowhere in a numbered paragraph; the only
  definition in the form is the execution line on page 10, *"EXECUTED the ___
  day of ___, 20___ (Effective Date). (BROKER: FILL IN THE DATE OF FINAL
  ACCEPTANCE.)"* — which is why the remedy beat cuts to page 10 and highlights
  that exact line.

The form shown on screen is the blank promulgated PDF, enforced by
`scripts/video-engine/assert-blessed-pdf.js` (passes on
`scripts/trec-forms/20-19.pdf`).

**Known narrowing, deliberate and safe:** ¶5.A(2) extends for a Legal Holiday
as well as a Saturday or Sunday. Heath compresses that to "a weekend" on tape.
The compression makes the rule *narrower* than it is, i.e. it can only ever
make an agent move money earlier, never later — it cannot cause a missed
deadline. The on-screen highlight covers the **full** ¶5.A(2) sentence
including the words "Legal Holiday", and the on-screen chip reads "DAY 3 ONLY:
SAT, SUN, HOLIDAY", so the primary source carries the complete rule everywhere
the voice-over is shorter.

**Cover hook text:** `YOUR BUYER CAN'T WALK.`

**Stake:** Earnest money delivered late lets the seller terminate under ¶5.C; the option fee delivered late strips the buyer of the unrestricted right to terminate under ¶5.D — the seller can walk and the buyer cannot.

**Dropped lines:** Seven lines were cut, all of them transitions or restatements, none of them substance. (1) "and they point in opposite directions" — the payoff line "your seller can walk and your buyer can't" states the opposition directly. (2) "They lose the unrestricted right to exit they just paid for" — restates ¶5.D, which the line immediately before already delivers with its citation. (3) "Now, here's where it actually bites" — pure transition. (4) "they may not know is urgent" — the tail of the one-business-day sentence; the closing benefit clause is the line that needs the word "urgent", so it was kept there instead. (5) "The weekend just ate two of your three days" — colour on top of "Title's been closed all weekend" plus "one business day". (6) "So what do you actually do about it?" — pure transition into the remedy. (7) "Most people don't miss this on purpose. They miss it because nobody told them it was urgent." — the rhetorical tail after the closing benefit clause; the benefit clause itself ("tell your buyer before they sign that this is a three-day clock") is delivered in full and is the last substantive line before the CTA. Nothing was cut from the hook, either citation, the Friday trap, the ¶5.A(2) correction, the remedy, the re-hook or the CTA.

**Runtime note:** the read is genuinely long. Best-segment-per-act across all
three takes came to 90.6s of raw speech, 76.8s at the locked 1.18 speed. After
cutting the seven redundancies above at measured envelope minimums it is 74.45s
raw / 63.43s finished. It does **not** fit TikTok's 21-34s window, and it
cannot be made to without dropping protected substance — see the report.

### SCRIPT

`[HOOK]`

Your buyer has three days after the effective date to get the earnest money and option fee to the escrow agent.

`[SETUP]`

Three days. That's printed into the contract, not a blank you negotiate.

`[REVEAL]`

Miss it, and two separate things happen.

`[STAKE]`

Earnest money late gives the seller the right to terminate, paragraph 5C. Option fee late takes away your buyer's right to terminate, paragraph 5D.

`[PAYOFF]`

So your seller can walk and your buyer can't.

`[SCENARIO]`

Contract executes Friday afternoon. Day three lands on Monday. Title's been closed all weekend. Your buyer has one business day to move money, and the weekend rule doesn't save you.

`[QUOTE]`

5A2 only extends delivery if day three itself falls on a weekend. Monday isn't a weekend.

`[REMEDY]`

You can't change the three days. It's printed, and you're not allowed to change the contract. What you can control is the effective date. It's the day the last party signs and the acceptance gets delivered. If you're holding a Friday signature, delivering acceptance Monday morning makes Monday day zero.

`[REHOOK]`

It's still three days, but now all three are business days with the title company actually open.

`[CLOSE]`

And tell your buyer before they sign that this is a three-day clock.

`[CTA]`

`[KEYWORD]`

Comment option, and I'll send you every deadline in the contract with its paragraph.
