# IDX Recommendation — Wix + SABOR

Written 2026-09-17. Every price and platform claim below is cited.

---

## The recommendation, up front

**Two stages, and the order matters more than the vendor choice.**

**Stage 0 — this week, $0.** Build `/search` on `theheathshepardrealestateteam.com` and
repoint the nav item and hero button at it. The page carries Heath's header, phone, and a
lead form, and embeds a frameable MLS search below the fold. The buyer stays on his
domain. **This closes the leak without buying anything.** Roughly 3 hours of work.

**Stage 1 — once the content build is producing traffic (realistically 60-90 days out).**
Replace the embed with **iHomefinder, "Premium for Agents", $50/month** from the Wix App
Market, on a 30-day trial, gated on one specific verification test described in §5.
**Fallback if it fails that test: IDX Broker Core, $60/month, on `search.` as a
subdomain.**

**The reason for the sequence:** IDX does not make anyone rank. The SABOR feed is the same
data every agent in San Antonio can display, and Zillow, Realtor.com and Homes.com have
spent two decades and hundreds of millions consolidating those queries. Buying IDX for a
domain at 10 visits a month is buying a conversion tool for traffic that does not exist
yet. Its job is to stop the leak and capture the visitor — and the leak can be stopped for
free today.

---

## 1. The constraint that eliminates most vendors

Wix states it plainly:

