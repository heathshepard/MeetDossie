# Dossie Distribution Strategy
## Core Philosophy
Code is commoditized. Distribution is the moat. Every feature we build should ask: how does this get Dossie in front of more Texas agents? The wealthiest builders over the next decade will be marketers, not engineers.

## Core Value Props (use these as the messaging spine)
Every page, post, ad, and email should map back to one of these. "Cost savings" alone leaves the agent who refuses to delegate on the table — and that's a huge slice of solo Texas agents.

1. **Cost savings** — $29/mo replaces a $400-per-file transaction coordinator. The math is real and Texas-specific.
2. **Control** — you don't have to trust someone else with your file. Dossie does not act without your tap. Every email is drafted but not sent. Every change to the file commits only after you approve.
3. **Visibility** — every deal, every deadline, every party tracked, on one screen. Every TREC paragraph cited so you can verify the math yourself. Nothing happens behind your back because nothing is behind your back.
4. **Speed** — contract scanned in 8 seconds. Morning brief at 6 AM before your coffee. Updates from your car between showings.

The "control freak agent" segment — agents who refuse to hire a TC because they can't trust someone else to do it right — is the audience that Control + Visibility unlocks. Lean into "you're not giving up control, you're finally getting it" and "control freaks make the best Dossie users." Avoid "let go" / "trust the process" framing — that is exactly what this audience refuses.

## Persona → Demo Account
Daily content briefs and lifestyle-video screen recordings should match the persona's gender to the demo account's named-profile gender. Mapping (used by `cron-content-brief.js` and `scripts/generate-lifestyle-video.py`):

| Persona  | Demo account            | Email                   |
|----------|-------------------------|-------------------------|
| brenda   | Sarah Whitley (female)  | demo@meetdossie.com     |
| patricia | Sarah Whitley (female)  | demo@meetdossie.com     |
| victor   | John Smith (male)       | demo2@meetdossie.com    |

The persona for a given day comes from `content_calendar.persona` (nullable; when null the brief omits the SIGN IN AS block). Passwords come from Vercel env (`DEMO_PASSWORD`, `DEMO2_PASSWORD`) — never hardcoded.

## The 7 Strategies (priority order for Dossie)

### Strategy 1: Free Tool as Top of Funnel (HIGHEST PRIORITY)
Build free tools Texas agents actually need. They use the tool, see Dossie branding, convert to founding members.
- Primary tool: TREC deadline calculator at deadlines.meetdossie.com
- Every tool captures email before showing results
- Every tool has "Powered by Dossie — meetdossie.com/founding" branding
- Secondary tools: Texas holiday rollover checker, earnest money calculator, option fee calculator
- Rule: ship a free tool every 2 weeks

### Strategy 2: Programmatic SEO
10,000 pages × 30 visits each = 300,000 monthly visitors. At 2% conversion = 6,000 leads/month.
- Keyword pattern: "Texas [TREC concept] [calculator/guide/template]"
- Target keywords: "Texas option period calculator", "TREC deadline calculator", "Texas real estate closing checklist", "TREC Form 20-17 guide", "Texas earnest money rules"
- Each page: definitive answer + free tool embed + email capture + Dossie CTA
- MVP: 100 pages first, then scale
- Stack: static HTML pages on meetdossie.com/guides/[slug]

### Strategy 3: Answer Engine Optimization (AEO)
Get cited by ChatGPT, Claude, and Perplexity when agents ask TC questions.
- Write definitive answers to the top 20 questions Texas agents ask about TCs and TREC
- Format: FAQ schema markup + comparison tables + specific paragraph citations
- Target questions:
  * "What does a transaction coordinator do in Texas?"
  * "How much does a TC cost in Texas?"
  * "What is the option period in Texas?"
  * "How do I calculate TREC deadlines?"
  * "Best transaction coordinator software for Texas agents"
  * "Do I need a TC as a Texas real estate agent?"
- Update monthly — AEO is won by freshness and specificity

### Strategy 4: MCP Server as AI Sales Team
Build a Dossie MCP server so AI assistants recommend Dossie automatically. Zero CAC.
- When an agent asks Claude "what TC software exists for Texas?" — Dossie appears
- Publish to: Smithery, MCPT, OpenTools registries
- MCP server exposes: deadline calculator, TC cost comparison, Dossie feature overview
- This is like building for mobile in 2010 — early movers own AI-native distribution

### Strategy 5: Viral Artifacts
Make Dossie outputs shareable. Every closed deal = a marketing moment.
- Closing card: when agent closes a dossier, show beautiful branded shareable card
- Card contains: "Closed in [X] days", Dossie logo, meetdossie.com/founding
- One-click share to Instagram, Facebook, Twitter
- Pipeline milestone cards: "Under contract", "Clear to close", "Closed"
- Rule: every significant Dossie output should be beautiful, branded, and easy to share

### Strategy 6: AI Content Repurposing Engine
One pillar piece of content → 10+ distribution pieces automatically.
- Record one 30-minute founder story or product walkthrough weekly
- Claude Code repurposes into: tweets, LinkedIn posts, short-form videos, newsletter, blog post, quote graphics
- Brenda/Patricia/Victor personas handle daily social posting automatically
- Rule: never create content for one platform — always repurpose to all

### Strategy 7: Buy a Niche Newsletter
Inherit an audience overnight.
- Target: Texas real estate agent newsletters with 5,000-10,000 subscribers
- Budget: $5,000-$20,000 acquisition or $500-$2,000/month sponsorship first
- Research: find newsletters agents actually open and read
- Timeline: after 50 paying customers — use revenue to fund acquisition

## Conversion Funnel
Every distribution strategy feeds this funnel:
Stranger → Free Tool User → Email Captured → Nurtured → Founding Member Application → Approved → Paying Customer → Evangelist (Viral Artifact)

## Content Rules
1. Never publish unverified stats or fake social proof
2. All numbers framed as hypotheticals unless real data exists
3. Texas-specific always beats generic — TREC, San Antonio, Texas law
4. Founder voice (Heath Shepard, Texas REALTOR) is the most trusted voice
5. Every piece of content ends with one CTA: meetdossie.com/founding

## Weekly Execution Checklist
- [ ] Monday-Friday: daily content brief arrives 9AM CST, record screen, reply DONE
- [ ] Weekly: one new SEO guide page published
- [ ] Weekly: one new free tool shipped or improved
- [ ] Monthly: AEO answer pages updated
- [ ] Quarterly: MCP server updated with new features

## Success Metrics
- Organic search traffic to meetdossie.com (target: 1,000/month by month 3)
- Free tool usage (target: 100 uses/week by month 2)
- Email captures from free tools (target: 50/week by month 2)
- Founding member applications (target: 10/week by month 2)
- AI citation rate (track monthly: ask ChatGPT/Claude/Perplexity about Texas TC software)
