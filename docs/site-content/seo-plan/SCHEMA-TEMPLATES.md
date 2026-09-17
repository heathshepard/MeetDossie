# Schema.org / JSON-LD Templates — theheathshepardrealestateteam.com

Paste-ready JSON-LD plus the exact Wix injection path. Written 2026-09-17.

---

## 0. What is already on the site

Pulled from live HTML today. **The August 2026 audit note saying "zero JSON-LD structured
data of any kind" is out of date** — two blocks are live on the homepage:

```
Block 0  ["RealEstateAgent","LocalBusiness"]  @id .../#agent   1,304 chars
Block 1  WebSite                                                 143 chars
```

The existing agent block already has: `name`, `url`, `image`, `telephone`, `email`,
`parentOrganization`, a 14-entry `areaServed`, and a 5-entry `sameAs`.

**What is missing from it, in order of impact:**

1. No `address` / `PostalAddress`. A `LocalBusiness` with no address is the weakest
   possible form of the type.
2. No `@id` cross-references anywhere else on the site — every other page's schema should
   point back at `#agent`, and none does.
3. `sameAs` links to `linkedin.com/in/heath-shepard-b06515267`, which per the
   `heath-google-business-profile` memory (verified 2026-09-10) is an **empty duplicate
   profile**. The live account is `linkedin.com/in/heath-shepard-b8849135`.
4. No Google Business Profile link in `sameAs`. GBP is the single highest-value entity
   link a local business has and it is absent.
5. No YouTube (`youtube.com/@HeathShepardRealtor` exists).
6. No `hasCredential` — his TREC licence number appears nowhere in machine-readable form.
7. No `description`, `logo`, `priceRange`, `geo`, `openingHoursSpecification`,
   `knowsAbout`.
8. `parentOrganization.name` is `Keller Williams Realty City View` — a registered DBA,
   which is correct for advertising, but the schema carries no licence number for it.

`/boerne` carries only one block. Every interior page should carry at minimum
`BreadcrumbList` plus its own primary type.

---

## 1. How to inject JSON-LD in Wix

Two entry points. Use the second one for anything that has to apply to hundreds of pages.

### Path A — one specific page (Wix Classic Editor)

1. Editor → **Pages & Menu**
2. **More Actions** (⋯) next to the page → **SEO Basics**
3. **Advanced SEO** tab → **Structured Data Markup**
4. **+ Add New Markup** → name it → paste JSON-LD → **Apply** → **Publish**

