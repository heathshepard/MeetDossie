# Batch 23 citation trail — Texas SB 17 (Foreign Ownership Restriction) Guide

Guide: `marketing/guides-data/texas-sb17-foreign-ownership-restriction-guide.json`
(slug: `texas-sb17-foreign-ownership-restriction-guide`)

Topic: Texas SB 17 (89th Legislature, Regular Session, 2025) — restrictions on the purchase or
acquisition of an interest in Texas real property by certain individuals and entities tied to
"designated countries." High-stakes/high-compliance-risk topic (criminal exposure for the wrong
party in a transaction) — every claim below was checked against a primary source, not a secondary
summary, before it went in the guide.

---

## 1. The enrolled bill text — primary source, read directly

- URL: `https://capitol.texas.gov/tlodocs/89R/billtext/html/SB00017F.HTM`
- Verification method: downloaded the actual HTML of the enrolled bill (`curl`), stripped markup,
  decoded HTML entities, and read the full statutory text section-by-section myself — not a
  WebFetch summary alone. (A WebFetch summarization pass was run first as a fast first read, then
  independently re-verified line-by-line against the raw downloaded text before anything from it
  went into the guide.)
- Bill caption (verbatim): "AN ACT relating to the purchase or acquisition of an interest in real
  property by certain aliens or foreign entities; creating a criminal offense; providing a civil
  penalty."
- SECTION 4 adds **Subchapter H (§§5.251–5.259) to Chapter 5, Texas Property Code**. Confirmed.
- **SECTION 8: effective date September 1, 2025.** Confirmed verbatim.
- SECTION 6 (non-codified): the changes apply only to purchases/acquisitions on or after the
  effective date; pre-effective-date transactions are governed by prior law.

### §5.251 Definitions (verbatim, relevant parts)

- **"Designated country"** — two-prong definition, confirmed verbatim:
  - (A) a country the U.S. Director of National Intelligence has identified as posing a national
    security risk in at least one of the three most recent Annual Threat Assessments of the U.S.
    Intelligence Community (per 50 U.S.C. §3043b); OR
  - (B) a country designated by the Texas governor under §5.254.
  - **The statute does NOT name China, Russia, Iran, or North Korea directly.** Those four
    countries are the ones understood — via the 2025 Annual Threat Assessment (published March
    2025, ODNI/DNI Gabbard) and consistent secondary legal commentary (Greenberg Traurig, Jackson
    Walker, Duane Morris, Morgan Lewis, KERA News) — to currently satisfy prong (A). This is an
    important nuance for the guide: it's an inference from the ATA's contents, not a fixed
    statutory list, and it can shift if a future ATA changes or the governor acts under §5.254.
    Guide language reflects this precisely — does not claim the statute names these countries.
- **"Real property"** (§5.251(6)) — confirmed to include: agricultural land; improvements on
  agricultural land; commercial property; industrial property; groundwater; residential property;
  mines/quarries; minerals in place; standing timber; water rights. **No limitation to property
  near military installations or critical infrastructure appears anywhere in the definition or in
  §5.253.** This corrects a common shorthand in some secondary/social coverage that frames SB 17
  as a "near military bases" law — it is not; it applies to real property of the covered types
  statewide, regardless of proximity to any installation.

### §5.252 Exceptions (verbatim, relevant parts)

- U.S. citizens or lawful permanent residents — fully exempt from the subchapter.
- Companies/organizations owned/controlled by (1) U.S. citizens or LPRs and (2) no individual
  described in §5.253 — exempt.
- Leasehold interests under one year in duration — exempt.

### §5.253 Prohibition (verbatim, relevant parts) — the actual restricted class

1. Governmental entities of a designated country.
2. Companies/organizations that are headquartered in a designated country, directly/indirectly
   controlled by a designated country's government, majority-owned/controlled by individuals
   described in (4), or designated by the governor under §5.254.
3. Companies/organizations owned by or majority-controlled by a company described in (2).
4. Individuals who meet ANY of five tests:
   - (A) domiciled in a designated country — EXCEPT an individual lawfully present/residing in
     the U.S. at time of purchase may still buy ONE residential property as their homestead
     (cross-referenced to Tax Code §11.13(j) for the homestead definition);
   - (B) a citizen of a designated country domiciled outside the U.S. in a non-designated country,
     without having completed naturalization there;
   - (C) a citizen of a designated country unlawfully present in the U.S.;
   - (D) a citizen of any non-U.S. country acting as an agent for a designated country;
   - (E) a member of the ruling political party (or any subdivision of it) of a designated
     country.
