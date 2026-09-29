# Prioritized Fix List — theheathshepardrealestateteam.com

Ranked by traffic-and-lead impact per unit of effort. Written 2026-09-17.
Effort in working hours. Everything requiring Heath personally is in §4, and the items in
§4 are cross-referenced from the table rather than being left implicit.

---

## 0. The honest framing before the list

At ~10 visits/month, none of these fixes produce leads on their own. Two things produce
leads on this domain in the next 90 days, and neither is a site fix:

1. **Google Business Profile reviews.** The keeper profile (`Shepard Real Estate Team`,
   Place ID `ChIJO2JbuzOAVSoRwa3PvvV6NYk`) sits at 5.0 with 2 reviews. The map pack renders
   above organic results for every "realtor near me" and "Boerne real estate agent" query.
   Going from 2 to 20 reviews is free, takes Heath about four hours of asking past clients,
   and will out-earn every item in the table below. Tested review link:
   `https://search.google.com/local/writereview?placeid=ChIJO2JbuzOAVSoRwa3PvvV6NYk`
2. **The content build** — the 12 guides, 40 neighbourhood pages and 60 answers already
   being written.

**The fixes below exist so that the content build lands on a functioning site instead of a
broken one.** A cornerstone page published into a shell with duplicate H1s, no phone in
the header, and an off-domain search button converts nothing, no matter how well it ranks.
That is the value being ranked here — not standalone traffic.

---

## 1. Ranked list