> "Currently, Wix does not support Internet Data Exchange (IDX) integration for real
> estate agents."
> — [Request: IDX (MLS) Integration](https://support.wix.com/en/article/request-idx-mls-integration)

Wix's own documented workarounds are exactly two: install **iHomefinder** from the App
Market, or build a custom integration against an external server with Velo. Everything
else in the market is a WordPress plugin with an iframe bolted on for Wix.

That matters because of how the iframe route degrades:

> "Iframe integration does not support custom subdomains, and therefore IDX pages cannot
> be indexed by search engines."

And IDX Broker's own Wix support article concedes that "due to how Wix implements code
blocks through iframing, certain advanced functionalities including the Map Search widget
may not operate as intended."
— [Integrating IDX with a WIX Site, IDX Broker](https://support.idxbroker.com/hc/en-us/articles/34490048692891-Integrating-IDX-with-a-WIX-Site)

---

## 2. Vendors evaluated

| Vendor | Works on Wix? | Integration method | Price | Verdict |
|---|---|---|---|---|
| **iHomefinder** | Yes — official Wix App Market app, and the vendor Wix itself names | Vendor claims direct page embedding, no iframe or subdomain | **$50/mo** Premium for Agents (listed as reduced from $85); iHF Max $135/mo; Max for Teams $225/mo; Max Pro $450/mo. 30-day trial. | **Recommended, gated on §5** |
| **IDX Broker** | Yes, via "Embed a site" or a custom subdomain | iframe (not indexable) or subdomain (indexable, but on `search.` not the root) | Core $60/mo agent, Engage $99/mo, Elite $145/mo, all "starting at", plus an undisclosed one-time setup fee | **Fallback** |
| **Showcase IDX** | **No** | WordPress plugin only — the vendor describes itself as "the leading IDX plugin for WordPress websites" and lists no other platform | Essentials $94.95/mo, Premium $124.95/mo | **Eliminated** |
| Add On IDX / IDXCentral / similar copy-paste widget shops | Yes | iframe | varies | **Eliminated** — iframe means no indexing and no real ownership of the experience |
| Realtyna, UltimateIDX, RealtyTech, Web4Realty | SABOR coverage exists | Predominantly WordPress-first; Wix support is iframe or a hosted site | varies | **Eliminated** — no advantage over the two above on Wix |
| Custom Velo build against the SABOR RESO feed | Yes | Native Wix CMS pages, fully indexable | Developer time + SABOR feed | **Eliminated for now** — see §6. It is the only route to genuinely indexable listing pages on the root domain, and it is not worth it at this traffic level |

Sources: [iHomefinder on the Wix App Market](https://www.wix.com/app-market/web-solution/ihomefinder-real-estate) ·
[IDX Broker plans](https://www.idxbroker.com/idx_broker) ·
[Showcase IDX pricing](https://showcaseidx.com/pricing/) ·
[Wix IDX support article](https://support.wix.com/en/article/request-idx-mls-integration)

### A pricing discrepancy worth knowing before the call

iHomefinder's **Wix App Market listing shows $50/month** for "Premium for Agents". Their
**own website's pricing page shows plans starting at $169/month** (Lead Essentials
$169, Lead Maximizer $399 plus a $500 website setup fee, Growth Pro custom), per
[Luxury Presence's 2026 pricing breakdown](https://www.luxurypresence.com/blogs/ihomefinder-pricing/)
and [Capterra](https://www.capterra.com/p/205125/iHomefinder/pricing/). iHomefinder's own
pricing page does not print numbers at all — it says "Plans vary based on what you
actually need" and routes to a phone call.

The $50 App Market tier appears to be the older IDX-only product; the $169+ tiers are the
IDX-plus-CRM repositioning. **Buy through the Wix App Market at $50 and decline the
upsell.** The CRM is not needed — Heath already has KW Command. If the $50 tier has been
retired by the time this is actioned, that changes the arithmetic and IDX Broker at $60
becomes the straightforward pick.

### The rating, stated plainly

The iHomefinder Wix app sits at **2.3 stars across 18 reviews** on the Wix App Market,
with recurring complaints about setup difficulty and apps stuck in demo mode. That is a
genuine risk and it is the reason §5 exists as a gate rather than a formality. It is still
the recommendation, because it is the only vendor with a real Wix App Market presence and
the only one Wix itself names.

---

## 3. SABOR: what it costs and who has to sign

**The fee.** Published figures for SABOR's IDX data feed put the agent's share at
**$10/month**.
— [Showcase IDX SABOR coverage page](https://showcaseidx.com/mls-coverage/san-antonio-board-of-realtors-sabor/)

Treat that as an indication, not a budget line. Published MLS fee tables across vendor
sites conflict routinely, and SABOR's own page
(`sabor.com/For-Members/Multiple-Listing-Service/IDX-Feeds-and-Technical-Services/`)
returned a 404 on fetch today. **Confirm by phone with SABOR before committing.**

**Who owns the feed, and this is the part that gates everything:** IDX feeds at SABOR are
issued to **Designated REALTORS** — the broker, not the agent. The agreement must be
signed by the designated broker of the requesting member, with the requesting agent
co-signing. For Heath that means **Joseph H Sloan III, TREC #526284, designated broker of
Keller Willis San Antonio Inc (#547594-BB)** — independently re-verified against TREC's
public licence record on 2026-09-17.

**Consequence: Heath cannot buy IDX unilaterally.** No vendor can enable a feed until
Sloan signs. Start that conversation before any subscription is purchased, or the first
month is paid for a product that cannot turn on. This is the single most common way agents
waste the first 30-60 days of an IDX purchase.

Two secondary items to raise on the same call:

- **KW brokerage policy.** Some KW market centres restrict third-party IDX in favour of
  KW Command / the `.kw.com` agent site. Ask before spending.
- **SABOR's frameable search link.** SABOR itself offers "embedding a frameable link to
  your website which will allow a search page to appear when potential clients visit your
  page," as well as linking to the public property search at SABOR.com. That frameable
  link is what makes Stage 0 free. Confirm availability and terms on the same call.

---

## 4. Stage 0 in detail — closing the leak for $0

Today, two links send every buyer off-domain on the first click:
the nav item `Search For Properties` and the hero button `Start your search`, both to
`heathshepard.kw.com/search/sale?viewport=29.90,-98.28,29.30,-98.85`. (The viewport is now
correctly centred on San Antonio/Boerne — the Austin-coordinates bug is fixed.)

Build `/search` on his own domain:

1. His header, his nav, his phone as a `tel:` link, his photo.
2. Above the fold: a short value line and a lead form — "Tell me what you're looking for
   and I'll send matching listings before they hit Zillow." Note the form cap in
   ARCHITECTURE.md C9 (forms already at 5/4 on the Light plan) — this may need the
   existing contact form repurposed rather than a new one.
3. Below that: the frameable MLS search, full width, in a Wix HTML iframe element.
4. Below that: links into `/neighborhoods`, the top guides, and `/contact`.

The framed search is not indexable. That is fine and it is not a loss — those listing
pages were never going to rank against Zillow. What changes is that the visitor is on
Heath's domain, looking at his name, with his phone number on screen, and his form above
the search box. Every subsequent click is a click he owns.

**Test before shipping:** some hosts send `X-Frame-Options: DENY`, which blanks the
iframe. If `heathshepard.kw.com` refuses to frame, use SABOR's frameable link (§3). If
neither frames, `/search` still ships as an interstitial — value line, lead form, and an
explicit outbound button — which is strictly better than a bare nav link, because the
visitor sees a capture opportunity first.

---

## 5. Stage 1 gate — the one test that decides iHomefinder vs IDX Broker

iHomefinder's marketing makes a specific, load-bearing claim:

> "No framing or subdomain is required, so your website gets all the SEO benefit of IDX
> content indexed directly on your domain."
> — [iHomefinder, IDX for Wix](https://www.ihomefinder.com/blog/product-news-and-tips/idx-for-wix-real-estate-websites/)

That claim is technically possible on Wix. Wix's app-development docs describe exactly the
mechanism it would require — a dedicated **SEO endpoint** for a widget:

> "If your widget has text or other content that's meaningful for your users' SEO, you
> should develop a dedicated SEO endpoint for your widget component… if there's no content
> in your widget that's meaningful for SEO… Wix will render your widget as an iframe."
> — [Optimize Your App for SEO (iframe), Wix Dev](https://dev.wix.com/docs/build-apps/develop-your-app/frameworks/self-hosting/supported-extensions/deprecated/iframe/optimize-for-seo-iframe)

So it comes down to whether iHomefinder actually built that endpoint. **This is a vendor
claim, not a verified fact, and it should not be taken on trust.** Verify it in the free
trial:

1. Install the app on the trial, publish one IDX listing page.
2. Fetch the live URL server-side with a Googlebot user-agent
   (`curl -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" <url>`).
3. Grep the returned HTML for the listing address, price, and description text.
4. Confirm the URL is on `theheathshepardrealestateteam.com`, not a vendor domain and not
   inside an `<iframe src=...>`.
5. Cross-check with Search Console's URL Inspection → "View crawled page".

**Pass** (listing text present in the served HTML, on the root domain): keep iHomefinder
at $50/mo.
**Fail** (text only appears after JS, or lives inside an iframe): cancel within the
30 days and move to IDX Broker Core at $60/mo on `search.theheathshepardrealestateteam.com`
— a subdomain is indexable, is a property Heath controls, and can be styled to match. It
does not pass authority to the root domain the way a subfolder would, but against an
iframe it is a clear improvement.

Two hours of work, and it decides a recurring bill.

---

## 6. Why not build it properly with Velo

A Velo integration against SABOR's RESO/RETS feed, writing listings into a Wix CMS
collection and rendering them on a dynamic page template, is the only route to listing
pages that are genuinely indexable on the root domain and structured with
`RealEstateListing` schema. It is architecturally the right answer and it is the same
pattern as ARCHITECTURE.md §2.

It is not the answer **now**, for four reasons:

1. **The listing pages still would not rank.** Same syndicated data as 9,000 other SABOR
   members, against portals with two decades of authority.
2. **IDX display rules are contractual.** Refresh frequency, mandatory attribution,
   opt-out handling and takedown compliance are all in the SABOR agreement, and violating
   them is the broker's licence exposure, not a bug report.
3. **Ongoing maintenance.** A feed integration is not a build, it is a subscription of
   developer attention. When SABOR changes a field, listings go stale silently.
4. **It is the wrong hundred hours.** Those hours spent on the 12 cornerstone guides and
   40 neighbourhood pages target queries that Zillow structurally cannot own — "what are
   property taxes in Cordillera Ranch", "is Boerne ISD good", "Boerne vs Fair Oaks Ranch".
   Those are the queries an AI assistant answers by citing somebody, and right now there
   is no reason for it to be him.

Revisit at 1,000+ organic sessions/month, or if he moves off Wix.

---

## 7. Cost summary

| | Monthly | One-time |
|---|---|---|
| Stage 0 (`/search` + frameable embed) | $0 | ~3 hours |
| Stage 1 — recommended: iHomefinder Premium for Agents | $50 | 30-day trial, ~2 hours to verify per §5 |
| Stage 1 — SABOR data feed share (confirm by phone) | ~$10 | broker agreement signature |
| **Stage 1 total** | **~$60/mo** | |
| Fallback: IDX Broker Core on a subdomain | $60 + ~$10 SABOR | undisclosed setup fee — ask before signing |
| Rejected: Showcase IDX | $94.95 | WordPress only |
| Rejected: iHomefinder direct-sale tiers | $169-399 | $500 website setup |

---

## 8. Action order

1. **Heath calls SABOR** — confirm the IDX fee, the Designated REALTOR requirement, and
   whether the frameable search link is available to him. (Heath only.)
2. **Heath asks Joe Sloan** — will he sign a SABOR IDX agreement, and does the market
   centre permit third-party IDX. (Heath only.)
3. **Build `/search`** and repoint nav + hero. Ship this week regardless of 1 and 2.
4. **Content build runs** — 12 guides, 40 neighbourhoods, 60 answers.
5. **At ~500 organic sessions/month**, start the iHomefinder trial and run the §5 test.
6. **Decide** iHomefinder or IDX Broker on the test result, not on marketing copy.
</content>