— [Adding Structured Data Markup to Your Site's Pages](https://support.wix.com/en/article/adding-structured-data-markup-to-your-sites-pages-2546962)

### Path B — an entire page type, with CMS variables (the one that scales)

1. Dashboard → **SEO & GEO** → **Tools and settings** → **Go to SEO Settings**
2. **Edit by page type** → select the dynamic item page (e.g. `Neighborhoods (Item)`)
3. **Structured data markup** → **+ Add New Markup**
4. Paste the template
5. Replace each `{{placeholder}}` using the **Add Variable** button — see the warning below
6. **Apply** → **Publish**

— [CMS: Working with SEO Settings for Dynamic Pages](https://support.wix.com/en/article/working-with-seo-settings-for-dynamic-pages),
[Using Variables in SEO Settings](https://support.wix.com/en/article/using-variables-in-seo-settings)

One markup written this way renders unique, correct JSON-LD on all 40 neighborhood pages.

### Hard limits

| Limit | Value | Source |
|---|---|---|
| Format | JSON-LD only. Microdata and RDFa are rejected. | Wix help centre |
| Size | **< 7,000 characters** per markup | Wix help centre |
| Count | **5 markups maximum** per page | Wix help centre |
| Content rule | "Information in your markup must actually appear on the page itself" | Wix help centre, restating Google policy |

The 7,000-character limit only threatens the `FAQPage` template. Eight questions at 60
words each lands near 5,500 characters escaped. Keep FAQ blocks at 8 or fewer.

### The variable warning — read before pasting anything from §4 onward

Every `{{placeholder}}` below is a marker for you, **not literal syntax**. Wix stores
variables as internal field references, not as text tokens. Typing `{{name}}` by hand
produces the literal string `{{name}}` on all 40 pages.

**Delete the `{{placeholder}}` including its quotes where noted, put the cursor in place,
and click "Add Variable", then pick the collection field.** Wix renders it as a chip in
the editor. Verify on one published item before applying to the page type.

Numeric fields (`latitude`, `longitude`, `hoaFeeAnnual`, `priceRangeLow`) are a known
trap: Wix inserts variables as strings. Schema.org accepts string-typed numbers for
`latitude`/`longitude`/`price`, so this is fine — but do not wrap a variable in quotes
*and* expect a JSON number. Leave the quotes on.

### Validation, in this order

1. Paste the rendered output of one live page into
   [validator.schema.org](https://validator.schema.org) — catches syntax and vocabulary errors.
2. Run the same URL through Google's
   [Rich Results Test](https://search.google.com/test/rich-results) — tests the **rendered**
   page, which is what matters on Wix, where Thunderbolt injects markup client-side.
3. Spot-check **three** dynamic items per page type, not one. A variable bound to an empty
   optional field produces `"hoaFeeAnnual": ""`, which validates but is wrong. Pick one
   item with every field filled, one with optional fields empty, and one with an
   apostrophe in the name (e.g. a subdivision with a possessive) to catch escaping.

---

## 2. Template — RealEstateAgent / LocalBusiness (homepage only)

Replaces Block 0. Everything else on the site references its `@id`.

Values marked `CONFIRM` need Heath — see FIX-PRIORITY.md §"Needs Heath personally".

```json
{
  "@context": "https://schema.org",
  "@type": ["RealEstateAgent", "LocalBusiness"],
  "@id": "https://www.theheathshepardrealestateteam.com/#agent",
  "name": "The Heath Shepard Real Estate Team",
  "alternateName": "Heath Shepard | Keller Williams Realty City View",
  "description": "Heath Shepard is a licensed Texas REALTOR with Keller Williams Realty City View, serving Boerne, Fair Oaks Ranch, Comfort and the greater San Antonio area. Buyer and seller representation plus investment property, 1031 exchanges, BRRRR and short-term rentals.",
  "url": "https://www.theheathshepardrealestateteam.com/",
  "image": "https://static.wixstatic.com/media/6bc05f_2bf657ff2b2d4b1aa7c7425b52360964~mv2.jpg",
  "logo": "CONFIRM-LOGO-URL",
  "telephone": "CONFIRM-SINGLE-PHONE",
  "email": "Heath.Shepard@kw.com",
  "priceRange": "$$",
  "currenciesAccepted": "USD",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "CONFIRM-OFFICE-STREET",
    "addressLocality": "CONFIRM-OFFICE-CITY",
    "addressRegion": "TX",
    "postalCode": "CONFIRM-OFFICE-ZIP",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": "CONFIRM-OFFICE-LAT",
    "longitude": "CONFIRM-OFFICE-LNG"
  },
  "hasMap": "https://maps.google.com/?cid=9886943752848649665",
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
      "opens": "08:00",
      "closes": "20:00"
    }
  ],
  "parentOrganization": {
    "@type": "RealEstateAgent",
    "@id": "https://www.theheathshepardrealestateteam.com/#brokerage",
    "name": "Keller Williams Realty City View",
    "legalName": "Keller Willis San Antonio Inc",
    "identifier": {
      "@type": "PropertyValue",
      "propertyID": "TREC Broker License",
      "value": "547594"
    }
  },
  "employee": {
    "@type": "Person",
    "@id": "https://www.theheathshepardrealestateteam.com/#heath",
    "name": "Heath Shepard",
    "jobTitle": "REALTOR, Texas Licensed Real Estate Sales Agent",
    "telephone": "CONFIRM-SINGLE-PHONE",
    "email": "Heath.Shepard@kw.com",
    "worksFor": { "@id": "https://www.theheathshepardrealestateteam.com/#brokerage" },
    "hasCredential": {
      "@type": "EducationalOccupationalCredential",
      "credentialCategory": "Real Estate Sales Agent License",
      "recognizedBy": {
        "@type": "GovernmentOrganization",
        "name": "Texas Real Estate Commission",
        "url": "https://www.trec.texas.gov/"
      },
      "identifier": "751964"
    },
    "knowsAbout": [
      "Boerne Texas real estate",
      "Kendall County property taxes",
      "1031 exchange",
      "short-term rental investment",
      "BRRRR investing",
      "Texas residential contracts"
    ]
  },
  "areaServed": [
    { "@type": "City", "name": "Boerne", "sameAs": "https://en.wikipedia.org/wiki/Boerne,_Texas" },
    { "@type": "City", "name": "Fair Oaks Ranch" },
    { "@type": "City", "name": "Comfort" },
    { "@type": "City", "name": "Bulverde" },
    { "@type": "City", "name": "Spring Branch" },
    { "@type": "City", "name": "Canyon Lake" },
    { "@type": "City", "name": "Helotes" },
    { "@type": "City", "name": "Bandera" },
    { "@type": "City", "name": "Pipe Creek" },
    { "@type": "City", "name": "Kerrville" },
    { "@type": "City", "name": "New Braunfels" },
    { "@type": "City", "name": "San Antonio", "sameAs": "https://en.wikipedia.org/wiki/San_Antonio" },
    { "@type": "Place", "name": "Stone Oak, San Antonio, TX" },
    { "@type": "Place", "name": "Alamo Heights, TX" }
  ],
  "sameAs": [
    "https://maps.google.com/?cid=9886943752848649665",
    "https://www.zillow.com/profile/HeathShepard",
    "https://www.facebook.com/HeathShepardRealtor",
    "https://www.instagram.com/heathshepardrealtor/",
    "https://www.youtube.com/@HeathShepardRealtor",
    "https://www.linkedin.com/in/heath-shepard-b8849135",
    "https://x.com/ShepardHea46340"
  ]
}
```

Notes on the deliberate choices:

- **`legalName: "Keller Willis San Antonio Inc"` is not a typo and must not be corrected.**
  Independently re-verified against TREC's public licence record on 2026-09-17: license
  547594-BB, Corp Broker, Active, designated broker Joseph H Sloan III (#526284), office
  15510 Vance Jackson Rd Ste 101, San Antonio TX 78249, phone (210) 696-9996.
  `name` carries the registered DBA `Keller Williams Realty City View`, which is what TREC
  §535.155 requires in advertising. See FIX-PRIORITY.md for the separate IABS issue.
- **`hasMap` and the `sameAs` GBP link** use the CID URL for the *keeper* profile
  (`Shepard Real Estate Team`, CID 9886943752848649665). Do not use the duplicate
  (CID 9838780354151239035).
- **LinkedIn is corrected** to `b8849135`. The URL currently in the live block points at
  an empty duplicate.
- **`name` uses the team name.** Swap this the day the TREC team-name registration lands.
  Because it lives in exactly two places (this block and the footer), that is a two-field
  edit.
- **No `aggregateRating`.** See §8 — adding one now would be a false claim, and would not
  produce stars anyway.

## 2b. Template — WebSite (homepage)

Replaces Block 1. Keep it; `WebSite` still drives the site-name treatment in Google.
**Do not add `potentialAction`/`SearchAction`** — Google retired the sitelinks search box
on 2024-11-21 and removed its reporting.
— [Farewell, Sitelinks Search Box](https://developers.google.com/search/blog/2024/10/sitelinks-search-box)

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": "https://www.theheathshepardrealestateteam.com/#website",
  "name": "The Heath Shepard Real Estate Team",
  "url": "https://www.theheathshepardrealestateteam.com",
  "publisher": { "@id": "https://www.theheathshepardrealestateteam.com/#agent" },
  "inLanguage": "en-US"
}
```

---

## 3. Template — Article (BoerneGuides item page, Path B)

Apply to page type `BoerneGuides (Item)`.

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": "{{Primary page URL}}#article",
  "headline": "{{title}}",
  "description": "{{summary}}",
  "image": "{{heroImage}}",
  "datePublished": "{{datePublished}}",
  "dateModified": "{{dateModified}}",
  "wordCount": "{{wordCount}}",
  "inLanguage": "en-US",
  "mainEntityOfPage": { "@type": "WebPage", "@id": "{{Primary page URL}}" },
  "isPartOf": { "@id": "https://www.theheathshepardrealestateteam.com/#website" },
  "author": { "@id": "https://www.theheathshepardrealestateteam.com/#heath" },
  "publisher": { "@id": "https://www.theheathshepardrealestateteam.com/#agent" },
  "about": {
    "@type": "City",
    "name": "Boerne",
    "sameAs": "https://en.wikipedia.org/wiki/Boerne,_Texas"
  },
  "spatialCoverage": {
    "@type": "AdministrativeArea",
    "name": "Kendall County, Texas"
  }
}
```

- `headline` has a documented 110-character soft ceiling in Google's Article guidance.
  Enforce it on the `title` field at write time, not here.
- `author` points at the `#heath` Person node defined in §2. Do not redefine the Person
  inline on every page — pointing at one `@id` is what builds a single entity rather than
  800 loosely-related ones. This is the highest-leverage detail in the whole schema plan.
- `Article` is deliberate over `BlogPosting`. These are evergreen reference pages, not
  dated posts.

---

## 4. Template — FAQPage

Two placements, two forms.

### 4a. On a hub or guide page that has a visible FAQ section (Path A or B)

Only add this where the questions and answers are genuinely rendered on the page.

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": "{{Primary page URL}}#faq",
  "isPartOf": { "@id": "{{Primary page URL}}" },
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How much are property taxes in Boerne, TX?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Boerne property tax rates depend on which overlapping taxing units a home falls under. Replace this with the real combined rate and the tax year it was set, and state the dollar figure on a representative home price."
      }
    },
    {
      "@type": "Question",
      "name": "Is Boerne part of San Antonio?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Boerne is its own city in Kendall County, about 30 miles northwest of downtown San Antonio. Replace with the verified drive time and the school district distinction."
      }
    }
  ]
}
```

**Eight questions maximum** (the 7,000-character limit, §1).

### 4b. On an Answers item page (Path B, page type `Answers (Item)`)

A single-question page. Ship `Article` (as §3, with `headline` bound to `question`) as the
primary markup and add this second markup beneath it:

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": "{{Primary page URL}}#faq",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "{{question}}",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{{shortAnswer}}",
        "url": "{{Primary page URL}}"
      }
    }
  ]
}
```

`QAPage` is the other candidate here. It is not the right type: `QAPage` models a
user-submitted question with competing community answers, which is not what this is.
`FAQPage` with one entry is the honest fit.

**State of play on FAQ markup, so nobody over-invests:** Google fully retired FAQ rich
results on **2026-05-07**, after restricting them to authoritative government and health
sites in August 2023. Search Console's FAQ appearance filter and rich-result report were
removed in June 2026.
— [Google Search Central](https://developers.google.com/search/blog/2023/08/howto-faq-changes),
[Search Engine Journal](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/)

The markup is still valid, still parsed for page understanding, and still read by LLMs.
Keep it because it is cheap. Do not spend an hour tuning it. The `H2 question → 40-60 word
answer` structure on the page itself is what earns the AI citation.

---

## 5. Template — BreadcrumbList

The visible trail is built in the template design (ARCHITECTURE.md §5). This is its
machine half. Add to **every** dynamic item page type via Path B.

### 5a. Neighborhoods item

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "@id": "{{Primary page URL}}#breadcrumb",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://www.theheathshepardrealestateteam.com/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Boerne",
      "item": "https://www.theheathshepardrealestateteam.com/boerne"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "Neighborhoods",
      "item": "https://www.theheathshepardrealestateteam.com/neighborhoods"
    },
    {
      "@type": "ListItem",
      "position": 4,
      "name": "{{name}}"
    }
  ]
}
```

### 5b. Answers item

Position 3 binds to the parent guide via the reference field, so the trail is
`Home > Boerne > Property Taxes > How much are property taxes in Boerne?`

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "@id": "{{Primary page URL}}#breadcrumb",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home",
      "item": "https://www.theheathshepardrealestateteam.com/" },
    { "@type": "ListItem", "position": 2, "name": "Boerne",
      "item": "https://www.theheathshepardrealestateteam.com/boerne" },
    { "@type": "ListItem", "position": 3, "name": "{{parentGuide.title}}",
      "item": "{{parentGuide.slug}}" },
    { "@type": "ListItem", "position": 4, "name": "{{question}}" }
  ]
}
```