| # | Fix | Where | Effort | Expected effect | Heath? |
|---|---|---|---|---|---|
| 1 | Close the search leak — build `/search` on-domain, repoint nav + hero | nav, homepage hero, new page | 3h | Every buyer click stays on his domain instead of leaving on click one. Largest single conversion change available. | §4.6 for the IDX stage |
| 2 | Give `/boerne` an H1 and real content | `/boerne` | 0.5h shell, content from the hub agent | The single most commercially valuable URL on the domain currently has **zero H1 and one word of body**, while carrying a targeted title tag. It cannot rank for anything. | no |
| 3 | Kill the four duplicate H1s | `/investors` `/buyers` `/sellers` `/services` | 1h | Four pages currently declare the identical H1 "Available Services". Textbook cannibalization — Google has four candidates for the same intent and picks none confidently. | no |
| 4 | Rewrite the homepage H1 | `/` | 0.25h | Current: "Welcome to the heath shepard real estate team" — lowercased, zero keywords, zero proposition. Replace with a location-and-service H1. | no |
| 5 | Phone into the header as `tel:`, sitewide, desktop + mobile | global header | 1h | One `tel:` link exists, footer only. Phone calls are the highest-intent conversion a solo agent gets and it is currently below the fold on every page. | §4.2 (which number) |
| 6 | Fix the navigation: dedupe labels, add `/contact`, replace the `mailto:` CTA | global nav, homepage hero | 2h | "For Buyers" and "For Sellers" each appear **twice**, pointing at different URLs — identical sitewide anchor text to two targets. `Contact` links to `/`. The hero CTA is a `mailto:`, which is untrackable and fails for most visitors. | no |
| 7 | Upgrade the homepage JSON-LD per SCHEMA-TEMPLATES.md §2 | homepage SEO settings | 2h | Adds address, geo, TREC credential, GBP link, corrected LinkedIn, `@id` graph. Establishes the entity every one of the 800 future pages will reference. | §4.1, §4.2, §4.3 |
| 8 | Fix the dead LinkedIn URL in `sameAs` | homepage JSON-LD + wherever it appears in page content | 0.25h | The live block points at `linkedin.com/in/heath-shepard-b06515267`, an empty duplicate profile. The real account is `b8849135`. A `sameAs` pointing at an empty profile actively weakens entity consolidation. | no |
| 9 | Re-auth Search Console, install GA4 | Wix dashboard, Marketing Integrations | 1h | The Wix↔Google data connection is dropped ("verified, but Wix lost connection"), and GA4/GTM/dataLayer are confirmed absent from served HTML. **Publishing 800 pages with no analytics means no way to tell what worked.** This must precede the content build, not follow it. | no |
| 10 | Footer rebuild: social icons, NAP block, review link, licence line | global footer | 1h | Social icons appear only on `/about` and `/investors`; they belong sitewide for `sameAs` consolidation. The NAP block must match GBP character-for-character. | §4.2 |
| 11 | Trust signals on the homepage and `/about` | `/` `/about` | 2h + Heath's input | Zero testimonials, zero reviews, zero star rating, zero sold figures, zero awards anywhere on the site. A visitor has no reason to believe he has ever closed a deal. Note: on-site reviews will **not** produce Google stars — see SCHEMA-TEMPLATES.md §8. | §4.4 |
| 12 | Fix or noindex the thin pages | `/services` (27 words), `/blog` (12 words) | 1h | `/blog` is an empty shell — the sitemap index has no `blog-posts-sitemap.xml`, confirming zero published posts. Either fill them or `noindex` them before adding 800 pages; thin pages drag on a domain's overall quality assessment. | no |
| 13 | Sitewide `og:image` | Wix SEO settings, site-level | 0.5h | Confirmed absent. Every share of every URL — including the 800 new ones — renders as a blank grey box on Facebook, LinkedIn and iMessage. | no |
| 14 | robots.txt: explicit AI-crawler group | SEO & GEO → Robots.txt Editor | 0.3h | Current file is the Wix default. `Allow: /` already permits GPTBot, ClaudeBot and PerplexityBot by default; making it explicit makes the position deliberate and auditable rather than inherited. Also drop `Crawl-delay: 10` on AhrefsBot if backlink tooling is ever wanted. | no |
| 15 | Turn on IndexNow / direct URL submission | SEO Dashboard → Submit sitemap and URLs | 0.25h | Routes new URLs straight to Bing, which is what ChatGPT reads from. On a 10-visit domain this surfaces new pages to AI assistants faster than Googlebot will discover them organically. | no |
| 16 | Delete the redundant "TREC Disclaimer" footer link | global footer | 0.25h | It is a scanned JPG with no text layer containing an unofficial paraphrase of the Consumer Protection Notice, which is separately linked and correctly worded. An unofficial paraphrase of a required notice is a liability with no upside. | §4.1 — confirm with brokerage before removing |
| 17 | Mobile design pass on the homepage hero and contact form | mobile designs | 3h | Wix Classic keeps a separate mobile layout. The August audit found the hero panel collapsing so body copy renders as white text on a photo, and floating widgets covering the contact form's name fields. Mobile PageSpeed 55, LCP 11.6s. Not in the brief's scope but it is where traffic lands. | no |
| 18 | Alt-text sweep | homepage hero, all images | 0.5h | The hero image's alt text is the AI prompt that generated it: "please create a real life photograph of a large texas house. it should have a mixture of t". Indexed. | no |

**Not on this list, deliberately: page speed.** 147 requests, ~194 KB, 431 ms desktop
load. Desktop is fine. Mobile is not (item 17), but that is a layout problem, not a
weight problem.

---

## 2. Sequencing

**Before any new content page publishes:** items 2, 3, 4, 9, 13. Item 9 especially —
publishing the entire content build with no analytics wastes the only feedback loop the
project has.

**Week 1, alongside the first content batch:** 1, 5, 6, 7, 8, 10, 14, 15.

**Week 2-3:** 11, 12, 16, 17, 18.

---

## 3. What I would do first if only one thing got done

**Item 1 — close the search leak.** Not because it is the biggest SEO win (item 2 is), but
because it is the only fix that changes the outcome for traffic that already exists. Every
buyer who arrives today leaves for `heathshepard.kw.com` on their first click, and KW's
site does not carry his lead form, his phone, or his name above the fold. Fixing that costs
three hours and nothing per month (see IDX-RECOMMENDATION.md §4), and it compounds against
every visitor the content build sends.

