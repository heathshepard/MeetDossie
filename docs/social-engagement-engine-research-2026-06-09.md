# Social Engagement Engine — Research Brief

**Author:** Atlas
**Date:** 2026-06-09
**Run dir:** `scripts/atlas-runs/atlas-1781029330236/`
**Research method:** PyAutoGUI driving Heath's real logged-in Chrome (not Playwright). Google SERPs + ~6 direct vendor/docs pages per platform. Screenshots in Supabase `desktop-screenshots` bucket, captured via run log + `findings.json`.
**Why this exists:** Three platforms (Reddit, Facebook Groups, Instagram) and we've burned a day with nothing fully shipped end-to-end. Heath wanted to see what real SaaS founders, agencies, and bot operators actually do — not what's in our heads — before we pick the next path.

> One-line answer at the bottom of this doc. Skip there if you just want the decision.

---

## TL;DR — the three platforms compared

| Platform     | Scan posts                          | Auto-comment                                | Auto-post                                  | Ban risk (DIY)        | Best path for Dossie                                                                 |
|--------------|-------------------------------------|---------------------------------------------|--------------------------------------------|------------------------|--------------------------------------------------------------------------------------|
| **Reddit**   | RSS feeds (`.rss`/`.json`) — free, never rate-limited materially | Cookie scraping in Heath's real Chrome via PyAutoGUI | Same                                       | **High** if you script PRAW with personal account; **Low** if you comment manually-paced through real Chrome | **Path R-3** (real-Chrome cookie automation, paced like a human, low volume) |
| **FB Groups**| No official API — Graph API killed `group_feed` in 2018 / 2024 | Phantombuster, Apify, **or** our existing `fb-group-poster.js` (DossieBot Chrome profile) | Same                                       | **Very High** for headless Selenium; **Medium** for real-Chrome PyAutoGUI; **Low** for SaaS schedulers that use official login | **Path F-2** (continue with DossieBot Chrome profile, but pace it — 1 group / 5 min, max 5 groups/day) |
| **Instagram**| Graph API for Business accounts only (own media + comments on own media) | ManyChat / Manychat-like DMs (official); Phantombuster (cookie) for engagement on OTHER people's posts | Graph API (own posts only) or Phantombuster/Tailwind | **Very High** for cookie automation at any volume; **Low** for Graph API on your own posts | **Path I-1** (Graph API for our own posts + ManyChat for DM autoresponders; abandon cross-account engagement automation) |

---

## Reddit — full analysis

### 1. The legal/official method — Reddit OAuth + PRAW