Two implementation notes, both of which will bite:

- **The last item has no `item` property.** That is correct per Google's guidance — the
  current page is not linked. Wix's own presets sometimes include it; remove it.
- **`{{parentGuide.slug}}` stores a slug, not a full URL.** Wix cannot concatenate strings
  in the variable picker. Either (a) add a `parentGuideUrl` text field to the `Answers`
  collection holding the absolute URL, populated at import, or (b) flatten position 3 to a
  fixed `name`/`item` pair per guide and accept that it means one markup variant per guide.
  **(a) is correct** — add the field. This is exactly the kind of thing that must be
  decided before the content agents export their CSVs, which is why it is called out in
  ARCHITECTURE.md §3.

### 5c. BoerneGuides item

Three levels: Home > Boerne > `{{title}}`.

---

## 6. Template — Place (Neighborhoods item page, Path B)

Second markup on the neighborhood template, alongside `Article` and `BreadcrumbList`.

```json
{
  "@context": "https://schema.org",
  "@type": "Place",
  "@id": "{{Primary page URL}}#place",
  "name": "{{name}}",
  "description": "{{summary}}",
  "url": "{{Primary page URL}}",
  "image": "{{heroImage}}",
  "additionalType": "https://www.wikidata.org/wiki/Q123705",
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": "{{latitude}}",
    "longitude": "{{longitude}}"
  },
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "{{city}}",
    "addressRegion": "TX",
    "addressCountry": "US"
  },
  "containedInPlace": {
    "@type": "AdministrativeArea",
    "name": "{{county}} County, Texas",
    "containedInPlace": {
      "@type": "State",
      "name": "Texas",
      "sameAs": "https://en.wikipedia.org/wiki/Texas"
    }
  },
  "hasMap": "https://www.google.com/maps/search/?api=1&query={{latitude}},{{longitude}}",
  "subjectOf": { "@id": "{{Primary page URL}}#article" }
}
```