---

## 4. NEEDS HEATH PERSONALLY

Legal, compliance, credential, and business-identity decisions. None of these can be
resolved by an agent, and several block work above.

### 4.1 IABS disclosure — two separate problems, one call

**Problem A: the form on the site is superseded.** The linked PDF is **IABS 1-0, dated
11/2/2015**. TREC's updated **IABS 1-2 is required for use as of 2026-01-01**, following
Senate Bill 1968, which added a non-representation status and written-agreement
requirements to TRELA and removed the subagency language.
— [TREC, Information About Brokerage Services Form](https://www.trec.texas.gov/information-about-brokerage-services-form),
[TREC, Are You Using the Right IABS Form?](https://www.trec.texas.gov/article/are-you-using-right-iabs-form)

The site has been serving a superseded required disclosure for over eight months.

**Problem B: the broker line on the PDF reads "Keller Willis San Antonio Inc."**

**Per the brief, this is flagged, not resolved.** Heath must verify the correct broker
entity name and the correct prefilled IABS content **with his brokerage**, and use the
version his broker provides.

What can be stated as verified fact, so the verification call is a short one:
TREC's public licence record, re-checked independently on 2026-09-17, lists
**"Keller Willis San Antonio Inc", License #547594-BB, Corp Broker, Active**, designated
broker **Joseph H Sloan III (#526284)**, office 15510 Vance Jackson Rd Ste 101, San Antonio
TX 78249, phone (210) 696-9996, with **"Keller Williams Realty City View"** and
**"Kw Cityview"** as registered assumed names.
— [TREC licence search, detail_id 547594-BB](https://www.trec.texas.gov/license-search/?detail_id=547594-BB)

Note also that the site's own prior audit notes contain an internal contradiction on this
point — one paragraph records the spelling as verified-correct against TREC, a later
paragraph calls it a zipForm misspelling to be fixed. **That contradiction is exactly why
this routes to the brokerage rather than to an agent.** Do not edit any TREC form, zipForm
profile, or site footer based on either reading until the brokerage confirms.

**Action:** Heath asks the KW City View market centre / Joe Sloan for the current,
correctly prefilled IABS 1-2 PDF and replaces the 2015 file. Also confirm whether the
"TREC Disclaimer" JPG in the footer (item 16) should come down.
**Blocks:** items 7 and 16. **Effort for Heath:** one call.

### 4.2 One phone number, everywhere

Three numbers are in circulation across his public surfaces:

| Surface | Number |
|---|---|
| Website footer `tel:` | 830-446-3847 |
| Google Business Profile (keeper) | (808) 392-3032 |
| MLS listing contact | (808) 392-3032 |
| IABS PDF | (808) 392-3032 |
| GBP duplicate profile | 830-446-3847 |

830-446-3847 is his Google Voice line, which per memory is designated for his
**non-realtor** ventures. NAP consistency — identical name, address and phone across the
site, GBP, and every directory — is a primary local-pack ranking input, and right now the
site and the GBP disagree.

**Action:** Heath picks one number for all real-estate surfaces. Everything else follows
in about 30 minutes of edits.
**Blocks:** items 5, 7, 10.

### 4.3 Which office address to publish

`LocalBusiness` schema needs a `PostalAddress` (SCHEMA-TEMPLATES.md §2), and it must match
GBP. TREC lists the broker entity at 15510 Vance Jackson Rd Ste 101, San Antonio TX 78249.
Heath works out of KW City View **and** KW Boerne, and his GBP is configured as a
service-area business covering Boerne.

**Action:** Heath confirms which office address to publish, and whether GBP stays
service-area or gains a street address. Publishing an address he does not sit at creates a
GBP verification problem.
**Blocks:** item 7.

### 4.4 Trust signals — the content only he has

Item 11 cannot be written by an agent. It needs from Heath:

- Permission to reproduce the two existing Google reviews on the site, **from the
  reviewers** (Sebastian Linke, Ryan Castro). Reproducing review text without permission is
  a real exposure, and reviews reproduced on his own site are ineligible for Google stars
  regardless (SCHEMA-TEMPLATES.md §8).
- Any figure he is willing to stand behind: transactions closed, years licensed, average
  days on market, list-to-sale ratio. **Only figures he can substantiate.** The August
  audit removed a "$10 million in annual sales" claim from this site once already.
- Any KW awards or designations.
- **The review drive itself.** Ten past clients, ten texts with the tested review link.
  This is the highest-ROI four hours available on this entire project.

### 4.5 TREC team-name registration — a sitewide dependency

Per `wix-realtor-site-audit`, Joe Sloan is registering the team name with TREC (confirmed
2026-09-06). Until it lands, four names remain in circulation: the domain name, the GBP
name, "Shepard Real Estate Solutions" on `/investors`, and the interim compliant string.

**Action:** Heath confirms registration status before the content build's first batch
publishes. If it has landed, the registered name goes into the footer and schema `name`
once. If not, the interim string goes in, and the architecture keeps the name in exactly
two places so the later swap is a two-field edit, not an 800-page edit
(ARCHITECTURE.md §12.2).
**Blocks:** nothing hard, but it determines whether a sitewide rename happens now or later.

### 4.6 SABOR IDX — the broker has to sign

SABOR issues IDX feeds to **Designated REALTORS**, not to agents. The agreement requires
the designated broker's signature with the agent co-signing. **No IDX vendor can be turned
on until Joe Sloan signs.** Published agent-share fee is ~$10/month; SABOR's own IDX page
returned a 404 today, so confirm by phone rather than budgeting off a vendor's table.

**Action:** Heath calls SABOR and asks Sloan, before any IDX subscription is purchased.
Also ask whether SABOR's frameable search link is available to him, which is what makes
the free Stage-0 fix work. Full detail in IDX-RECOMMENDATION.md §3.
**Blocks:** the paid IDX stage. Does **not** block item 1 — `/search` ships regardless.

### 4.7 Google Business Profile duplicate

The duplicate profile (`Heath Shepard Real Estate Team`, CID `9838780354151239035`,
0 reviews, wrong phone) is still live and owned by a different Google account
(`heath.shepard@kw.com`) than the keeper (`heath.shepard@gmail.com`). Duplicate listings
split local signals and can suppress the keeper. The keeper's website field also points at
`shepardrealestatesolutions.com`, which 301-redirects — costing a hop on the single most
valuable local link he has.

**Action:** Heath clicks "Remove profile content and managers" on the duplicate, then
follows up with *Suggest an edit → Close or remove → duplicate* on whatever pin survives.
Separately, repoint the keeper's website field at the canonical domain directly.
**Do not** click "Connect to Existing Profile" in Wix — that is what recreated the
duplicate.

### 4.8 Wix plan decision

Forms are at **5 of 4, limit reached** on the Light plan. That blocks adding a
home-valuation or seller-capture form. Everything else this plan needs — CMS collections,
dynamic pages, structured data, custom code, robots.txt editing — is available on Light.

Also unconfirmed: whether Wix's 2026 GEO features (AI Visibility Overview, NLWeb, AI Bot
Log Reports) appear in this site's dashboard. Several are documented against Wix Studio,
and this site is **Wix Classic** (verified from the served bundle today). `llms.txt` is
currently premium-eCommerce-only and is therefore unavailable here.

**Action:** Heath decides whether the lead-capture form is worth an upgrade, and checks
which GEO tools are actually present in his dashboard.
**Blocks:** a valuation-form lead magnet. Blocks nothing in the content build.
</content>