- This is the exact basis for the guide's framing that SB 17 is **not** a general "foreign buyer"
  restriction — it's a narrow, multi-factor test keyed to designated-country domicile/citizenship/
  political-party membership, with broad carve-outs for U.S. citizens, LPRs, and even
  designated-country citizens who are lawfully present and buying a single homestead.

### §5.254 Designation of country or entity — confirmed

Governor may designate (or remove designation of) a country, transnational criminal organization,
or entity as subject to the subchapter, after consulting DPS's public safety director and the
Homeland Security Council. Designation/removal applies prospectively only (§5.254(c)).

### §5.255–5.257 Enforcement mechanics — confirmed

- **Enforcement is Attorney-General-only.** AG investigates, may bring an in rem action in the
  county where the property sits, records notice in the county real property records, and may
  refer to law enforcement for criminal prosecution. No private right of action created for
  buyers, sellers, or agents under this subchapter.
- **§5.255(e), verbatim finding: a purchase/acquisition in violation of §5.253 is NOT void because
  of the violation** (except for leasehold interests), and the validity/enforceability of the
  purchase contract or conveyance is not otherwise affected. This matters for the guide — a
  violation does not automatically unwind the deal; it exposes the parties to the AG action and
  penalty/divestiture track described below.
- **§5.257: divestiture mechanism.** If a court finds a violation in an AG action, the court must
  order divestment and appoint a receiver to sell/dispose of the interest and manage the property
  pending sale; proceeds go first to existing liens, then to the state's enforcement costs, with
  the remainder returned to the violating purchaser. The court also refers the matter for
  possible criminal prosecution.

### §5.258 — Criminal offense (verbatim) — INDEPENDENTLY VERIFIED, confirms the prior research pass

> "Sec. 5.258. OFFENSE; PENALTY. (a) A person commits an offense if the person: (1) is an
> individual described by Section 5.253(4); and (2) intentionally or knowingly purchases or
> otherwise acquires an interest in real property in this state in violation of this subchapter.
> (b) An offense under Subsection (a) is a state jail felony."

**Confirmed exactly as the prior research pass flagged: state jail felony, and it applies only to
individuals described under §5.253(4)** — i.e., only the individual-citizenship/domicile category,
not companies, not governmental entities. This is an important precision point carried into the
guide: the criminal exposure track is individual-only.

### §5.259 — Civil penalty (verbatim) — INDEPENDENTLY VERIFIED, confirms the prior research pass

> "Sec. 5.259. CIVIL PENALTY. (a) The attorney general may bring an action in the name of the
> state against a company or entity that violates this subchapter. (b) A company or entity that a
> court determines in an action brought under this section to have violated this subchapter is
> liable to the state for a civil penalty equal to the greater of: (1) $250,000; or (2) 50 percent
> of the market value of the interest in real property that is the subject of the violation."

**Confirmed exactly as the prior research pass flagged: greater of $250,000 or 50% of the market
value of the property interest — and this track applies only to companies/entities, not
individuals** (individuals sit on the criminal track under §5.258 instead). Both figures verified
against the raw downloaded statutory text, not a secondary summary.

---

## 2. Texas REALTORS forms — TXR 1501 / TXR 2003 claim, independently checked (not assumed true)

- Primary source: Texas REALTORS' own **"Details of Forms Changes for January 2026"** PDF —
  `https://www.texasrealestate.com/wp-content/uploads/2026-forms-changes.pdf`
- Verification method: downloaded the PDF directly and read all 5 pages in full (not a secondary
  blog summary of it).
- **Confirmed accurate — TXR 1501 (Buyer/Tenant Representation Agreement – Long Form):** per the
  document, among other January 2026 changes, TXR 1501 "Included an informational notice relating
  to changes to Texas law following the passage of Senate Bill 17 relating to certain foreign
  acquisitions of real property interests."
- **Confirmed accurate — TXR 2003 (Residential Lease Application):** per the same document, TXR
  2003 "Included an informational notice relating to changes to Texas law following the passage of
  Senate Bill 17 relating to certain foreign acquisitions of real property interests; Applicants
  should consult with an attorney if they think the law may apply to them." (Makes sense
  independently of the REALTORS confirmation — SB 17 restricts leasehold interests of one year or
  longer per §5.252(3)/§5.251(6), so a lease-application-stage notice is statutorily coherent, not
  just a generic add-on.)