- Schema.org has no `Neighborhood` type. `Place` with `additionalType` pointing at the
  Wikidata neighbourhood entity is the standard way to say it precisely.
- `containedInPlace` nesting (subdivision → county → state) is the geographic signal that
  ties 40 pages into one coherent region rather than 40 unrelated places.
- `Place` produces **no rich result** in Google. It is here for entity understanding and
  for AI assistants answering "what neighbourhoods are in Boerne". That is the point.
- `subjectOf` references the `Article` `@id` from §3 on the same page, connecting the
  place to the writing about it.

---

## 7. Template — ItemList (index / list pages)

Cheap, and it helps a crawler read `/neighborhoods` as a curated index rather than a wall
of links. Add to the three dynamic **list** pages.

```json
{
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "@id": "https://www.theheathshepardrealestateteam.com/neighborhoods#page",
  "name": "Boerne and Hill Country Neighborhoods",
  "isPartOf": { "@id": "https://www.theheathshepardrealestateteam.com/#website" },
  "about": { "@type": "City", "name": "Boerne" },
  "mainEntity": {
    "@type": "ItemList",
    "itemListOrder": "https://schema.org/ItemListUnordered",
    "numberOfItems": 40,
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Cordillera Ranch",
        "url": "https://www.theheathshepardrealestateteam.com/neighborhoods/cordillera-ranch" },
      { "@type": "ListItem", "position": 2, "name": "Tapatio Springs",
        "url": "https://www.theheathshepardrealestateteam.com/neighborhoods/tapatio-springs" }
    ]
  }
}
```

