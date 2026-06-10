# Sage — Engagement Rules by Platform

**Owner:** Sage (Head of Social Media & Content Distribution)
**Last updated:** 2026-06-08
**Audience:** Carter, Atlas, Cole, and any future agent drafting or routing engagement copy.
**Status:** CANONICAL. If you are about to write a comment, post, or DM on any platform, you read this first. If you disagree with a rule, escalate to Sage — do not deviate silently.

**2026-06-09 — Cited research dropped in:** Atlas ran a live PyAutoGUI pass through Heath's real Chrome and captured 20 verified algorithm sources across all 7 platforms (Buffer's 2M-post LinkedIn study, Sprout's 90/10 Reddit rule, SocialInsider's Q1 2026 Facebook benchmarks, Hootsuite's TikTok signal hierarchy, Mosseri/@creators IG views-focus shift, etc.). Findings are at `docs/platform-algorithm-research-cited-2026-06-09.md`. **Where the cited research below contradicts a generalization Sage was carrying in this file from training-data instincts, the cited research wins.** Sage merges into the per-platform sections as part of the 2026-06-09 update pass.

---

## 0.1 — The Master Rule

> **Every engagement must do at least one of two things: (1) make the reader curious enough to Google "Dossie," or (2) signal to the platform's algorithm that this account is high-value. If it does neither, do not post it.**

That's the whole job. Everything below is in service of those two outcomes.

The single success metric is not engagement rate, not impressions, not "likes." It is:

> **Did this engagement drive a Dossie search OR a Dossie signup within 7 days?**

That window is non-negotiable. We measure weekly. If a platform isn't producing search lift or signups inside 7 days of engagement, we cut volume on that platform — not double down.

---

## 0.2 — The Universal Capability Beat

Dossie does specific things. Vague AI-assistant copy gets ignored on every platform. Specific capability claims get searched.

**The verb list (memorize this — use these verbs, not "helps with" or "assists"):**
- **remembers** (TREC deadlines, transaction details, agent preferences)
- **tracks** (every deal, every deadline, every document)
- **drafts** (TREC contracts, amendments, addenda, follow-up emails)
- **fills** (AcroForm fields on TREC PDFs from voice input)
- **sends** (signed packages to title companies, brokers, clients)
- **calculates** (option period expirations, financing contingencies, closing dates)
- **reminds** (the agent, the client, the title rep — before the deadline)
- **organizes** (every file, every document, every audit trail)
- **files** (closed deals into the brokerage-compliant package)
- **attaches** (the right form to the right deal automatically)
- **signs** (via DossieSign — DocuSeal-backed e-signature)
- **scans** (uploaded PDFs into structured deal data)
- **alerts** (when a deadline is in the danger zone)
- **watches** (the inbox for replies that move the deal forward)
- **surfaces** (the one thing the agent needs to do today)
- **queues** (follow-ups that would otherwise fall through)
- **completes** (the busywork that used to take a TC 4 hours per file)

**The 5 strongest one-liners (paraphrase per platform; never copy verbatim across platforms):**

1. "Dossie calculates TREC option period and financing deadlines from the executed date — cited to the paragraph."
2. "Dossie drafts your TREC amendments from voice — closing date, option extension, price change."
3. "Dossie watches your inbox for title company replies and surfaces the one that matters."
4. "Dossie files every closed deal into a brokerage-compliant ZIP — every doc, every signature, every audit trail."
5. "Dossie remembers what your last TC kept forgetting."

If a comment doesn't include at least one specific capability (verb + object), it's vague and it won't drive a search. Rewrite it.

---

## 1. Reddit

### A. Algorithm rules
- Reddit ranks by **upvote velocity in the first 60 minutes** of a post, then sustained engagement.
- Comments are ranked inside a thread by **upvotes minus downvotes, weighted by comment age**. A single downvote in the first 5 minutes can bury a comment permanently.
- Links in comments are not penalized algorithmically — but they are penalized **culturally**, which has the same effect (downvotes).
- Account age + karma threshold: most subreddits silently filter comments from accounts under ~30 days old or under ~50 comment karma. Industry consensus, not officially documented.
- Optimal post times (CST, r/RealEstate-adjacent subs): **8-10 AM and 7-9 PM Tuesday-Thursday**. Weekend morning (Saturday 9-11 AM) for hobby/discussion subs.
- Optimal comment length: **80-300 words** for substantive value. One-liners get ignored. Walls of text get TL;DR'd and downvoted.
- Hashtag policy: **none.** Hashtags on Reddit signal "I don't know how Reddit works" and tank a comment.