- **Also checked and NOT found:** no SB 17 notice was added to the standard One-to-Four Family
  Residential Contract itself (TREC-promulgated, not a TXR form) in this January 2026 release, nor
  is one mentioned for TXR 1101 (Listing Agreement) or the TREC contract forms section of the same
  document (that section, "TREC FORM REVISIONS," covers only TXR 2501/IABS, TXR 1910/TREC 15-7,
  and TXR 1911/TREC 16-7 — none SB-17-related; those changes are SB 1968/subagency and flood-notice
  related). Guide language reflects this precisely — does not imply SB 17 disclosure is baked into
  the purchase contract form itself.

---

## 3. Attorney General enforcement rules (1 TAC Chapter 67) — new finding beyond the prior pass

Not part of the original brief but directly relevant to the "disclosure/certification obligations"
question the task asked about, and to the fair-housing tension — so it was researched and included.

- Primary source: Texas Register, March 27, 2026 issue, Proposed Rules, Title 1 Part 3 (Office of
  the Attorney General) — `https://www.sos.state.tx.us/texreg/pdf/backview/0327/0327prop.pdf`
  (full 514-page issue; relevant section is "CHAPTER 67. FOREIGN OWNERSHIP ENFORCEMENT," 1 TAC
  §§67.1–67.9, 51 TexReg 1937–1939).
- Verification method: downloaded the full PDF, ran `pdftotext -layout`, and read the actual
  proposed rule text directly (not a law-firm summary alone — several firm write-ups, e.g. Jackson
  Walker, Greenberg Traurig, Husch Blackwell, Snell & Wilmer, were used to find this document but
  the rule text itself was pulled and read from the Texas Register PDF).
- **§67.2(3) "Facilitating entity" — verbatim:** "A person or entity that, in the regular course
  of business, assists with, brokers, insures, finances, values, or processes a purchase or
  acquisition of an interest in real property in this State, including, but not limited to, a
  mortgage lender, title insurance company, property insurer, appraiser, or **licensed real estate
  professional**." Confirms real estate agents/brokers are expressly swept into this defined term.
- **§67.4(a) verbatim:** "A facilitating entity that knows or should have known, after reasonable
  due diligence, that a purchase or acquisition of an interest in real property in this State
  violates Subchapter H, Chapter 5, Texas Property Code must submit a complaint to the OAG."
  §67.4(e) allows the OAG to refer a facilitating entity that fails to file to the entity's
  licensing/professional disciplinary authority (for a real estate professional, that would be
  TREC, per §67.6's interagency-coordination reference to TREC).
- **Critical gap, confirmed by reading the full rule text: nowhere in proposed Chapter 67, and
  nowhere in Subchapter H itself, is "reasonable due diligence" defined.** No checklist, no safe
  harbor, no specified verification method (e.g., no ID/passport requirement, no certification
  form) appears anywhere in either the statute or this proposed rule. This is the direct textual
  basis for the guide's fair-housing-tension section — it is not an inference from secondary
  commentary, it's an absence confirmed by reading the primary rule text itself.
- **Rule status — flagged as uncertain, NOT overstated in the guide:** the document I read is
  explicitly headed "PROPOSED RULES" (Texas Register, March 27, 2026), with a 30-day public
  comment period specified in the text itself (running from publication). Multiple secondary
  sources (Greenberg Traurig, National Law Review, Texas Policy Research) state the comment period
  ended April 26, 2026, and at least one secondary source states the rules "became effective April
  26, 2026" — but I was **blocked (HTTP 403) from directly loading the Texas Register's Adopted
  Rules archive page** to independently confirm final adopted text, so I could not verify that
  claim against a primary source the way I verified everything else in this guide. **The guide
  language reflects only what I could verify directly: as of the March 27, 2026 Texas Register
  proposal I read in full, this was a proposed rule, not yet confirmed-adopted by me.** Flagging
  for whoever next touches this guide: confirm final 1 TAC Chapter 67 adopted text before treating
  the "facilitating entity" duty as settled, final rule language.

---

## 4. The fair-housing tension — real, not hypothetical; litigation status independently checked

Task explicitly asked this be named, not glossed over. Checked via primary-adjacent sources
(court opinion summaries, law firm case trackers) rather than assumed.

- **Wang v. Paxton** (S.D. Tex., filed July 3, 2025 by three Chinese citizens on nonimmigrant
  visas, via the Chinese American Legal Defense Alliance) raised — among other claims — a **Fair
  Housing Act preemption claim**, arguing SB 17 lets sellers/landlords discriminate against
  Chinese purchasers/renters in violation of federal law, plus Equal Protection and
  Supremacy Clause (FIRRMA/CFIUS preemption) claims.
- **District court dismissed on August 18, 2025 — on standing grounds only.** The court found the
  named plaintiff wasn't domiciled in China (he'd lived in Texas 16 years on an F-1 visa and
  intended to stay), so the statute didn't actually reach his conduct — no injury, no standing.
  **The court did not reach the Fair Housing Act claim or any other merits question.**