This one is hand-maintained (Path A) — Wix variables cannot iterate a repeater into JSON.
List the 15-20 most important, not all 40, and keep `numberOfItems` honest by setting it
to the number actually listed. Re-check it against the 7,000-character limit each time
entries are added.

---

## 8. Template — Review and AggregateRating

**Do not add either one today. There are no reviews on the site.** Publishing an
`aggregateRating` without reviews rendered on the page is a fabricated claim, it violates
Wix's own stated requirement that markup content appear on the page, and Google treats it
as spam.

**Read this before implementing it later, because it changes the plan:**

Google does not show review stars for `LocalBusiness` or `Organization` (or their
subtypes, which includes `RealEstateAgent`) when the business controls the reviews about
itself. Reviews Heath collects and displays on his own site are "self-serving" and are
**ineligible for the review rich result**, whether they are typed in as testimonials or
pulled in through a Google-reviews widget. The rule has been in force since September 2019.
— [Making Review Rich Results more helpful](https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful),
[Review Snippet structured data](https://developers.google.com/search/docs/appearance/structured-data/review-snippet)

So the plan splits:

- **For stars in Google:** the only route is Google Business Profile reviews, shown in the
  map pack and the knowledge panel. No markup on his site produces them. His GBP keeper
  profile sits at 5.0 with 2 reviews. **Getting that to 15-20 reviews is worth more than
  every schema template in this file combined**, and it costs nothing.
- **For conversion and for AI assistants:** put real testimonials on the page with the
  markup below. It will not produce stars. It will be read by LLMs summarising "is Heath
  Shepard a good agent", and it converts human visitors regardless of markup.

When at least three real, attributable reviews exist and are rendered on the page:

```json
{
  "@context": "https://schema.org",
  "@type": "RealEstateAgent",
  "@id": "https://www.theheathshepardrealestateteam.com/#agent",
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "5.0",
    "reviewCount": "2",
    "bestRating": "5",
    "worstRating": "1"
  },
  "review": [
    {
      "@type": "Review",
      "author": { "@type": "Person", "name": "Sebastian Linke" },
      "datePublished": "REPLACE-YYYY-MM-DD",
      "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5", "worstRating": "1" },
      "reviewBody": "REPLACE with the reviewer's actual words, verbatim, not a paraphrase.",
      "itemReviewed": { "@id": "https://www.theheathshepardrealestateteam.com/#agent" }
    }
  ]
}
```

Rules, non-negotiable:

1. `reviewCount` equals the number of reviews **rendered on that page**. Never the GBP
   total unless every one of them is on the page.
2. `reviewBody` is verbatim. Never edited for length or tone.
3. `author.name` is the reviewer's real name, as they gave it.
4. Re-using a Google review's text on the site requires the reviewer's permission — this
   is a Heath decision, not an implementation detail. See FIX-PRIORITY.md.

**Review-collection link, already tested:**
`https://search.google.com/local/writereview?placeid=ChIJO2JbuzOAVSoRwa3PvvV6NYk`
(verified 2026-09-10 to open the review box). Put it in the footer, in every post-closing
email, and on the thank-you page.

---

## 9. Per-page-type markup matrix

Five markups maximum per page (§1). Nothing here comes close.

| Page type | Markups | Path |
|---|---|---|
| Homepage | `RealEstateAgent/LocalBusiness` (§2), `WebSite` (§2b) | A |
| `/boerne` hub | `CollectionPage`+`ItemList` (§7), `FAQPage` (§4a), `BreadcrumbList` (§5c) | A |
| BoerneGuides item | `Article` (§3), `BreadcrumbList` (§5c), `FAQPage` (§4a, if the page has one) | B |
| Neighborhoods list | `CollectionPage`+`ItemList` (§7), `BreadcrumbList` | A |
| Neighborhoods item | `Article` (§3), `Place` (§6), `BreadcrumbList` (§5a) | B |
| Answers list | `CollectionPage`+`ItemList` (§7), `BreadcrumbList` | A |
| Answers item | `Article` (§3), `FAQPage` (§4b), `BreadcrumbList` (§5b) | B |
| `/buyers` `/sellers` `/investors` | `Service` + `BreadcrumbList`, `provider` → `#agent` | A |
| `/contact` | `ContactPage`, `mainEntity` → `#agent` | A |
| `/about` `/meet-the-team` | `AboutPage`, `mainEntity` → `#heath` | A |

The connective tissue across all of it is the `@id` graph: `#agent`, `#brokerage`,
`#heath`, `#website`. Eight hundred pages that all reference the same four nodes describe
one business. Eight hundred pages that each redefine "Heath Shepard" inline describe
eight hundred unconnected things, and that is the difference between being the entity an
AI assistant names for "Boerne real estate agent" and being 800 pages it ignores.

---

## 10. Pre-flight checklist before the first dynamic markup goes live

- [ ] `parentGuideUrl` absolute-URL field added to `Answers` (§5b)
- [ ] `CONFIRM-` values in §2 resolved by Heath (FIX-PRIORITY.md)
- [ ] LinkedIn URL corrected to `b8849135` in the live homepage block
- [ ] GBP CID link added to `sameAs`
- [ ] Rich Results Test run on three items per page type, including one with empty optional fields and one with an apostrophe in the name
- [ ] Confirmed no markup exceeds 7,000 characters after variable substitution on the longest item in each collection
- [ ] Confirmed every fact asserted in markup is visible on the rendered page
</content>