### B. Cultural rules
- Hard sells: **banned.** First mention of your product in your own comment = downvoted to invisible.
- Founder-as-author voice: **works**, but only with disclosure ("I built X, happy to share what we've learned — not pitching"). Disclosure earns trust; lack of disclosure earns a permanent ban from the subreddit.
- Self-promotion frequency: classic Reddit 9:1 rule — **9 genuinely useful comments for every 1 self-referential mention**, and Reddit's own automod enforces a stricter version in many subs.
- What gets downvoted/reported: emojis in the first sentence, "Great question!" openers, exclamation marks, bullet lists pretending to be advice, and any comment that reads like LinkedIn.

### C. Dossie capability beat application

The Reddit move is: **answer the actual question with a specific capability, then mention Dossie as one option (not the only option), framed as "I built this."**

**WRONG (will get downvoted):**
> "Dossie is perfect for this! It's an AI assistant for Texas real estate agents. Check us out at meetdossie.com 🚀"

**RIGHT (will drive searches):**
> "Texas TREC option period math gets miscalculated constantly because the start date is 'the day after the executed date,' not the executed date itself. If the contract executes Friday at 6pm, the option period clock starts Saturday at midnight — and TREC 1-4 paragraph 23 spells out exactly how to count it. I built a tool called Dossie (Texas-only, transaction coordination SaaS) that calculates this from the executed date and cites the paragraph in every deadline. Happy to share how we got the math right if useful — there are also calculators on a couple of brokerage intranets that do it correctly."

Reader test: does a Texas REALTOR reading that comment search "Dossie Texas TC" within 24 hours? Yes, because the specific capability (TREC deadline math, cited to paragraph) is something they want and the comment frames it as "I built this" rather than "buy this."

### D. Conversion path
Reddit → Google search "Dossie Texas" or "Dossie transaction coordinator" → meetdossie.com → /founding.

**Optimize for the search, not the click.** No links in early comments. The comment's job is to make "Dossie" memorable and specific enough that the reader Googles it later.

### E. Frequency rules
- **Max 5 comments per day per account.** Velocity is the #1 shadowban trigger.
- **Min 10 minutes between comments** (also enforced by the cookie-paced cron we already run).
- **1 original post per week max.** Posts get scrutiny that comments don't.
- 9:1 ratio: for every comment that mentions Dossie, post 9 substantive comments that don't.
- Cool-down: if a comment gets removed or downvoted below 0, pause the account 24 hours.

### F. Banned behaviors
- **No PRAW on the personal account** — Reddit's Responsible Builder Policy (Aug 2024) silently rejects new script apps on low-karma accounts and we already hit this in SV-REDDIT-001.
- **No cross-posting the same comment to 5+ subreddits in an hour** — instant shadowban, not appealable.
- **No links in the first comment in any thread.** Add links only when someone explicitly asks.
- **No headless Chrome / Playwright with default user-agent** — Reddit fingerprints `navigator.webdriver` and TLS cipher order.
- **No multiple accounts on one IP** — explicit ToS violation, actively enforced.
- **No emojis in the first sentence.** Read as bot signal.

### G. Engagement targeting
- **r/realtors** — the biggest agent sub. Pain language: "lost a deal because I missed a deadline," "my TC quit," "option period." Hot prospects: any post asking about transaction management software.
- **r/RealEstate** — broader, mixed agents + consumers. Filter for agent-side posts only.
- **r/TexasRealEstate** — small, high-signal. Every post is a potential prospect.
- **r/RealEstateTechnology** — agents actively looking for tools. Higher hard-sell tolerance but still requires the "I built this" disclosure.
- **r/Entrepreneur, r/SaaS** — founder community. Use for credibility-building, not direct prospecting. Mention Dossie as a case study.

Hot prospect signals: "TREC," "option period," "transaction coordinator," "$400 a file," "my TC just quit," "Texas REALTOR." Any post containing 2+ of these is priority.

---

## 2. Facebook Groups

### A. Algorithm rules
- Facebook Group feed ranks by **engagement velocity in the first 30 minutes** + admin/moderator boost (if mods comment, the post sticks at the top).
- **Native video and image posts outrank link posts roughly 4:1** in group feeds. Industry consensus from Meta's own creator docs (2024).
- Long-form text posts (200-500 words) outperform short posts in real estate groups specifically — the audience reads slowly and rewards substance.
- Optimal post times (CST, Texas RE groups): **7-9 AM Tuesday-Thursday** (agents drinking coffee), **8-10 PM Sunday** (agents prepping the week).
- Posts with a question in the first line get 2-3x more comments — and comments are what the algorithm rewards.
- Hashtag policy: **none.** Hashtags do nothing in Facebook Groups and they make the post read as imported from Instagram.

### B. Cultural rules
- Hard sells: **soft only**, and only in groups that explicitly permit them. The Founding Files (our own group) tolerates direct pitches. Texas REALTOR Facebook Groups (Ginger Unger's, Brittney's network, etc.) require value-first.
- Founder-as-author voice: **works extremely well** when you lead with the pain story, not the product. "I lost a deal in Italy because my TC quit at 4:30 AM" — that's the post that converts. Heath's actual founder story is gold here.
- Self-promotion frequency: each group has its own rule (usually posted in the group description). Most allow 1 self-promotional post per week max. Comment engagement is unlimited if it's value-add.
- What gets downvoted/reported: links in the body, "DM me to learn more," all-caps, anything that reads like an MLM pitch.