- **Fifth Circuit affirmed on the same standing grounds; mandate issued January 5, 2026**
  (confirmed via Justia's posted Fifth Circuit opinion index for case No. 25-20354 and corroborated
  by Jackson Walker's Dec. 12, 2025 client alert on the appellate ruling). The appellate opinion
  is reported to give two independent standing grounds: failure to allege domicile in China, and
  failure to show a credible threat of enforcement given the AG's in-court assurances.
- **Net effect, confirmed: no court has ruled on the merits of whether SB 17 conflicts with the
  federal Fair Housing Act.** The law remains in effect and enforceable statewide; the
  fair-housing question is legally live and unresolved, not decided in either direction. Guide
  language states this precisely — does not claim SB 17 has been upheld against a Fair Housing Act
  challenge (it hasn't been tested on the merits) and does not claim it's been struck down (it
  hasn't).
- **Not included in the guide, flagged here only:** search results surfaced a second, more recent
  case referenced as "Huang v. Paxton" (5th Cir. docket 25-51034) and Supreme Court emergency
  docket activity (No. 25A1390, filed ~June 2026) suggesting further, more recent litigation
  activity with different plaintiffs. I could not get a clean, directly-verified read on what that
  case actually holds or its current procedural posture — the SCOTUS docket PDF returned an HTTP
  403 and secondary summaries of it were internally inconsistent (conflating, it appears, TRO/stay
  details from the earlier Wang proceedings with a separate case). Per the "don't guess" standard
  for this topic, I deliberately left this out of the guide rather than publish an unverified
  case detail on a high-stakes compliance page. Worth a dedicated future research pass if this
  guide gets revisited — search "Huang v. Paxton" 5th Circuit and SCOTUS docket 25A1390 directly.

---

## 5. Sources used, full list

1. Enrolled bill text (primary, most-weighted): `https://capitol.texas.gov/tlodocs/89R/billtext/html/SB00017F.HTM`
2. Texas REALTORS "Details of Forms Changes for January 2026" PDF: `https://www.texasrealestate.com/wp-content/uploads/2026-forms-changes.pdf`
3. Texas Register, March 27, 2026, Proposed Rules, 1 TAC Chapter 67: `https://www.sos.state.tx.us/texreg/pdf/backview/0327/0327prop.pdf`
4. 2025 Annual Threat Assessment of the U.S. Intelligence Community (ODNI, March 2025) — used only
   to confirm the ATA identifies China/Russia/Iran/North Korea as national-security-risk countries
   generally; not used as a substitute for reading the statute's own "designated country" test.
5. Secondary legal commentary used for triangulation and litigation-tracking only, not as the
   basis for any statutory claim (all statutory claims verified against source #1 directly):
   Greenberg Traurig (2025-07 and 2026-04 alerts), Jackson Walker (foreign-ownership analysis and
   Dec. 12, 2025 Fifth Circuit alert), Duane Morris, Morgan Lewis, Husch Blackwell, Snell & Wilmer,
   Norton Rose Fulbright, National Ag Law Center (Wang v. Paxton district court summary), V&E
   (velaw.com, Dec. 1, 2025 circuit-court status piece).

## Cross-link

Guide cross-links to `texas-firpta-withholding-guide` (adjacent "foreign party to a Texas real
estate transaction" compliance topic, same "route it to a specialist, don't guess" framing) and
`texas-farm-and-ranch-contract-guide` (SB 17 explicitly covers agricultural land and improvements,
§5.251(1)/(6)). Did NOT add this guide to either of those guides' own `related_guides` arrays per
the isolation rule — only new files were touched in this pass.
