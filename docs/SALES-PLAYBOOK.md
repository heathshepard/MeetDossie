# Sales Playbook

**Read this before writing anything a customer or prospect will read** — upsell emails, cold outreach, landing copy, pricing pages, renewal notices, win-back messages, in-app upgrade prompts.

Written 2026-09-01 after an upsell draft opened with *"If it's not useful just ignore this. I'd rather you not pay for something you don't need."* Heath's response: *"that sounds like terrible sales."* He was right. This file exists so that never ships again.

This is not a style guide. Heath's voice rules live in the memory files `heath-email-voice-profile` and `heath-client-text-voice-profile`, and they still apply — short, direct, "Hey X," / "Thanks,". This file governs **structure and persuasion**, which is a separate thing from tone. A message can be perfectly in-voice and still sell nothing.

---

## The ten rules

### 1. Never hand them the out

The single worst habit. Any sentence that pre-authorises a no will be taken.

- ✗ "If it's not useful just ignore this."
- ✗ "No pressure at all."
- ✗ "I'd rather you not pay for something you don't need."
- ✗ "Just thought I'd throw it out there."
- ✗ "Sorry to bother you."

These feel considerate. They read as *the sender doesn't believe in this*. If you wouldn't say it out loud across a desk, don't type it.

The honest version of humility is **making the offer easy to decline without narrating the decline.** Say the thing, make the ask, stop.

### 2. Lead with their problem, not your feature

A feature is what you built. A problem is what wakes them up. Open on the problem, in the language they'd use.

- ✗ "a view that shows which required docs are present versus missing"
- ✓ "You send the file to compliance, they bounce it for a missing form, and your commission sits for another week."

The feature comes second, as the resolution. Never first.

### 3. Be specific or say nothing

Vague claims are ignored; specific ones are read and repeated. This is also what makes copy quotable by an AI search engine — see the same principle in the AEO work.

- ✗ "saves you time"
- ✓ "the median Boerne file has 14 required documents"
- ✗ "our customers love it"
- ✓ "five of my last eight reviews came from investors"

If you don't have the number, get it. If you can't get it, cut the claim — don't hedge it into mush.

### 4. One message, one ask

No menus. A message offering two things converts worse than either alone, because choosing is work and work gets deferred. If there are two add-ons, that's two emails two weeks apart.

### 5. Remove friction from the ask, not from the offer

The lowest-friction close usually isn't a link. For a small warm list, beating a checkout page is easy:

- ✗ "Here's the billing link, go to Settings → Billing and add the add-on."
- ✓ "Want me to switch it on? Reply yes and it's done in a minute."
- ✓ "I've turned it on for you for 30 days. Nothing to do. Tell me at the end if you want to keep it."

The second is the strongest play available to a founder with ten customers, and it's not available at scale — which is exactly why to use it now.

### 6. Assume the sale

Write as though they're going to say yes, then make it trivial to.

- ✗ "If you'd be interested, I could set it up."
- ✓ "Reply yes and I'll set it up today."

### 7. Anchor the price against the cost of the problem

$7.50 means nothing on its own. $7.50 against a commission held up for a week means something.

- ✓ "It's $7.50 a month. One file held up at compliance costs you more than a year of it."

Never apologise for the price and never over-justify it. One anchoring line, then move on.

### 8. Urgency only when it's real

A fake deadline works once and costs the relationship. A real one is powerful and Heath usually has one — founding pricing, a rate change, a form revision, a closing date. Use those. Invent nothing.

### 9. Write the P.S.

After the subject line, the P.S. is the most-read line in an email. Put the strongest specific there — the proof, the deadline, or the frictionless close. Never waste it on a pleasantry.

### 10. Subject lines: curiosity or specificity, never cleverness

Heath's own best-performing subjects are lowercase and plain: `6:47pm again?`, `$400 per file?`. Lowercase reads like a real person; title case reads like a newsletter.

- ✓ "when compliance bounces the file"
- ✓ "$7.50"
- ✗ "Introducing Compliance Vault!"
- ✗ "Unlock Your Productivity 🚀"

---

## Structure that works

```
Subject      lowercase, specific or curious, under 6 words
Line 1       their problem, concretely, in their words
Line 2       what you built, one sentence, as the resolution
Line 3       price + anchor, one line, no apology
Line 4       the ask — lowest friction version available
Sign-off     Thanks, Heath
P.S.         strongest specific: proof, real deadline, or "reply yes"
```

Four lines and a P.S. If it's longer, something in it isn't earning its place.

---

## Worked example — the rewrite that prompted this file

**Before (weak — rules 1, 2, 5, 9 all broken):**

> Quick one. I built a view that shows every open file and which required docs are present versus missing — so you find out before compliance does, not after.
>
> It's $15/mo, but founding members are half off, so $7.50. Link's here: [link]
>
> If it's not useful just ignore this. I'd rather you not pay for something you don't need.

**After:**

> **Subject:** when compliance bounces the file
>
> Hey Kim,
>
> You send a file in, compliance kicks it back for one missing form, and the commission sits another week.
>
> I built a view that shows every open file and exactly which required docs are missing, before it goes in.
>
> It's $7.50/mo on your founding rate. One held-up file costs more than a year of it.
>
> Want me to switch it on? Reply yes and it's done today.
>
> Thanks,
> Heath
>
> P.S. Founding rate is half price and it's locked for as long as you're a member.

Same length. Same voice. The difference is that the second one asks for the sale.

---

## Hard rules that override everything above

These are not persuasion techniques and they are not negotiable.

1. **Never invent a fact to make a sale.** No fabricated customer counts, no invented testimonials, no made-up statistics, no features that don't ship yet. See the `content-verifier` agent — route claims through it when in doubt.
2. **Never invent urgency.** No fake deadlines, no false scarcity, no "only 3 spots left" unless there are literally three.
3. **Heath is a licensed TX REALTOR.** Anything touching real estate services is advertising under TREC rules — see CLAUDE.md and the TREC advertising requirements. Sales pressure never overrides a disclosure requirement.
4. **Never pressure someone who has said no.** A no ends the sequence. A "not now" gets one follow-up at a stated interval, then ends.
5. **Never send to an unverified address.** See `cold-email-queue-fills-but-never-drains` in memory — a 33% bounce rate from guessed addresses put the sending domain at risk.

---

## The uncomfortable one

Good copy cannot fix a bad offer. In June–August 2026, 838 cold emails went out, 129 of them delivered to real agents at kw.com, and **zero** produced a customer. That is not a copy problem — better writing would have produced a better-written zero.

Before rewriting a message that isn't converting, check whether anyone actually wants the thing. Ten conversations beat a thousand sends, and a founder with ten customers can have all ten this week.