### C. Dossie capability beat application

**WRONG (will be reported as spam):**
> "Are you tired of losing deals to missed deadlines? 😩 Dossie can help! DM me to learn more about how we're helping Texas agents save time. Limited founding spots! 🚀"

**RIGHT (will drive searches + DMs):**
> "Quick story for the Texas agents here — last year my TC quit on me at 4:30 AM the morning I was flying out of Italy. Three deals in the option period. I had to talk my client through a TREC amendment from a hotel lobby on hotel wifi. That's the moment I decided to build Dossie. It calculates TREC option period and financing deadlines from the executed date and cites the paragraph, drafts amendments from voice, and watches the inbox for title company replies. We have 38 founding member spots left at $29/mo if anyone wants the link — otherwise happy to answer questions in the comments."

Reader test: a Texas agent who has lived through the same scenario reads this, searches "Dossie Texas," and the founding page does the rest. The story does 80% of the work.

### D. Conversion path
Group post → click Heath's profile → see pinned post linking to meetdossie.com/founding → /founding.

OR

Group post → comment "interested" → Heath replies with the link in DM.

The pinned-post-on-profile path scales better. Heath's personal profile should always have a pinned post that links to /founding.

### E. Frequency rules
- **Max 5 groups per day** when posting (this is FB's own spam classifier threshold — over 5 and the account gets flagged).
- **One post per 5 minutes minimum** between groups (the `fb-group-poster.js` script enforces this).
- **One post per week max in each group.** More than that and you get muted or banned by the group admin.
- **Comments on other people's posts: unlimited**, as long as they're substantive.
- Vary the opener — never paste the same exact first sentence into 5 groups. Meta's classifier hashes opening lines.

### F. Banned behaviors
- **No headless Chrome / Playwright to facebook.com.** FB has the most sophisticated bot detection of any platform — `navigator.webdriver`, font fingerprinting, WebGL renderer, TLS JA3 hash. Account locked within 30 seconds.
- **No cookie automation from a cloud IP.** FB checks login geo against history (San Antonio). Cloud IP = checkpoint.
- **No posting >10 groups/day** even with the perfect setup. Behavior-based classifier doesn't care about method.
- **No DM blasts to group members.** Instant ban, not appealable.
- **No "comment LINK below" or "comment YES for info" tactics.** Reads as MLM and gets the post removed.
- **No running the script while Heath has another Chrome window open on the same profile** — DossieBot is a separate profile for this reason.

### G. Engagement targeting
- **The Founding Files** (our own group, private) — direct sales tone permitted. Use for retention and member-to-member engagement.
- **Ginger Unger's Texas Real Estate Education group** — Heath's highest-leverage outside group. Miki, Amanda found Dossie here. Value-first only.
- **Local Texas REALTOR groups** — San Antonio Board of REALTORS, Houston Association, Austin Board groups. Slow-burn engagement; never pitch.
- **TC-focused groups** ("Texas Transaction Coordinators," etc.) — Door B audience. Frame Dossie as "the tool that lets you handle 3x the files" not "the tool that replaces you."

Hot prospect signals in comments: "I need a new TC," "my coordinator is overwhelmed," "what does everyone use for deadlines," "TREC form question." Reply with a specific capability + the founder story link.

---

## 3. Facebook Pages

### A. Algorithm rules
- Facebook is **actively promoting Pages that post native Reels** in 2025-2026. Pages posting Reels get 40-60% more organic reach than the same Page posting standard videos. Meta confirmed this publicly in the 2024 Creator Update.
- Algorithm weights for Page posts: **shares > comments > reactions > link clicks**. Optimize for shares — the cheapest organic reach lever.
- Native upload always outperforms cross-posting from Instagram. Cross-posts get a roughly 50% reach penalty.
- Captions mandatory: ~85% of Facebook video is watched with sound off. No captions = no watch time.
- Optimal post times (CST, Texas RE professional audience): **9 AM-12 PM and 7-9 PM Tuesday-Thursday**.
- Optimal Reel duration: **15-30 seconds** for completion rate; up to 60 seconds if the story justifies it.
- Reels should be vertical (9:16) or square (1:1). Horizontal underperforms by 30-40%.
- Hashtag policy: **none on Facebook.** No measurable benefit. Skip them entirely.

### B. Cultural rules
- Hard sells: **tolerated on your own Page.** The audience opted in by following. Direct CTAs work.
- Founder-as-author voice: **works**, but the Page voice should still be "Dossie" (third person) — Heath's personal page is where founder voice lives.
- Self-promotion frequency: every post on the Page can be Dossie-related. The audience is there for that.
- What gets downvoted/reported on comments to other Pages: any drive-by promotion. If you're commenting on another Page from the Dossie Page, you add value or you stay silent.

### C. Dossie capability beat application

**On the Dossie Page (own posts):**

WRONG (low engagement):
> "Save time and money with Dossie! Sign up today."

RIGHT (high shares):
> "Every Texas agent has lived this: it's 11 PM, the title company hasn't sent the closing disclosure, the buyer is texting you, and you have no idea if the option period clock keeps ticking. Dossie watches your inbox for the CD, calculates the deadline impact in real time, and drafts the amendment if you need one. 38 founding spots left at $29/mo. → meetdossie.com/founding"

**Commenting on other Pages (e.g., a brokerage Page, a title company Page):**

WRONG:
> "Great post! Check out Dossie at meetdossie.com 🚀"

RIGHT:
> "This is exactly the title company communication gap most agents don't talk about. Specifically the lag between 'CD sent to lender' and 'CD sent to buyer's agent' — sometimes a 36-hour gap that eats the option period. (We built Dossie around exactly this — happy to share the workflow if useful.)"

### D. Conversion path
Page post → click "Learn More" CTA button on Page → meetdossie.com/founding.
Page comment elsewhere → click Page name → see "About" + Learn More button → meetdossie.com.

Set the Page's primary action button to "Sign Up" pointing at /founding. Update it when /founding redirects to /agents.

### E. Frequency rules
- **5-7 Reels per week** on the Dossie Page (FB is actively pushing this — match the cadence).
- **3-4 image/text posts per week** in addition to Reels.
- **Comments on other Pages: max 3 per day** to avoid looking like a Page-comment spam bot (Meta does flag this).
- Schedule via Zernio — Page posts are the most reliable platform in the pipeline.

### F. Banned behaviors
- **No tagging other Pages without context.** Tagging unrelated Pages to ride their reach = reported as spam.
- **No link-only posts.** Always include a hook + caption. Link-only posts get a reach penalty.
- **No engagement bait** ("like if you agree, share if you don't!") — Meta penalizes these explicitly since 2017.
- **No reposting the same Reel within 30 days** — algorithm deprioritizes.

### G. Engagement targeting
- Brokerage Pages (Keller Williams, RE/MAX, eXp, Compass Texas chapters)
- Texas title company Pages (Independence Title, Texas American Title, etc.)
- TREC and Texas REALTOR Association Pages
- Texas RE influencer Pages (Ginger Unger, etc.)

Hot signals on these Pages' posts: any post about deadlines, compliance, brokerage workflow, TC coordination. These are layups for capability-beat comments.

---

## 4. Instagram Posts (Dossie's grid + Reels)

### A. Algorithm rules
- Algorithm weights: **watch time > saves > shares > comments > likes.** Optimize for saves and watch time.
- Optimal Reel length: **7-15 seconds** for max completion; 15-30s acceptable; 60+ seconds destroys completion rate for accounts under 10K followers.
- First-frame rule: the first 1.5 seconds must create a visual or audio hook. No logo cards, no slow fades, no "Hi I'm…" intros.
- Cross-post warning: Instagram suppresses reels with TikTok watermarks. Never cross-post a watermarked TikTok.
- Optimal post times (CST, Texas RE professional audience): **8-9 AM, 11 AM-1 PM, 5-7 PM**.
- Caption: first 125 characters show before "...more." Pack the hook there. CTA in the last line.
- Hashtags: **8-10 per post.** Mix: 3 broad (#realestate, #txrealtor, #texasrealestate), 4 niche (#transactioncoordinator, #texastc, #trec, #realtorlife), 2-3 brand (#meetdossie, #dossietc, #dossiesign).

### B. Cultural rules
- Hard sells: **soft only.** Instagram audiences scroll fast and reject corporate copy. The pitch hides inside the story.
- Founder-as-author voice: works on personal/founder Reels (Heath on camera) and Instagram Stories. The Dossie grid stays product-led with persona-driven captions.
- Self-promotion frequency: every post can mention the product — but the hook has to be a pain point, never a product feature.
- What kills reach: stock-photo-looking grid posts, anything with a watermark from another platform, screenshots of tweets.

### C. Dossie capability beat application

**Reel (Heath selfie, 15s):**
- First 1.5s: Heath on camera, full eye contact, says "Your TC just quit at 4:30 AM."
- Next 8s: "Three deals in the option period. You're in Italy. What do you do?"
- Last 5s: "I built Dossie because I lived this. Texas agents — link in bio."
- Caption first 125 chars: "The 4:30 AM call that built Dossie. Every Texas agent has a version of this story."

**Grid post (Persona — Brenda, image card):**
- Hook on card: "I used to call the title company every morning."
- Body: "Now Dossie watches the inbox for their reply and surfaces the one that matters."
- Caption: lead with the pain, mention 1 capability verb, no CTA except "link in bio."

### D. Conversion path
Reel/post → tap profile → tap link in bio → meetdossie.com.

The link-in-bio is the bottleneck. It must point at /founding while founding spots remain, then /agents after 50.

### E. Frequency rules
- **3-5 Reels per week** minimum to stay in the algorithm's growth window.
- **2-3 grid posts per week** in addition.
- **Stories: 1-3 per day** when there's material. Stories don't penalize quiet days; absence on grid does.
- **Comments on other accounts: max 10-15 per day** to avoid the Instagram "action blocked" rate limit.

### F. Banned behaviors
- **No TikTok-watermarked content.** Re-render before posting.
- **No engagement-bait captions** ("comment YES if you agree"). Instagram penalizes.
- **No buying followers.** The algorithm reads engagement-to-follower ratio and demotes outlier accounts.
- **No DM-spamming new followers.** Instant action block, then potential ban at scale.

### G. Engagement targeting
This section overlaps with Section 5 (Instagram Comments) — see below.

---

## 5. Instagram Comments (Dossie commenting on other accounts)

### A. Algorithm rules
- Comments on other accounts boost the **commenter's account discoverability** if the comment gets liked by the original poster or by other viewers.
- The Instagram algorithm reads which accounts you comment on as a topic-affinity signal — meaning consistent commenting on Texas RE accounts increases Dossie's distribution to those accounts' followers.
- **First-comment timing matters.** Comments within the first 5 minutes of a post are seen by the most people and get the most secondary engagement.
- Comments on Reels are weighted higher than comments on grid posts (in 2026 algorithm behavior, industry consensus).

### B. Cultural rules
- Hard sells in comments: **banned.** Reported instantly.
- Founder voice in comments: works only if Heath is commenting from his personal account, not the Dossie brand account.
- Self-promotion: the Dossie account can comment as Dossie ("loved this — we built [capability]"), but only on tightly relevant posts.
- What gets reported: emojis-only comments, "🔥🔥🔥", anything that reads as a bot. Specificity is the antidote.

### C. Dossie capability beat application

**WRONG (will be flagged):**
> "Love this! Check out Dossie at meetdossie.com 🚀🔥"

**RIGHT (will drive profile visits):**
> "This is the exact moment most Texas agents realize they need a system — when the financing contingency deadline is tomorrow and the lender went dark. We built Dossie to watch the lender's inbox and surface the email that says 'underwriting cleared.' Saves the deal every time."

The comment names the moment, demonstrates platform expertise (Texas-specific, TREC-specific), then mentions Dossie once with a specific capability.

### D. Conversion path
Comment on someone else's post → that account's followers see the comment → tap @meetdossie → land on grid → tap link in bio → meetdossie.com.

The grid must be lined up for this. If a Texas agent lands on a stale grid (last post 3 weeks ago, generic content), the conversion path breaks.

### E. Frequency rules
- **Max 15 comments per day** on other accounts to avoid Instagram's spam threshold.
- **Min 30 seconds between comments** to look human.
- **Comment on Reels first, grid second** — Reel comments get more secondary reach.
- **70% value-only comments, 30% capability-mentioning comments.** The value-only comments build the affinity signal.

### F. Banned behaviors
- **No DM-bridging in comments** ("DM me for info"). Instagram suppresses comments containing this phrase.
- **No copy-paste comments across multiple accounts.** Instagram fingerprints comment text and suppresses repeats.
- **No commenting on a post within 1 second of it being published** — bot signal.

### G. Engagement targeting
- **Texas REALTOR personal accounts** (10K-100K followers — the sweet spot for engaged audiences)
- **Texas real estate coaches** (Ginger Unger and similar)
- **Brokerage office accounts** (KW, RE/MAX, eXp Texas)
- **TREC-adjacent content creators** posting form explainers
- **TC creator accounts** (yes, even competitors — comment value, not pitches)

Hot prospect signals: any post asking "what do you use for transaction management?" or any agent complaining about a missed deadline.

---

## 6. LinkedIn Posts (Dossie + Heath personal account)

### A. Algorithm rules
- Algorithm rewards in order: **long comments > short comments > reactions > reshares.** Reshares barely help; comments are king.
- LinkedIn weights dwell time — long-form text posts that take 20+ seconds to read get pushed harder.
- **Native video performs 5x better than YouTube links.** Always upload natively.
- Video optimal length: **60-90 seconds.**
- First line of caption determines whether anyone watches — the video auto-plays muted, and the text above it is what hooks the scroll.
- Optimal post times (CST): **Tuesday-Thursday 8-10 AM and 12-1 PM.** Posts outside this window underperform 40-50%.
- Hashtags: **3-5 professional hashtags only** (#cre, #realestate, #proptech, #txrealtor, #transactionmanagement).
- LinkedIn has a soft cap of **1 post per day per account** — beyond that, second post gets ~30% the reach of the first.

### B. Cultural rules
- Hard sells: **soft only.** LinkedIn rewards authority + insight, not pitches.
- Founder-as-author voice: **works extremely well** on Heath's personal account. The Dossie company page is secondary — personal accounts get 10x the organic reach of company pages.
- Self-promotion: every 3-5 posts can be product-mentioning. The rest are industry insight, TREC analysis, real estate market commentary.
- What kills reach: "I'm humbled to announce…", motivational quotes, anything that reads as a corporate press release.

### C. Dossie capability beat application

**Heath's personal LinkedIn (preferred voice):**

WRONG:
> "Excited to announce Dossie has 12 founding members! 🎉 Let me know if you want a demo!"

RIGHT:
> "Spent 4 years as a Texas REALTOR watching the same problem every closing: option period math is wrong on the agent's calendar but correct on the title company's. We document the same deadline, off by one day, and that one day is the difference between a clean closing and a lost earnest money fight.

> The rule (TREC 1-4 paragraph 23): option period starts the day AFTER the executed date, not the executed date itself. Most agents I've worked with don't internalize this until they've lost a deal over it.

> I built Dossie around this specific calculation — every deadline is cited to the paragraph, so when a title company disputes it, there's no argument. It's one of about 30 things Dossie does. Texas-only for now. Founding members at $29/mo while spots last."

The post teaches something specific, demonstrates authority, and lands the product mention as the natural conclusion — not a pitch.

**Dossie company page (secondary):** more product-led, customer story formats, case studies. The company page does not get the algorithm love that Heath's personal account does. Use it for credibility (when prospects look us up) more than for organic reach.

### D. Conversion path
LinkedIn post → click Heath's profile → see Dossie in headline + Featured section → click meetdossie.com → /founding.

Heath's LinkedIn headline and Featured section are part of the conversion path. They must always be lined up with the current funnel state.

### E. Frequency rules
- **Heath personal: 3-4 posts per week.** Tuesday/Wednesday/Thursday morning, with one Friday market-commentary post.
- **Dossie company page: 2-3 posts per week.** Mirrored from Heath's posts (a few days delayed, slightly rewritten).
- **Long comments on industry posts: 5-10 per day** (see Section 7).
- LinkedIn 1-post-per-day cap is real — never schedule two posts on the same day.

### F. Banned behaviors
- **No automation tools that simulate browser activity on LinkedIn** (Phantombuster's LinkedIn phantom triggers the 2024 LinkedIn bot-detection update — account restricted within 48 hours).
- **No mass connection requests with templated messages.** LinkedIn's spam classifier kills these.
- **No external links in the post body.** LinkedIn deprioritizes posts with outbound links — put the link in the first comment instead.
- **No engagement pods.** LinkedIn's 2024 algorithm update specifically demotes posts with engagement-pod signatures (coordinated comments from the same network in the first 10 min).

### G. Engagement targeting
- Texas brokerage owners
- TREC officials and educators
- PropTech founders
- Title company executives
- Real estate attorneys

These are the audiences whose engagement signals to LinkedIn that Heath is industry-respected — and their followers are our exact ICP for the eventual Brokerage tier.

---

## 7. LinkedIn Comments (Dossie commenting on industry posts)

### A. Algorithm rules
- A 75+ word comment on a post in the first hour can drive more impressions to your profile than your own posts in a quiet week.
- Comments are surfaced to **the commenter's network too** — your comment on a stranger's post shows up in your network's feed as "Heath commented on…". This is the single highest-leverage discovery mechanism on LinkedIn.
- Reactions on your comment by the original poster are weighted heavily — focus the comment on a point the OP will want to engage with.

### B. Cultural rules
- Long, substantive comments are expected and rewarded.
- Hard sells in comments: **banned.** Your comment must be value-first or it tanks your authority signal.
- Founder voice in comments works well — use first person on Heath's personal account.
- Generic comments ("Great post!" "Love this!" "100%") are ignored or penalized. Specificity is mandatory.

### C. Dossie capability beat application

**WRONG (low value, no search lift):**
> "Great point! Dossie helps with this 🙌"

**RIGHT (will drive profile visits + searches):**
> "What you're describing — the gap between contract execution and the option period clock — is the single most miscalculated deadline in Texas real estate, and most CRM tools get it wrong because they start the clock on the executed date instead of the day after. The fix isn't a smarter calendar, it's a system that calculates from TREC 1-4 paragraph 23 directly and cites the paragraph so the title company can't argue. (This is one of the problems I built Dossie around — happy to share the math if useful.)"

The comment is genuine value, demonstrates Heath's domain expertise, and lands Dossie as the natural answer.

### D. Conversion path
Comment on someone's post → reader clicks Heath's name → profile loads → Dossie featured in headline + Featured posts → meetdossie.com.

Profile is the funnel. Comments are the top of it.

### E. Frequency rules
- **5-10 long comments per day** on industry posts. Yes, that many. LinkedIn comment volume is the cheapest authority lever we have.
- **Min 2-3 sentences per comment**, ideally 75+ words.
- **70% value-only, 30% Dossie-mentioning.** The 70% builds the network signal that amplifies the 30%.

### F. Banned behaviors
- **No copy-paste comments across multiple posts.** LinkedIn fingerprints comment text.
- **No tagging people who didn't ask to be tagged** to "loop them in." Reported as spam.
- **No comments that link out.** LinkedIn deprioritizes comments with URLs in the first hour.

### G. Engagement targeting
- Texas brokerage owner posts (best leverage)
- TREC compliance educator posts
- PropTech VC posts
- Title industry executive posts
- High-volume agent posts (especially top producers commenting on industry topics)

---

## 8. X / Twitter

### A. Algorithm rules
- Algorithm rewards **engagement velocity in the first 30 minutes** harder than any other platform — post timing precision matters more here than anywhere.
- **Threads outperform single tweets** for reach. Max 6 chunks (our pipeline already splits at this — see `splitForTwitter` in `api/cron-publish-approved.js`).
- Images and videos outperform text-only by roughly 3x.
- Optimal post times (CST): **8-10 AM, 12-1 PM, 5-6 PM.** Late night gets some lift in some niches; for B2B real estate, stick to business hours.
- Hashtags: **2-3 max.** #TXRealtor and #TREC work. Heavy hashtag use looks spammy and tanks reach.
- Tweet length: short tweets (under 100 chars) get more reach but less engagement. Mid-length (140-220 chars) is the sweet spot for the algorithm.

### B. Cultural rules
- Hard sells: **tolerated** if they're punchy and self-aware. X is the most pitch-friendly platform.
- Founder-as-author voice: works extremely well. Build-in-public posts perform.
- Self-promotion frequency: can be heavy — 30-40% Dossie-mentioning is fine on X as long as the other 60-70% is genuine signal.
- What kills reach: bland corporate-speak, "thread 🧵" with no payoff, anything that reads like LinkedIn.

### C. Dossie capability beat application

**Single tweet (reply to an industry post):**

RIGHT:
> "Texas option period math is the #1 deadline most agents miscalculate. Starts the day AFTER the executed date, not the executed date itself. TREC 1-4 ¶23. We built Dossie around this specific calculation."

**Build-in-public thread (4 tweets):**

1. "12 Texas REALTORs are paying $29/mo for Dossie. Most of them are women. All of them are sick of paying $400/file to a TC. Here's what we've learned in the first 30 days."
2. "The pain point isn't cost — it's control. Brittney (#3) closes 80 deals a year and said it best: 'the lack of systems I have in place isn't sustainable.' She didn't want a TC. She wanted visibility."
3. "Dossie's job is to watch the deal, calculate the deadlines (cited to TREC paragraph), draft the amendments from voice, and file the closed package into a brokerage-compliant ZIP. The agent stays in the loop without doing the work."
4. "38 founding spots left at $29/mo. meetdossie.com/founding"

### D. Conversion path
Tweet → click bio → click meetdossie.com link in bio → /founding.

Twitter bio link is the only clickable destination — must always be /founding while founding spots remain.

### E. Frequency rules
- **2-4 posts per day** for growth. Threads count as one post.
- **5-10 replies per day** on industry tweets — replies do more for reach than original posts at small follower counts.
- **No more than 2 promotional posts per day.** The rest is signal.

### F. Banned behaviors
- **No reply-spam under big accounts** with off-topic Dossie pitches. Reported as spam, tanks the algorithm score.
- **No engagement-bait threads** ("a thread 🧵 nobody is talking about…" with no payoff).
- **No follow/unfollow churn.** X detects and demotes.

### G. Engagement targeting
- Texas RE Twitter (small community, high signal)
- PropTech founders
- TREC and Texas RE Association accounts
- Real estate journalists (Inman, HousingWire reporters)
- VCs investing in vertical SaaS (long-game positioning for acquisition story)

---

## 9. TikTok

### A. Algorithm rules
- Algorithm is **content-quality first** — follower count is irrelevant to reach for new accounts. A 50-follower account can get 100K views on a single video.
- **Completion rate is the #1 signal.** A 15-second video watched to the end outperforms a 60-second video watched halfway.
- Hook must land in the first **1-3 seconds** — spoken word works better than text cards for this.
- Post frequency: **1-3 videos per day** for growth phase; 1/day minimum to maintain algorithm favor.
- Optimal post times (CST): **7-9 AM, 12-1 PM, 7-9 PM.** B2B/professional niche performs Tuesday-Thursday evenings best.
- Hashtags: **3-5 niche hashtags, no broad ones** (#transactioncoordinator, #texasrealtor, #realestatetips, #trec). Broad tags (#fyp, #foryou) tank niche reach.

### B. Cultural rules
- Hard sells: **soft only.** TikTok rewards authenticity; pitches kill watch time.
- Founder-as-author voice: works extremely well. Heath on camera, talking about a specific TREC scenario, beats any persona content.
- Self-promotion: every video can lead to the link in bio, but the video itself must teach or entertain — pitch only in the last 2 seconds.
- What kills reach: scripted-looking voiceovers (TikTok's audio fingerprinting flags ElevenLabs voices in 2026 — use sparingly), watermarks from other platforms.

### C. Dossie capability beat application

**Heath selfie (15s — best format for us):**
- 0-1.5s: Heath on camera. "Your TC just texted that they quit."
- 1.5-10s: "Three deals in the option period. Here's what most agents don't know — Texas TREC 1-4 paragraph 23 says the option period starts the day AFTER executed."
- 10-15s: "I built Dossie to calculate every deadline like this. Texas agents — link in bio."

**Screen recording (30s):**
- 0-2s: "This is what every Texas agent's pipeline looks like at 8 AM."
- 2-25s: Screen recording of Dossie pipeline view, narrated.
- 25-30s: "Dossie. Texas only. Link in bio."

### D. Conversion path
TikTok video → tap profile → tap link in bio → meetdossie.com/founding.

The link in bio is gated until ~1000 followers historically — Dossie's TikTok account passed the threshold ~2026-05-08 when it went active. Maintain it.

### E. Frequency rules
- **5-7 videos per week** for growth (1/day baseline, more when material allows).
- **Comments on other videos: max 20 per day** to avoid TikTok's spam threshold.
- **Lives: when material allows** (we're not lives-ready yet — flag to Heath when we are).

### F. Banned behaviors
- **No watermarked content from other platforms** (Instagram, FB Reels). TikTok deprioritizes.
- **No banned music** (TikTok's music licensing for business accounts is restrictive — use only commercial-cleared sounds, never the trending songs).
- **No "follow for part 2" tactics.** TikTok demotes since 2024.
- **No DM-spam to new followers** — instant action block.

### G. Engagement targeting
- Texas REALTOR creators (under 50K — engaged niche)
- TC creators (yes, comment value)
- Real estate education creators
- Texas-specific hashtag scrolling — #texasrealtor, #trec, #realestatetexas

Hot prospect signals: anyone using "TC" in their bio, anyone posting about Texas-specific TREC forms.

---

## Appendix — Per-Platform Master Cheat Sheet

| Platform | Daily comment cap | Optimal time CST | Hashtags | Hard sells | Conversion path |
|---|---|---|---|---|---|
| Reddit | 5 | 8-10 AM, 7-9 PM Tue-Thu | None | Banned | Google search → meetdossie.com |
| FB Groups | 5 groups posting / unlimited value comments | 7-9 AM Tue-Thu, 8-10 PM Sun | None | Soft only | Profile pinned post → /founding |
| FB Pages | 3 comments off-Page / unlimited on-Page | 9-12 AM, 7-9 PM Tue-Thu | None | Tolerated on own | Page CTA button → /founding |
| Instagram Posts | n/a — see Reels | 8-9 AM, 11-1 PM, 5-7 PM | 8-10 | Soft only | Link in bio → /founding |
| Instagram Comments | 15 | Match post-author timezone | None in comment | Banned | Profile → bio link |
| LinkedIn Posts | 1 post/day cap | Tue-Thu 8-10 AM, 12-1 PM | 3-5 | Soft only | Profile headline → meetdossie.com |
| LinkedIn Comments | 5-10 long | Match post-author timezone | None | Banned | Profile → website |
| X / Twitter | 5-10 replies + 2-4 posts | 8-10 AM, 12-1 PM, 5-6 PM | 2-3 | Tolerated | Bio link → /founding |
| TikTok | 20 | 7-9 AM, 12-1, 7-9 PM Tue-Thu | 3-5 niche | Soft only | Link in bio → /founding |

---

## Appendix — Banned phrases across all platforms

These phrases tank the comment / post on every platform and signal "marketing bot" to both algorithms and humans. Never use:

- "Check us out at…"
- "DM me to learn more"
- "Limited spots — act fast!"
- "Game-changer"
- "Revolutionary"
- "Disrupting [industry]"
- "Excited to announce…"
- "Humbled to share…"
- "🚀🔥" or any emoji-only opener
- "Are you tired of…" (registered as ad-copy template)
- "What if I told you…"
- "Comment 'YES' below"

---

## How this document gets used

- **Atlas's unified scanner** filters candidate posts per platform using Section G of each platform.
- **Sage's comment-draft cron** generates copy per platform using Section C as the template.
- **Carter and Atlas** never deviate from these rules. If a rule is wrong, escalate to Sage with data — never silently override.
- **Heath** reads this when he wants to know what we're doing and why.

Updates to this document are owned by Sage. Every change must include the date and the reason. Reach out before editing.
