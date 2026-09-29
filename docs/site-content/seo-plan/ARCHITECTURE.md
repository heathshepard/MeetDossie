# Information Architecture — theheathshepardrealestateteam.com

Target: 12 pages today to 300-800 pages. Platform: Wix.
Written 2026-09-17. Every Wix constraint below was verified against Wix's own
documentation or against the live site, and is cited.

---

## 0. Verified baseline (live HTML pulled 2026-09-17)

Facts established by fetching the real site today, not from the prior audit:

| Item | Verified state |
|---|---|
| Editor | **Wix Classic Editor**, not Studio. `"isResponsive":false`, `bootstrap-classic.css` in the served bundle. This matters: Classic keeps a **separate mobile design** for every page, so each dynamic template must be laid out twice. |
| Plan | Light (per `wix-realtor-site-audit` memory, 2026-08-30). Not re-verified today — dashboard-only. |
| Pages in sitemap | 12: `/`, `/about`, `/blog`, `/boerne`, `/book-online`, `/buyers`, `/buyers-guide`, `/investors`, `/meet-the-team`, `/sellers`, `/sellers-guide`, `/services`. All `lastmod 2026-09-08`. |
| Blog posts | **Zero.** `sitemap.xml` is an index pointing at exactly one child, `pages-sitemap.xml`. There is no `blog-posts-sitemap.xml`, which is what Wix emits once a blog has published posts. `/blog` is an empty shell. |
| Structured data | **Already present, contrary to the August audit.** Two JSON-LD blocks on the homepage: a hand-written `["RealEstateAgent","LocalBusiness"]` with `@id` `#agent`, and a bare `WebSite`. See SCHEMA-TEMPLATES.md for what is missing from them. |
| `/boerne` | Title tag `Buying a Home in Boerne, TX | Heath Shepard, Keller Williams Realty City View`. **Zero `<h1>`.** One JSON-LD block. This is the most commercially valuable URL on the domain and it is empty. |
| Homepage H1 | `Welcome to the heath shepard real estate team` — lowercased, zero keywords. |
| robots.txt | Wix default. `Allow: /`, `Disallow: *?lightbox=`, PetalBot blocked, crawl-delay on dotbot/AhrefsBot. No AI-crawler directives, no `llms.txt`. |
| Search leak | `heathshepard.kw.com/search/sale?viewport=29.90,-98.28,29.30,-98.85` — two links (nav + hero). Viewport is now correctly San Antonio/Boerne (the Austin-coordinates bug from the August audit is fixed). The leak itself remains. |
| Phone | `tel:+1-830-446-3847` present, one instance, footer only. |

**Two findings not in the original brief, both structural:**

1. **The nav has four duplicate labels and one dead link.** `For Buyers` appears twice
   (to `/buyers` and `/buyers-guide`), `For Sellers` appears twice (to `/sellers` and
   `/sellers-guide`), and `Contact` links to `/` — there is no contact page. Duplicate
   anchor text to two different URLs is the classic keyword-cannibalization setup, and
   it is being done from the sitewide navigation, which is the highest-weight internal
   link source on the site.
2. **The primary hero CTA is a `mailto:`** (`mailto:heath.shepard@kw.com?subject=Website%20Inquiry`).
   `/book-online` exists but is not the hero CTA. A `mailto:` CTA is untrackable, fires
   a desktop mail client that most visitors do not have configured, and cannot be
   measured in GA4 or Search Console.

---

## 1. Wix constraints that shape this design

Each of these is a real limit found in Wix's documentation. They are the reason the
architecture below looks the way it does.

### C1 — Hard page cap: 100 static, 298 total