- **What:** Register a "script" or "web" app at `reddit.com/prefs/apps`, get `client_id` + `client_secret`, use [PRAW](https://github.com/praw-dev/praw) (Python) or [snoowrap](https://github.com/not-an-aardvark/snoowrap) (JS) with your user credentials.
- **Limits as of 2024:** 100 queries / 60 sec for OAuth, 60 / 60 sec for un-authed. Reddit raised limits then enforced harder authentication in mid-2023 when API pricing changed.
- **Reality on personal accounts in 2025+:** Reddit's Responsible Builder Policy (Aug 2024) silently rejects new script-app registrations on accounts with low karma or recent age. We hit this exactly in SV-REDDIT-001 today — form POSTs returned `success:true` but Reddit served the policy notice instead. Documented widely on r/redditdev and Hacker News.
- **Fix path:** age + karma the account, OR apply for "researcher" tier, OR enterprise (paid tier $0.24 / 1k calls).
- **Cost:** Free for under 100 QPS; paid tier ~$0.24/1k requests if you cross that, plus enterprise minimum commits.
- **Risk:** Low. This is the sanctioned path.

### 2. The paid SaaS method

- **Hootsuite** ($99/mo Pro, $249/mo Team) — added Reddit publishing 2023; only posts to subreddits you mod or post your own content. No commenting / engagement.
- **Buffer** ($15-100/mo) — added Reddit posting 2024 as a beta; same constraints as Hootsuite.
- **Postoplan** ($25/mo) — Reddit included in cheaper plans; uses Reddit's official OAuth so it inherits the new-account rejection problem.
- **Lately AI** ($49/mo) — generates Reddit-formatted posts but you copy/paste; no actual posting bot.
- **None of them do automated commenting / replies on other people's posts.** That's not a market the SaaS players serve because it's banned by Reddit ToS.

### 3. The DIY method that doesn't get caught

The pattern real growth operators use (confirmed in r/SaaS, r/Entrepreneur, r/growthhacking threads):

1. **Use the `.json` endpoint for scanning.** Append `.json` to any subreddit / search URL — `reddit.com/r/RealEstate/.json?limit=25` — and you get JSON of recent posts with no auth and no signup. Treat as RSS. We already have this pattern in `scripts/`.
2. **Reply via cookie-driven real Chrome** at human pace. Open Chrome (already logged in), navigate to the post URL, click reply, type, submit. The exact pattern of `fb-group-poster.js` but for Reddit. Pace it: 1 comment per 10 minutes, max 5/day per account. Reddit's automod cares about velocity, not method.
3. **Vary the writing** (different intro lines, different paragraph counts) — Reddit's antispam pattern-matches duplicate content across subreddits.
4. **Never post a link in the first comment.** First 2-3 comments on a thread should add value; link in a follow-up if asked.

### 4. The DIY method to AVOID

- **PRAW on a fresh personal account at any meaningful volume.** Sub-karma threshold triggers shadowban within 24h. Multiple HN threads + r/redditdev pinned posts confirm.
- **Cookie automation on headless Chrome or Playwright with default user-agent.** Reddit's bot detection fingerprints `navigator.webdriver` and TLS-level cipher order. Headless Chrome detection is trivial for them.
- **Multiple accounts on one IP.** Reddit ToS bans this and they actively enforce.
- **Cross-posting same content to 5+ subreddits in 10 min.** Even from a "real" account this gets you shadowbanned.

### Concrete next step if Heath wants R-3

```
scripts/reddit-real-chrome-commenter.js
```
Modeled on `fb-group-poster.js`. Read a row from a new `reddit_replies` table (post_url, comment_body, status='approved'), drive DossieBot Chrome profile (or fresh `RedditBot` profile) to the post, paste the comment, submit, mark posted. Cron every 10 min, max 5 comments/day. **Build time: ~2 hours.** Heath approval before first live run.

---

## Facebook Groups — full analysis

### 1. The legal/official method — Graph API

- **Status:** dead for group engagement. Meta retired `group_feed` and `group_members` permissions in 2018, removed the rest in the 2024 platform cleanup. You can post to a Group **only if the Group admin installs your app**, which no real estate FB group will do.
- **Page posting is fine** (Pages API). Our existing Zernio pipeline handles this.
- **Cost:** Free.
- **Risk:** None — but you can't do anything useful in Groups.

### 2. The paid SaaS method

- **Phantombuster** ($69-359/mo) — provides "Facebook Group Auto Poster" + "Facebook Group Member Extractor" Phantoms. Uses your cookie (`c_user` + `xs`) which you upload via their browser extension. Heath would just paste the cookie. **Caveat: Meta added "Login Activity → New device" detection in 2024 which fires when Phantombuster hits from Tier-3 cloud IPs. They mitigate with residential proxies on the Pro plan.**
- **Apify** ($49+/mo or per-actor) — `apify/facebook-groups-scraper` and similar actors. Same cookie model. Generally more reliable than Phantombuster because Apify rotates IPs per actor run.
- **Browse AI** ($19-249/mo) — point-and-click scraper. Less suited for posting; great for monitoring a group's feed for new posts that mention realtor pain points.
- **Postoplan** ($25/mo) — claims FB group support but it's only on groups where you're admin (uses Pages API path).
- **Buffer / Hootsuite / Later** — all explicitly say "Pages only" for FB. No group posting.

### 3. The DIY method that doesn't get caught

We already built this. It's `scripts/fb-group-poster.js` + the DossieBot Chrome profile. The rules that keep it alive:

1. **One Chrome profile, persistent, logged in once manually.** Never re-login programmatically.
2. **Human-paced typing.** Existing script does this. Don't change it.
3. **One group per 5 minutes max.** Existing script enforces this with a queue. Don't batch.
4. **Don't post the same exact content to 5 groups in 5 minutes** — vary the opener.
5. **Stay under 5 groups per day.** Above that, FB's spam classifier fires.
6. **Never run while Heath has another Chrome window open on the same profile** — DossieBot is a separate profile specifically for this reason.

### 4. The DIY method to AVOID

- **Headless Chrome / Playwright fresh browser** to facebook.com. FB has the most sophisticated bot detection of any platform. They check for `navigator.webdriver`, font fingerprinting, WebGL renderer, TLS JA3 hash. You get a checkpoint within 30 seconds and the account is locked.
- **Cookie automation from a cloud server** — FB sees the IP delta from where you usually log in (San Antonio) and triggers a checkpoint. Phantombuster mitigates with residential proxies; DIY without proxies → banned.
- **Posting to >10 groups/day** even with the perfect setup. FB's classifier doesn't care about method, it cares about behavior.

### Concrete next step if Heath wants F-2

Already built. The remaining work is **operational discipline**, not code:
- Audit `scripts/fb-group-poster.js` enforces the 5/day cap (it does — see `MAX_DAILY_POSTS` constant)
- Add a "last 24h post count" check before queueing a new post
- Add a Telegram nightly summary: "Posted to 4 groups today, 1 queued for tomorrow"

**Build time: 1 hour for the audit + telegram summary.**

---

## Instagram — full analysis

### 1. The legal/official method — Instagram Graph API (Business)

- **What:** Convert your IG account to "Business" (free), link to a Facebook Page, register a Meta app, request `instagram_content_publish` + `instagram_manage_comments` scopes. Then you can:
  - Publish images/videos to YOUR account (`media` + `media_publish` endpoints)
  - Read comments on YOUR posts and reply to them
  - Read your own insights (reach, impressions, etc.)
- **What you CANNOT do:** comment on other people's posts, DM other accounts (only respond to DMs sent to you), scrape feeds of other accounts, like other people's posts.
- **Cost:** Free.
- **Risk:** None.
- **Limits:** 200 calls/hr per user, 25 posts/day per account.

### 2. The paid SaaS method

- **Tailwind** ($24.99/mo Pro, $49.99/mo Advanced) — schedules IG posts via Graph API. No engagement automation. Strong on hashtag suggestions and best-time scheduling.
- **ManyChat** ($15/mo Pro) — DM autoresponders triggered by keywords, story replies, comments. Uses Meta's official Messenger Platform integration so it's safe. **This is the only "engagement automation" tool that's actually sanctioned by Meta.**
- **Metricool** ($22/mo) — schedules + analytics, similar to Tailwind.
- **Later** ($25-80/mo) — same scheduling-only model.
- **Phantombuster** ($69+/mo) — provides cookie-based Phantoms for liking, commenting, following, story viewing on OTHER accounts. **Banned by Meta ToS, lifespan of an IG account doing this measured in days.** Phantombuster acknowledges this in their own docs.
- **Sprout Social** ($199-399/mo) — enterprise; same scheduling + DM management feature set but compliant.

### 3. The DIY method that doesn't get caught

Honest answer: **there isn't one for cross-account engagement at any meaningful volume.** Instagram's machine learning models are years ahead of Reddit's and Facebook Groups'. Every cookie-automation library on GitHub (`instagrapi`, `instabot`, `instagram-private-api`) has issues filled with "account banned after 3 days" reports from 2024-2025.

What works:
1. **Use Graph API for posting to our own account.** Tailwind-style. Cheap and safe.
2. **Use ManyChat for DM autoresponders.** Triggered by comments containing keywords like "info" or "link" → auto-DM a link. Compliant with Meta.
3. **For "engagement on competitors' posts" growth tactics — do it manually, by hand, with a human.** This is what real growth marketers actually do despite what the bot vendors claim.

### 4. The DIY method to AVOID

- **`instagrapi` / `instabot` / any cookie automation on a server.** Banned in days.
- **Mobile-emulation via Appium pretending to be IG mobile app.** Banned faster than cookies — IG has device fingerprinting that catches this within hours.
- **Buying a "warmed" IG account from a marketplace.** These are stolen accounts; meta resolves them within weeks.

### Concrete next step if Heath wants I-1

1. Convert `@meetdossie` to Business account (5 min, in IG app).
2. Link to MeetDossie Facebook Page (already exists in Zernio).
3. Register Meta app at `developers.facebook.com` → request `instagram_content_publish` scope. App review for the scopes takes 1-2 weeks but they grant it readily for legit Business accounts.
4. Wire `api/cron-publish-approved.js` to use Graph API instead of Zernio for Instagram posts (Zernio works today; this just gives us cost savings and reliability).
5. Sign up for ManyChat free tier, build one "info" keyword → auto-DM Founding link flow.

**Build time: 4 hours (mostly waiting for Meta app review).** Cost: $0 (Graph API) + $0-15/mo (ManyChat free/Pro).

---

## The honest recommendation for Dossie this week

Heath is one founder with a finite week. Pick **one** path per platform and ship it. Don't try to do all 9 paths at once.

**My pick:**

| Platform | What to ship this week | Why |
|----------|------------------------|-----|
| Reddit | R-3: real-Chrome cookie commenter, ~2h build, max 5 comments/day, Sage drafts copy | We already have the pattern (`fb-group-poster.js`). Reddit traffic for `r/RealEstate`, `r/realtors`, `r/realestateinvesting` is the highest-intent free traffic Dossie can get. |
| FB Groups | F-2: keep DossieBot pipeline, add discipline + nightly summary, ~1h | Built. Just operationalize it. |
| Instagram | I-1: Graph API + ManyChat, ~4h spread across the week | Cross-account engagement automation is a trap. Stop trying. Posting to our own account + DM autoresponders is the path. |

Total build: ~7 hours of Carter time. Spend: $0 net (might add ManyChat Pro $15/mo if free tier insufficient).

**What to NOT build:**
- ❌ Cloud-server cookie automation for FB/IG. Banned in days.
- ❌ Headless Playwright on facebook.com. Banned in minutes.
- ❌ Reddit PRAW on Heath's personal account at volume. Shadowbanned.
- ❌ Phantombuster for IG cross-account engagement. Burns IG account in days.
- ❌ Multiple Reddit accounts. ToS violation, easy to detect.

---

## Sources

Live research session captured in `scripts/atlas-runs/atlas-1781029330236/`:
- `research_run.log` — every URL visited with timestamps
- `findings.json` — structured per-platform results with screenshot URLs
- `*.png` — local screenshot copies of each page

Run by Atlas via PyAutoGUI on Heath's real Chrome — same pattern that confirmed PlayHT was dead in SV-PLAYHT-001. Bot detection bypass: not a factor (we're using Heath's real logged-in session).

---

## Appendix — pricing matrix (paid SaaS only)

| Tool | Monthly | What it actually does for us | Verdict |
|------|---------|------------------------------|---------|
| Hootsuite Pro | $99 | FB Pages + IG + Twitter + LinkedIn scheduling | Already have Zernio at $18/mo doing this. Skip. |
| Buffer Essentials | $15 | Same as Hootsuite, cheaper | Skip — Zernio does it |
| Postoplan | $25 | FB Pages + IG + Reddit (official) scheduling | Skip — Zernio + DIY Reddit |
| Phantombuster | $69-359 | Cookie-based FB Groups, IG, LinkedIn automation | High ban risk; consider only for FB Groups if DossieBot breaks |
| Apify | $49+ | Hosted scraper actors, FB Groups + lead scraping | **Maybe useful for lead scraping FB groups for ideal-customer signals** |
| Browse AI | $19-249 | Point-click monitoring | Useful for monitoring competitors' FB groups for pain-point posts |
| Tailwind | $24.99 | IG + Pinterest scheduling | Skip — Graph API + Zernio |
| ManyChat | $0-15 | IG DM autoresponders (compliant) | **Recommended — only sanctioned IG engagement tool** |
| Sprout Social | $199-399 | Enterprise SMM | Skip — over budget, over-featured |
| Lately AI | $49 | Long-form → social copy generator | Skip — Sage does this |
| Metricool | $22 | IG + FB analytics + scheduling | Skip |
| Later | $25-80 | IG-first scheduler | Skip |
