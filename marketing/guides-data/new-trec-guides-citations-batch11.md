# Citation trail — new TREC guide page, batch 11 (2026-08-09)

One new guide: the licensing line for a Texas transaction coordinator — what a TC (licensed
or unlicensed) can and cannot do without triggering Occupations Code / TREC-rule brokerage
licensure requirements. This is the licensing-line follow-up to the existing repo guides
`marketing/guides-data/what-does-a-tc-do-texas.json` (role/workflow description, which already
states in one paragraph that a TC can't negotiate, give legal advice, draft original contracts
undirected, or hold itself out as the agent — but doesn't cite statute) and
`marketing/guides-data/ai-transaction-coordinator-texas.json` (AI-vs-human TC comparison). Neither
existing guide cites 22 TAC or Occupations Code § 1101 directly — this guide is the statutory
depth layer both of those guides link out to.

## Task brief's prior-research citations — verified against primary/near-primary sources, with corrections

The task brief supplied five citations from an earlier, unverified research pass. All five turned
out to be substantively real, but **two had the wrong TAC subsection letter** — both off by one
letter in the same direction (the research pass undercounted a preceding subsection). Corrected
below.

| Task brief's citation | Verified? | Correction |
|---|---|---|
| 22 TAC §535.4 — defines "show" to include opening doors, allowing access, hosting an open house | Yes, verbatim | The "show" definition is subsection **(c)**, not unspecified/(a) |
| 22 TAC §535.4(d) — unlicensed person may not direct or supervise license holders | Substance correct, letter wrong | The direct/supervise licensing requirement is subsection **(e)**, not (d). (d) is actually the unescorted-tenant-showing-access rule (vacant property, ID verification, signed owner consent) — unrelated to supervision. |
| 22 TAC §535.5(f)/(g) — clerical/administrative staff may confirm only size/price/terms of already-advertised property | Substance correct, letter wrong | This is **subsection (g) alone**. (f) is the auctioneer exemption (auctioneers don't need a license to auction real property, but may not show it, prepare offers, or negotiate contracts without also being licensed) — a different, unrelated carve-out. |
| 22 TAC §535.146(c)(7) — only a license holder may sign/handle a brokerage trust account | Yes, verbatim, letter correct | Exact text: "A broker may only authorize **another license holder** to withdraw or transfer money from any trust account, but the broker remains responsible and accountable for all trust money..." — precise verb is "withdraw or transfer," not "sign"; guide uses the statute's own verb. |
| Occupations Code §1101.758 — unlicensed brokerage activity is a Class A misdemeanor | Yes, verbatim, letter correct | "(a) A person commits an offense if the person acts as a broker or sales agent without holding a license... (b) An offense under this section is a Class A misdemeanor." |
| Occupations Code §1101.652(b)(11) and (b)(26) — broker's own license exposure | Yes, verbatim, letters correct | (b)(11): pays/splits a commission or fee with a person other than a license holder. (b)(26): establishes an association by employment or otherwise with a person other than a license holder "if the person is expected or required to act as a license holder." |

## Primary source and method

**22 TAC (Chapter 535 rules):** the previously-documented `tcss.legis.texas.gov` API method
(batch 5 / batch 10) covers Texas *statutes*, not the Texas Administrative Code — TAC lives on a
separate Secretary of State system. That system has moved since the last citation batch touched
it: `texreg.sos.texas.gov` fails to resolve entirely from this environment (DNS), and the older
`texreg.sos.state.tx.us` domain now serves only a redirect stub pointing to a new Appian-hosted
portal (`texas-sos.appianportalsgov.com/rules-and-meetings`), which did not expose a usable direct
link to a specific rule section within the time available for this pass.

Fell back to TREC's own published copy of its rules at
`https://www.trec.texas.gov/agency-information/rules-and-laws/trec-rules` — TREC (Texas Real
Estate Commission) is the agency the rules govern, and this page reproduces the full current text
of 22 TAC Chapter 535 (all subchapters, all sections, including exact `<ol class="lower-alpha">` /
`<ol class="numeric">` HTML list structure that gives the true subsection lettering). The page
carries its own disclaimer, quoted here in full since it matters for sourcing rigor: *"The
information on this page is provided as a courtesy and should not be relied upon as the official
text of a rule. The Texas Secretary of State maintains the official texts of state agency rules
and compiles rules in the Texas Administrative Code."* Fetched live (`curl`, `Last-Modified:
Sun, 09 Aug 2026`, i.e. same day as this pass) rather than via a cached mirror. Cross-checked the
"show" property definition and the license-required language against a Cornell Law School TAC
mirror (`law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-535-4`) as a second, independent
source — the two agree on substance; Cornell's page was not used for subsection lettering since
its rendering collapsed multiple subsections into a summary rather than preserving the numbered
list structure.

**Occupations Code Chapter 1101 (TRELA):** same `tcss.legis.texas.gov` API method as batch 5/10,
code prefix `OC`: `GET
https://tcss.legis.texas.gov/api/GetStatute/GetStatute/OC/1101/1101/null/null/null/null/null/null/null/htm`
resolves to `https://tcss.legis.texas.gov/resources/OC/htm/OC.1101.htm` — the full TRELA chapter,
one file, fetched directly via `curl`. Same Texas Legislative Council infrastructure as the
Property/Government Code fetches in prior batches; the statute-side method generalizes cleanly to
Occupations Code with no changes needed. `Last-Modified: Fri, 10 Apr 2026` header — current, not
stale, and later than the most recent amendment found in the chapter (see below).

## Verified section text and amendment currency

| Claim | Source | Amendment currency |
|---|---|---|
| § 1101.351(a) — unless licensed, a person may not act as or represent that they are a broker or sales agent | Statute text, § 1101.351(a), quoted | Most recent amendment eff. Jan. 1, 2016 — no later change |
| § 1101.002(1)(A) — "broker" activity list requiring a license: sell/exchange/purchase/lease; **negotiate or attempt to negotiate** the listing, sale, exchange, purchase, or lease; list real estate; procure/assist in procuring a prospect or property to effect a transaction; provide a price analysis/opinion (outside a licensed appraisal) tied to real property management/acquisition/disposition/encumbrance; advise on a short sale | Statute text, § 1101.002(1)(A)(i)-(xii), quoted in relevant part | Most recent amendment eff. Jan. 1, 2026 (89th Leg., 2025, S.B. 1968) — already in effect as of this guide's publication |
| § 1101.758(a)-(b) — acting as a broker/sales agent without a license, or engaging in activity requiring a certificate of registration without one, is an offense; a Class A misdemeanor | Statute text, § 1101.758(a)-(b), quoted verbatim | Most recent amendment eff. Jan. 1, 2016 — no later change |
| § 1101.652(b) — commission may discipline a license holder "while engaged in real estate brokerage" for the 34 listed acts in (b) | Statute text, § 1101.652(b) intro clause | Most recent amendment eff. Jan. 1, 2026 (89th Leg., 2025, S.B. 1968) |
| § 1101.652(b)(11) — pays/splits a commission or fee with "a person other than a license holder or a real estate broker or sales agent licensed in another state" | Statute text, § 1101.652(b)(11), quoted verbatim | Same as above |
| § 1101.652(b)(26) — "establishes an association by employment or otherwise with a person other than a license holder if the person is expected or required to act as a license holder" | Statute text, § 1101.652(b)(26), quoted verbatim | Same as above |
| 22 TAC § 535.4(a)-(c) — the Act applies to a person acting as broker/agent physically in Texas; a person must be licensed to **show** a property; "show" is defined to include causing/permitting viewing, unlocking/providing access, and hosting an open house | TREC rules page, § 535.4(a)-(c), quoted verbatim from the `<ol class="lower-alpha">` list | Live TREC page as of 2026-08-09 |
| 22 TAC § 535.4(d) — unescorted prospective-tenant access permitted only if the property is vacant, access-control/ID-verification is used, and the owner signs a specific 12-point-bold written consent | TREC rules page, § 535.4(d), quoted | Same |
| 22 TAC § 535.4(e) — "The employees, agents, or associates of a licensed broker must be licensed as brokers or sales agents if they direct or supervise other persons who perform acts for which a license is required." | TREC rules page, § 535.4(e), quoted verbatim | Same |
| 22 TAC § 535.5(g) — "An answering service or clerical or administrative employees identified to callers as such to confirm information concerning the size, price, and terms of property advertised are not required to be licensed under the Act." | TREC rules page, § 535.5(g), quoted verbatim | Same |
| 22 TAC § 535.5(f) — auctioneers exempt from licensure to auction real property, but may not show it, prepare offers, or negotiate contracts without also being licensed | TREC rules page, § 535.5(f), quoted | Same — included in guide as a contrast example, not a TC-specific rule |
| 22 TAC § 535.146(a)-(e) — trust-money definitions, acceptance, account requirements, disbursement, records | TREC rules page, § 535.146, quoted in relevant part | Same |
| 22 TAC § 535.146(c)(7) — "A broker may only authorize another license holder to withdraw or transfer money from any trust account but the broker remains responsible and accountable for all trust money received..." | TREC rules page, § 535.146(c)(7), quoted verbatim | Same |

## Interpretive notes added in the guide itself, not left implicit

- **§ 535.5(g)'s "advertised" limit is the operative word.** The rule only exempts confirming
  size/price/terms of property that is *already advertised* — it does not create a general
  clerical/administrative carve-out for discussing unadvertised terms, off-market pricing
  strategy, or anything not already publicly stated. The guide states this distinction directly
  because it's the single most common line an unlicensed TC crosses without realizing it (e.g.
  answering "would the seller take $X" when $X isn't the advertised price).
- **§ 535.4(e)'s "direct or supervise" rule is about the employee/agent/associate's own required
  license, not a rule specifically aimed at TCs.** The rule's actual mechanism: if a person's role
  includes directing or supervising other people who perform license-required acts, that directing
  role itself requires a license. The guide frames this precisely as "an unlicensed TC cannot be
  put in charge of directing or supervising an agent's licensed activity" rather than overstating
  it as a TC-specific prohibition — it's a general licensing-scope rule that happens to bind TCs
  the same way it binds any other unlicensed staff role.
- **§ 1101.652(b)(11) and (b)(26) are broker-discipline grounds, not criminal penalties.** These
  two subsections expose the *sponsoring broker's own license* to suspension/revocation for paying
  an unlicensed TC as if for licensed brokerage services, or for structuring the relationship so
  the TC is "expected or required to act as a license holder." The guide keeps this distinct from
  § 1101.758's criminal Class A misdemeanor exposure, which falls on the *unlicensed person*
  themselves — two different actors, two different consequences, both real.
- **§ 535.146(c)(7) governs trust-account withdrawal/transfer authorization, not contract
  signatures generally.** The task brief's framing ("only a license holder may sign on a
  brokerage trust account") is directionally right but the rule's actual scope is narrower and
  more specific: it's about who a broker may *authorize to withdraw or transfer money* from the
  trust account, not about signing documents in general. The guide uses the rule's own verb.

## Flagged as ambiguous / left undecided in the guide

- **Negotiation is not defined by a single bright-line TAC or Occupations Code test** — § 1101.002
  makes "negotiates or attempts to negotiate" a licensed-broker activity, but neither the statute
  nor Chapter 535 draws a hard line between a TC relaying a party's already-stated position
  ("seller says the closing date works") and actually negotiating on someone's behalf ("seller
  will accept if you move the closing date"). The guide states the statutory hook and gives
  practical examples on each side, but does not claim the statute itself resolves every
  borderline phrasing — that's inherently fact-specific.
- **No TAC or Occupations Code provision was found that separately addresses "document
  preparation"** as its own licensed act distinct from negotiation/listing/procuring. The existing
  repo guide (`what-does-a-tc-do-texas.json`) states a TC can't "prepare original contract drafts
  or amendments without an agent's direction" — this guide doesn't re-derive that claim from a new
  citation; it cross-links to the existing guide rather than inventing a statutory basis that
  wasn't found in this pass's sources.
- **TAC access instability is itself worth flagging for future batches.** Both `texreg.sos.texas.gov`
  (unresolvable from this sandbox) and `texreg.sos.state.tx.us` (redirect-only stub to a new Appian
  portal) failed as direct TAC sources in this pass. The TREC agency mirror worked and is
  reasonably reliable (same content, same numbering, agency's own official domain) but carries the
  agency's own "not the official text" disclaimer. Future TAC-citing guides should re-check whether
  the Appian portal (`texas-sos.appianportalsgov.com`) has stabilized into a directly linkable rule
  view by the time of that batch — it did not in the time available for this one.