> "Wix sites can include up to 100 static pages" … "Your site can have up to 298 pages
> total—including static, dynamic, and app pages" … "only the main pages count toward
> your quota, not the number of items or their URLs."
> — [CMS: Scale Efficiently with Dynamic Pages](https://support.wix.com/en/article/cms-creating-unlimited-site-pages-with-a-dynamic-page)

**Consequence, and it is the single most important one: 300-800 pages cannot be built
as Wix pages.** They must be CMS collection items rendered through a small number of
dynamic page templates. A dynamic template costs one page against the 298 cap no matter
whether it renders 3 items or 3,000. Any plan that involves an agent hand-creating
neighborhood pages in the editor dies at page 100.

### C2 — CMS item ceiling is plan-gated

Light 1,500 items / Core 4,000 / Business 20,000 / Business Elite 10,000,000, with
10 GB database storage on Light-through-Business and 512 KB per individual item.
— [CMS: Understanding Collection Storage Limits and Quotas](https://support.wix.com/en/article/cms-understanding-collection-storage-limits-and-quotas)

800 pages against a 1,500-item Light ceiling fits, with room. A 2,000-word guide is
roughly 12 KB, far under the 512 KB per-item cap. **No plan upgrade is required for the
content build.** (A separate upgrade may be required for lead forms — see C8.)

### C3 — Dynamic URL uniqueness rule constrains the URL tree

> "the URL slug structure cannot have the same prefix and the same number of variables
> as another page on your site, even if the variables are different."
> — [CMS: Creating Unique Dynamic Page URLs](https://support.wix.com/en/article/cms-creating-unique-dynamic-page-urls)

This kills two things people normally reach for:

- **Wix dynamic category pages are unusable here.** A category page at
  `/neighborhoods/{category}` is one prefix + one variable; the item page at
  `/neighborhoods/{slug}` is the same prefix + the same variable count. They collide.
  Facet/category browsing must therefore be done with on-page filtering (no new URL) or
  as ordinary items in a collection.
- **Two collections cannot share a prefix.** Guides and neighborhoods must sit under
  different first segments.

### C4 — Structured data: JSON-LD only, 7,000 chars, 5 markups per page

> "Structured Data must be less than 7,000 characters to be added." … "You can add up to
> five markups per page." … "Wix only accepts structured data using JSON-LD markups."
> — [Adding Structured Data Markup to Your Site's Pages](https://support.wix.com/en/article/adding-structured-data-markup-to-your-sites-pages-2546962)

7,000 characters is generous for everything in SCHEMA-TEMPLATES.md **except** a
`FAQPage` with many long answers. Budget for it: a 12-question FAQ with 60-word answers
runs roughly 5,500 characters once escaped. Keep FAQ blocks to 8 questions maximum on
hub pages.

### C5 — Structured data and meta tags are set per *page type*, with CMS variables

> "You can add default dynamic item page variables and variables for any collection field
> you've connected to your dynamic item page … You can also use variables in your
> structured data markup in your SEO Settings."
> — [Using Variables in SEO Settings](https://support.wix.com/en/article/using-variables-in-seo-settings)
> and [CMS: Working with SEO Settings for Dynamic Pages](https://support.wix.com/en/article/working-with-seo-settings-for-dynamic-pages)

This is the leverage point of the entire build. One JSON-LD template written once against
the Neighborhoods item page produces correct, unique `Place` markup on all 40 neighborhood
pages. Same for title tags, meta descriptions and `og:` tags. **Every field a content
agent wants to appear in a title tag or in schema must exist as a named collection
field.** That is why §3 below specifies the field lists precisely.

Documented limitation: the URL slug structure **cannot** be changed from the SEO
dashboard — only from the page's SEO tab inside the editor.

### C6 — Breadcrumbs are not reliably available

The Classic Editor breadcrumbs element "is not yet available to all users" and requires
Dev Mode (Velo) to be enabled.
— [Wix Editor: Adding and Setting Up Breadcrumbs](https://support.wix.com/en/article/wix-editor-adding-and-setting-up-breadcrumbs)

In the Studio Editor it is worse: "it is not possible to add breadcrumbs to a dynamic
page," and the native Breadcrumbs component has a Q2 2026 ETA for Wix Harmony.
— [Studio Editor: Adding and Customizing Breadcrumbs](https://support.wix.com/en/article/studio-editor-adding-and-customizing-breadcrumbs)

**Do not plan around the native element.** Build the visible breadcrumb as three
text/link elements in the dynamic template's design, bound to collection fields, and
emit `BreadcrumbList` JSON-LD separately via C5. See §5.

### C7 — Sitemap is auto-generated and not editable; robots.txt is editable

Wix generates and maintains `sitemap.xml` automatically and it is not directly editable.
robots.txt **is** editable at SEO & GEO → Tools and settings → Robots.txt Editor.
— [Understanding Your Site's Sitemap File](https://support.wix.com/en/article/understanding-your-sites-sitemap-file),
[Editing Your Site's Robots.txt File](https://support.wix.com/en/article/editing-your-sites-robotstxt-file)

Consequence: indexation control at scale is done with the per-page-type "allow search
engines to index this page" toggle and the `robots` meta tag in SEO Settings, plus
robots.txt for crawler-level blocks. There is no way to hand-curate which URLs appear in
the sitemap.

### C8 — Forms are capped, and the cap is already hit

The August 2026 dashboard audit recorded forms at **5 of 4, limit reached** on the Light
plan. That is the only verified plan gate on this project. It blocks adding a home-valuation
or seller-lead form without an upgrade. Everything in this architecture — CMS collections,
dynamic pages, structured data, custom code, robots.txt — is available on Light.

### C9 — Wix has no native IDX

> "Currently, Wix does not support Internet Data Exchange (IDX) integration for real
> estate agents."
> — [Request: IDX (MLS) Integration](https://support.wix.com/en/article/request-idx-mls-integration)

Covered in IDX-RECOMMENDATION.md. The architectural point: **do not design the URL tree
around listing pages.** Whatever IDX vendor is chosen controls those URLs, and on Wix
that content is either vendor-rendered or iframed. The SEO structure below must stand on
its own without a single listing URL.

### C10 — Classic Editor means two layouts per template

Wix Classic maintains a separate mobile design per page. Every dynamic template built
below has to be laid out on desktop **and** mobile. The August audit found the mobile
homepage hero rendering white text directly on a photo. Budget the mobile pass into
every template, not as a cleanup phase.

---

## 2. URL structure

Three collections, three dynamic item templates, three dynamic list pages. Six pages
against the 298 cap. Everything else is collection items.

```
/                                   static   homepage
/boerne                             dynamic LIST   (BoerneGuides)   cornerstone hub
/boerne/{slug}                      dynamic ITEM   (BoerneGuides)   8-12 cornerstones + facets
/neighborhoods                      dynamic LIST   (Neighborhoods)  index
/neighborhoods/{slug}               dynamic ITEM   (Neighborhoods)  25-40 subdivisions
/answers                            dynamic LIST   (Answers)        index
/answers/{slug}                     dynamic ITEM   (Answers)        40-60 AEO pages
/buyers  /sellers  /investors       static   existing service pages, rewritten
/buyers-guide  /sellers-guide       static   existing, re-labelled in nav
/about  /meet-the-team              static
/contact                            static   NEW — see FIX-PRIORITY.md
/search                             static   NEW — IDX destination, stops the leak
/blog                               Wix Blog app
```

**Uniqueness check against C3:** prefixes `boerne`, `neighborhoods`, `answers` are
distinct; each item template uses exactly one variable. No collision. This is Wix's
native list-at-prefix / item-at-prefix-slug pattern, so it needs no workaround.

**Slug rules, binding on all three content agents:**

- Lowercase, hyphen-separated, ASCII only. No dates, no years, no stop words.
- Neighborhoods: the subdivision name as a buyer would type it —
  `cordillera-ranch`, `tapatio-springs`, `esperanza`, `menger-springs`. Not
  `cordillera-ranch-boerne-tx-homes-for-sale`.
- Answers: the question compressed to 4-7 words —
  `how-much-are-property-taxes-in-boerne`, `is-boerne-a-good-place-to-retire`.
  Not `boerne-property-taxes-guide-2026`. The slug should read as the question.
- Guides: the topic, not the format —
  `cost-of-living`, `schools`, `property-taxes`, `hoa-fees`, `new-construction`.
  Under the `/boerne/` prefix these already read as `/boerne/schools`.
- **Slugs are permanent.** Wix's redirect handling on a changed dynamic slug is manual.
  Every agent treats the slug as a committed decision at the moment the row is written.

**Why `/boerne` and not `/boerne-tx-real-estate`:** the prefix is inherited by 12 child
URLs. `/boerne/schools` is a stronger, more clickable, more citable URL than
`/boerne-tx-real-estate/schools-in-boerne-tx`. Keyword-stuffed paths stopped helping
years ago and they measurably hurt click-through in AI-assistant citations, where the
URL is often the only thing displayed alongside the snippet.

**Existing `/boerne` static page:** delete it and let the dynamic list page take the URL.
It has no H1 and one word of body content, so nothing is lost. If the editor refuses the
URL because the static page reserved it, rename the static page's slug to
`/boerne-old`, publish, create the dynamic list page at `/boerne`, then delete
`/boerne-old`. Do not leave both live.

---

## 3. Collection schemas — the contract for the three content agents

This section is the handoff. An agent that produces content matching these field names
can have it imported to Wix as CSV with no rework. An agent that produces prose without
these fields produces pages that cannot have unique title tags or schema, because of C5.

### Collection: `BoerneGuides` (8-12 items, growing)

| Field (exact name) | Type | Required | Used by |
|---|---|---|---|
| `title` | Text | yes | H1, schema `headline` |
| `slug` | Text | yes | URL |
| `metaTitle` | Text (≤60 char) | yes | title tag |
| `metaDescription` | Text (≤155 char) | yes | meta description |
| `summary` | Text (40-60 words) | yes | AEO answer block, schema `description`, index card |
| `body` | Rich text | yes | page body |
| `heroImage` | Image | yes | `og:image`, schema `image` |
| `heroImageAlt` | Text | yes | alt attribute |
| `datePublished` | Date | yes | schema |
| `dateModified` | Date | yes | schema |
| `pageType` | Text (`guide` \| `facet`) | yes | template branching |
| `faqJson` | Text | no | FAQPage block, ≤8 Q&A |
| `relatedNeighborhoods` | Multi-reference → Neighborhoods | yes, 3-6 | internal links |
| `relatedAnswers` | Multi-reference → Answers | yes, 3-5 | internal links |
| `wordCount` | Number | yes | quality gate |
| `status` | Text (`draft` \| `live`) | yes | dataset filter |

### Collection: `Neighborhoods` (25-40 items)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | Text | yes | e.g. `Cordillera Ranch` |
| `slug` | Text | yes | |
| `metaTitle` / `metaDescription` | Text | yes | |
| `summary` | Text (40-60 words) | yes | first paragraph on page, verbatim |
| `body` | Rich text | yes | 600-900 words |
| `city` | Text | yes | `Boerne` / `Fair Oaks Ranch` / `Comfort` |
| `county` | Text | yes | `Kendall` / `Bexar` |
| `latitude` / `longitude` | Number | yes | schema `geo`. Centroid, 5 decimals. |
| `zipCodes` | Tags | yes | |
| `schoolDistrict` | Text | yes | |
| `elementarySchool`, `middleSchool`, `highSchool` | Text | yes | |
| `hoaFeeAnnual` | Number | no | leave null if none — do not write 0 |
| `hoaNotes` | Text | no | |
| `priceRangeLow` / `priceRangeHigh` | Number | yes | |
| `priceAsOf` | Date | yes | **mandatory** — every price fact on the page must carry its date |
| `lotSizeTypical` | Text | no | |
| `yearBuiltRange` | Text | no | |
| `amenities` | Tags | no | `golf`, `gated`, `pool`, `river-access`, `acreage` |
| `heroImage` / `heroImageAlt` | Image / Text | yes | |
| `nearbyNeighborhoods` | Multi-reference → Neighborhoods | yes, 3-5 | **editorially chosen, not random** |
| `relatedAnswers` | Multi-reference → Answers | yes, 2-3 | |
| `parentGuide` | Reference → BoerneGuides | yes | breadcrumb + up-link |
| `status` | Text | yes | |

Hard rule for the neighborhoods agent: a row is `draft` until every `yes` field is
populated with a fact that has a source. A neighborhood page with an invented HOA fee is
worse than no page, because it is a factual claim published by a licensed agent.

### Collection: `Answers` (40-60 items)

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | Text | yes | the literal question, ending in `?`. H1. |
| `slug` | Text | yes | |
| `metaTitle` / `metaDescription` | Text | yes | |
| `shortAnswer` | Text, **40-60 words** | yes | the extractable answer. See §8. |
| `body` | Rich text, 300-500 words | yes | the supporting detail |
| `datePublished` / `dateModified` | Date | yes | |
| `parentGuide` | Reference → BoerneGuides | yes | breadcrumb + up-link |
| `siblingAnswers` | Multi-reference → Answers | yes, 2-3 | |
| `sourceNote` | Text | yes | where the fact came from; rendered visibly on page |
| `status` | Text | yes | |

---

## 4. Hub-and-spoke internal linking model

Three tiers. Maximum click depth from the homepage is 3.

```
homepage
  |
  +-- /boerne  (hub)                         <- linked from global nav + homepage hero band
  |     |
  |     +-- /boerne/{guide}  x12  (spokes)   <- linked from hub index + from each other
  |     |      |
  |     |      +-- /answers/{a}  (leaves)    <- linked from parent guide
  |     |
  |     +-- /neighborhoods (index)
  |            |
  |            +-- /neighborhoods/{n}  x40
  |
  +-- /buyers  /sellers  /investors          <- conversion pages, receive links from everything
```

**Link obligations, per page type.** These are not suggestions; they are the difference
between 800 indexed pages and 800 orphans.

| Page type | Must link UP | Must link ACROSS | Must link DOWN | Must link to CONVERT |
|---|---|---|---|---|
| `/boerne` hub | homepage | — | all 12 guides, top 12 neighborhoods, 8 answers | 1 primary CTA |
| Guide | `/boerne` | 2 sibling guides | its `relatedNeighborhoods` (3-6) and `relatedAnswers` (3-5) | 1 CTA matched to intent |
| Neighborhood | `parentGuide` then `/neighborhoods` | `nearbyNeighborhoods` (3-5) | its `relatedAnswers` (2-3) | 1 CTA |
| Answer | `parentGuide` | `siblingAnswers` (2-3) | — | 1 CTA |

Every one of these links comes from a reference field, rendered through a repeater in the
template. That means the linking is **editorial and stored as data**, not hand-placed in
rich text. Two direct benefits: it is auditable with a CMS query, and it survives a
template redesign.

**The rule that prevents the classic programmatic-SEO failure:** reciprocal links only
where the relationship is real. `nearbyNeighborhoods` must be geographically or
price-band adjacent. If Cordillera Ranch and Menger Springs link to each other it should
be because a buyer comparing one genuinely considers the other. Forty neighborhood pages
each linking to a random five reads to a crawler exactly like what it is — a generated
link graph — and it is the most common reason these builds get classified as thin.

**Orphan check, run before every publish batch:** every `live` item must appear in at
least one other item's reference field, or on the hub's curated list. A CMS item reachable
only from its own index page is one link deep from a page that is itself two deep, and at
10 visits a month this site has no crawl budget to spare.

**Anchor text:** use the target's `name`/`question`/`title` field as the anchor. Never
"click here", never the bare URL, and never the same anchor text pointing at two different
URLs — which is precisely the mistake the current nav makes with "For Buyers".

---

## 5. Breadcrumbs

Because of C6, breadcrumbs are built in two independent halves.

**Visible half** — three elements placed in the dynamic template's design, above the H1:

```
Home  >  Boerne  >  Neighborhoods  >  Cordillera Ranch
```

- Segments 1-3 are static text links in the template (identical for every item).
- The final segment is a text element bound to the item's `name` / `title` / `question`
  field, **not** a link (current page).
- On the answers template, segment 3 is bound to `parentGuide.title`, giving
  `Home > Boerne > Property Taxes > How much are property taxes in Boerne?`
- Lay it out on the mobile design too (C10). On mobile, collapse to
  `< Neighborhoods` — a single back-link. Do not wrap a 4-segment trail on a 375px screen.

**Machine half** — a `BreadcrumbList` JSON-LD markup added once per page type via SEO
Settings using CMS variables. Template in SCHEMA-TEMPLATES.md §5.

The two halves must agree. Google treats a `BreadcrumbList` whose items are not present
on the page as a structured-data mismatch, and Wix states the requirement directly:
"Information in your markup must actually appear on the page itself."

---

## 6. Navigation

The nav's job at 800 pages is to distribute authority to the six hub URLs and to stop
the search leak. It is not a directory.

**Header (desktop):**

```
Home | Boerne ▾ | Neighborhoods | Buy | Sell | Invest | Answers | About ▾ | [Search Homes] [830-xxx-xxxx]
```

- `Boerne ▾` dropdown: 6 hand-picked guides + "All Boerne guides →". Wix Classic supports
  dropdown sub-items natively.
- `About ▾`: About, Meet the Team, Contact.
- `[Search Homes]` is a **styled button, visually distinct from the text links**, pointing
  at `/search` on this domain. See IDX-RECOMMENDATION.md.
- The phone number sits in the header as a `tel:` link on every page, desktop and mobile.
  It is currently footer-only, one instance.
- **Each label appears exactly once.** `/buyers-guide` becomes "Buyer's Guide" nested under
  `Buy`, not a second top-level "For Buyers". Same on the sell side.
- `Contact` points at a real `/contact` page, not at `/`.

**Header (mobile, separate design under C10):** hamburger, plus two always-visible
elements pinned to the header bar: a tap-to-call phone icon and the Search Homes button.
Everything else goes inside the drawer. The August audit found floating widgets covering
the contact form's name fields on mobile — check that the pinned elements do not repeat
that.

**Footer, on every page:**

- NAP block: name, brokerage DBA, office address, one phone number, one email.
  This must match Google Business Profile character for character. Today it does not —
  see FIX-PRIORITY.md.
- TREC broker name and license, Heath's license number, IABS link, Consumer Protection
  Notice link.
- **Social icons** — currently these appear only on `/about` and `/investors`. Footer is
  where they belong, because `sameAs` entity consolidation works best when the links are
  sitewide.
- Three link columns: top 6 neighborhoods, top 6 answers, the 4 service pages.
- Google review link.

**What does not go in navigation:** all 40 neighborhoods, all 60 answers. Sitewide links
to 100 URLs flatten the link graph and tell a crawler that every page is equally
important, which is the same as telling it none of them are.

---

## 7. Sitemap and indexation control

Wix's sitemap is automatic and not editable (C7), so control is exercised upstream.

1. **Dataset filter.** Every dynamic page's dataset filters on `status = "live"`. A
   `draft` item has no URL, so it cannot enter the sitemap. This is the primary gate and
   it is the reason `status` is a required field in all three collections.
2. **Per-page-type noindex.** SEO Dashboard → Edit by page type → the "Let search engines
   index this page" toggle, plus a `robots` meta tag. Use for the `/answers` index page
   if it ever becomes a bare link list.
3. **robots.txt.** Available at SEO & GEO → Robots.txt Editor. Two changes to the default:
   add an explicit `Allow` group for AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
   Google-Extended) so the position is deliberate rather than inherited, and remove the
   `Crawl-delay: 10` on AhrefsBot if Heath ever wants third-party backlink data.
4. **Submission.** SEO Dashboard → "Submit your sitemap and URLs directly to search
   engines", which routes through IndexNow to Bing — and Bing's index is what ChatGPT
   reads from. On a site with 10 monthly visits, the IndexNow path will surface new URLs
   to AI assistants faster than Googlebot will discover them.
   — [Submitting Your Sitemap and URLs Directly to Search Engines](https://support.wix.com/en/article/submitting-your-sitemap-and-urls-directly-to-search-engines)
5. **Search Console.** The prior audit found the Wix↔Google data connection dropped
   ("verified, but Wix lost connection"). Re-auth before the first batch publishes,
   otherwise there is no coverage data for the entire ramp.

---

## 8. AEO / GEO layer

Wix shipped a genuine set of AI-search features in 2026 and they are worth using, with
one caveat.

- **AI Visibility Overview** — tracks appearance in ChatGPT, Gemini, Perplexity and
  Claude answers, with question-level performance and competitor visibility. Launched
  2026-07-16.
  — [Wix press release](https://www.wix.com/press-room/home/post/wix-launches-ai-visibility-overview-with-full-generative-engine-optimization-support-for-ai-powered)
- **AI Bot Log Reports** — which AI crawlers hit the site and how often.
- **NLWeb** — enable from the SEO & GEO dashboard, no code; makes structured content
  queryable in natural language.
- **llms.txt** — auto-generated at `/llms.txt`. **Caveat: currently premium eCommerce
  plans only, with broader rollout stated but not dated.** This site is on Light and is
  not an eCommerce plan, so treat llms.txt as unavailable today and re-check.
  — [Wix GEO features](https://www.wix.com/studio/ai-search-lab/wix-geo-features)

Several of these are documented against Wix Studio. This site is Classic (see §0).
**Verify each one is present in this site's dashboard before planning work around it.**

The part that does not depend on any Wix feature, and matters more than all of them:

**Every answer page opens with `shortAnswer` — 40-60 words, no preamble, directly
answering the question, stated as fact with a number and a date where one exists.** Then
the H1 question, then the supporting body. That block is what an LLM extracts and cites.
"Boerne is a wonderful Hill Country town with a lot to offer buyers" is not extractable.
"Boerne property taxes run roughly 1.8% to 2.1% of assessed value, depending on which of
the four overlapping taxing districts a home sits in. On a $600,000 home that is about
$10,800 to $12,600 a year. Rates set October 2025 for the 2026 tax year." is.

Same discipline on neighborhood pages: `summary` is the first thing on the page, verbatim
from the field, and it names the school district, the price band and the `priceAsOf` date.

**FAQ markup, stated honestly:** Google fully retired FAQ rich results on 2026-05-07,
after restricting them to government and health sites in August 2023. Search Console's
FAQ reporting was removed in June 2026.
— [Google Search Central, HowTo and FAQ changes](https://developers.google.com/search/blog/2023/08/howto-faq-changes),
[Search Engine Journal](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/)
`FAQPage` is still a valid type and Google still parses it to understand the page, and
LLMs read it. Keep it, keep it small, and spend zero effort optimizing for a rich result
that no longer exists. The on-page `H2 question → 40-60 word answer` structure is doing
the actual work.

---

## 9. Quality gates — enforced before `status` flips to `live`

At 10 visits a month this domain has no authority buffer. Publishing 800 pages of
near-duplicate text is the fastest way to get the whole domain classified as thin, and
recovery is measured in quarters.

| Gate | Guides | Neighborhoods | Answers |
|---|---|---|---|
| Minimum words | 1,200 | 600 | 300 |
| Maximum words | 2,000 | 900 | 500 |
| Unique facts with a source | 8 | 8 | 3 |
| Template sentences shared with another page | 0 | 0 | 0 |
| Original image | 1 | 1 | optional |
| Internal links out | 8-14 | 6-9 | 3-6 |
| Dated facts carry `priceAsOf` / `sourceNote` | required | required | required |

"Template sentences shared with another page: 0" is the one that will be hardest and
matters most. If 40 neighborhood pages share the sentence "Located just minutes from
downtown Boerne, this community offers residents easy access to shopping and dining,"
that is 40 pages Google will fold into one. Boilerplate belongs in the template's design
(header, footer, CTA), never in the collection's text fields.

---

## 10. Publishing cadence

Do not publish 800 pages in one week from a 12-page domain.

| Phase | Weeks | Publishes | Why |
|---|---|---|---|
| 0 | before anything | The FIX-PRIORITY P0 items | Fix the leak and the H1s first; new pages inherit a broken shell otherwise |
| 1 | 1-2 | `/boerne` hub + 4 cornerstone guides | Establishes the hub and gives the crawler something to follow |
| 2 | 3-5 | 8 remaining guides + 10 neighborhoods | |
| 3 | 6-9 | 15 neighborhoods + 20 answers | |
| 4 | 10-14 | remainder | |

Submit each batch via IndexNow (§7.4). Watch Search Console's Pages report after each
batch: if "Crawled – currently not indexed" climbs past ~25% of a batch, stop and
improve depth before publishing more. That signal arriving early is the whole reason for
phasing.

---

## 11. What breaks at scale, and the mitigation

| Failure | When | Mitigation, already built into the design above |
|---|---|---|
| Page cap hit | page 101 static | Everything past the 14 static pages is a CMS item (§2) |
| Duplicate/thin classification | ~page 60 if templated prose | §9 gates, 0 shared sentences |
| Orphaned items | immediately | Reference fields are required, not optional (§3, §4) |
| Cannibalization | when 3 pages target "Boerne homes for sale" | One commercial-intent page per query; guides are informational; answers are single-question |
| Stale price facts | 6 months | `priceAsOf` on every price; quarterly refresh sweep |
| Slug churn | first redesign | Slugs are committed on write (§2) |
| Mobile layout rot | every new template | C10, mobile pass is part of the template, not a phase |
| llms.txt assumed available | at build time | §8 flags it as plan-gated, unverified on this site |

---

## 12. Open items this architecture depends on

1. **Wix plan confirmation.** Light is asserted from an August dashboard reading, not
   re-verified. If the site is on the free tier, the CMS ceiling drops to 1,000 items,
   which still fits 800 pages but leaves no room.
2. **TREC team-name registration.** Per `wix-realtor-site-audit`, Joe Sloan is registering
   the team name. Until it lands, every new page's title tag, footer and schema `name`
   must use the interim compliant string, and there will be a sitewide swap afterwards.
   Content agents should put the business name in one place (footer + schema) so the swap
   is a two-field edit, not an 800-page edit. **Never hard-code the business name into
   `metaTitle` on collection items.**
3. **`/search` destination.** The nav button needs a target before the nav is rebuilt.
   IDX-RECOMMENDATION.md resolves this.
</content>
