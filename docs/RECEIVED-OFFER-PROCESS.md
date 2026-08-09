# Received Offer Process

When an offer comes in on a listing, this produces two deliverables for the
seller client:

1. A formula-driven Excel net-proceeds sheet
2. A summary email — key terms, the net figure, open items, and a
   recommendation **only if the agent actually gave one**

Built 2026-08-01 from a real offer worked through in the Claude app. Currently a
manual process; the productization notes at the bottom are the path into Dossie.

---

## Privacy rule — read this first

**This repo is public** (`heathshepard/MeetDossie`, `visibility: public`). Deal
data — party names, addresses, prices, terms — must never be committed. The
generator takes all of it from a JSON file you keep outside the repo or in
`.tmp/`, which is gitignored.

The original prototype hardcoded seller and buyer legal names, the property
address, and the offer terms directly in the script. That version cannot be
committed. Parameterizing it is what makes it reusable anyway, so the privacy
fix and the reuse goal are the same change.

---

## Running it

```bash
sudo apt install python3-openpyxl          # one-time
cp scripts/net-sheet-example.json .tmp/deal.json
# edit .tmp/deal.json with the real terms
python3 scripts/generate-net-sheet.py .tmp/deal.json .tmp/net-sheet.xlsx
```

Everything in the calculation block is an Excel formula pointing at the yellow
input cells, so the agent can change any assumption in the spreadsheet and the
net recalculates. Nothing is a baked-in number.

### Validate before it reaches a client

Open the file and confirm every formula resolves — no `#REF!`, no `#VALUE!`.
A broken formula in a document going to a seller is a liability, not a cosmetic
bug.

The Claude app has an automated checker at
`/mnt/skills/public/xlsx/scripts/recalc.py` that must return `total_errors: 0`.
That path exists **only inside the Claude app sandbox** — it is not on this
machine, so when running locally the check is manual.

---

## Sheet structure

| Section | Contents |
|---|---|
| Header | Address, seller, buyer, preparing agent |
| Key offer terms | Red banner. Plain-English summary: price vs list, option period and fee, earnest money, financing contingency, closing date, home warranty cap, buyer's brokerage %, property condition, signature status |
| Inputs | Yellow editable cells — price, list price, both commission %s, closing-cost %, annual taxes, days owned, warranty cap, survey, HOA, mortgage payoff, option fee |
| Net proceeds | All formulas, referencing the inputs |
| Reference | List price, $ below list, % below list |
| Notes / open items | Anything ambiguous: blanks in the contract, missing signatures, unresolved addendum terms |

Deductions live in the `DEDUCTIONS` table at the top of the script. Adding a line
item is one tuple, not a code change.

---

## Line items the first version missed

Worth checking on every deal, because each one silently overstates the net:

- **Home warranty reimbursement.** The prototype listed the seller-paid cap in
  the key terms banner but never deducted it. On a $650 cap that is $650 of
  overstated net in a document the seller makes decisions from.
- **Survey.** TREC Para 6C — the seller may owe a new survey if the existing one
  isn't acceptable to the buyer or title company. Commonly several hundred
  dollars.
- **Option fee.** A credit to the seller, not a cost. Small, but it belongs in
  the math rather than only in the summary.

Also sanity-check the closing-cost percentage. On a Texas sale the seller
customarily pays the Owner's Title Policy, which on a $750k home runs several
thousand dollars on the promulgated rate, plus escrow and recording. A flat 1%
is a placeholder, not an answer — replace it with the title company's quote
before the number is presented as real.

---

## Email rules

1. Greeting — use the nickname the client actually goes by, not the name on the
   contract.
2. Key offer terms — mirror the spreadsheet banner.
3. Estimated net — state the figure *and* which assumptions produced it
   ("1% placeholder for closing costs, pending the title quote").
4. Recommendation — include **only** if the agent has given one in conversation.
   Never invent a recommendation.
5. Numbered open items to resolve before responding to the offer.
6. Close by asking for a time to talk.

**Negotiation framing — hard constraint.** Counter-offer language must never be
built on the seller's cost basis or what they have invested. Sunk cost is not a
negotiating position and signals inexperience to the other side. Frame counters
on current market value and the property's improvements. This was corrected
mid-build on the first deal and carries forward.

---

## Productizing into Dossie

**The main gap is contract extraction.** Today a human reads the TREC PDF and
hand-feeds the terms in. Dossie needs: PDF text extraction → Claude API with a
structured output schema → JSON matching the generator's input fields.

TREC forms are consistently laid out across revisions, which makes this
tractable, but the schema has to be versioned per form revision. Forms seen so
far: **TREC 20-19** (One to Four Family Residential), **TREC 40-11** (Third Party
Financing Addendum), **TREC 57-0** (Non-Realty Items Addendum).

**Second gap: closing cost and tax data.** County appraisal district data could
supply recent tax amounts automatically. Title and escrow quotes will likely
always need manual entry unless a specific title company exposes an API.

**Feature shape.** Agent uploads the offer to a listing's transaction record →
both deliverables generate automatically → held as a **draft** for the agent to
review and edit. The agent stays in the loop; financial documents are never
auto-sent to clients. Configurable per agent: default commission %, default
closing-cost assumption, email phrasing preferences.

This overlaps with the existing contract-scan pipeline, which already extracts
TREC fields on the buy side — worth checking whether that extractor can be
pointed at offers rather than built twice.
