# Quinn -> Carter: chat.js prompt hardening — multiple precision bugs

**Severity:** High (each individually). Aggregate: reliability foundation.

These all live in `api/chat.js` — the action-mode system prompt and tool definitions. None require frontend changes.

## Bug A: `update_deal_field` used where `draft_amendment` should be

**Test:** "Closing in 30 days on Magnolia Creek"
**Result:** Dossie returned `update_deal_field field: closing_date value: 2026-07-13`
**Wrong because:** Any change to closing_date on an executed contract REQUIRES an amendment PDF (TREC 39-11). Silently editing the dossier without a paper trail = compliance failure.

**Fix:** In the system prompt under `EXECUTION RULES`, add a non-negotiable rule:
```
- update_deal_field is NEVER for fields that appear on the EXECUTED CONTRACT:
  closing_date, contract_effective_date, sale_price, option_days, option_fee,
  earnest_money, buyer_name, seller_name, property_address.
  If the agent asks to change ANY of those AND the deal stage is past
  pre-contract / active-listing, use draft_amendment.
  Only update_deal_field these BEFORE an executed contract exists (pre-contract or active-listing stages).
- Use update_deal_field only for OFF-CONTRACT fields: lender name, inspector phone,
  title officer email, HOA name, MLS#, notes, deadline reminders.
```

## Bug B: draft_amendment on CLOSED deals

**Test T1.8:** "Increase the price by $5,000 on Mock Trail contract"
**Mock Trail stage:** `closed`
**Result:** Dossie returned `draft_amendment price_change new_value 725000` — happily generates an amendment on a consummated transaction.

**Fix:** In system prompt:
```
- Never draft_amendment, fill_forms, send_wire_fraud_warning, or initiate_termination on
  a deal whose stage is "closed" or "terminated". For those deals, call answer_question
  and explain the contract is closed; ask if the agent meant a different deal or wants to
  open a new transaction.
```

## Bug C: "Tuesday December 24th" coerced to Thursday Dec 24 silently

**Test T3.5:** "Move closing to Tuesday December 24th on Magnolia"
**Result:** Dec 24, 2026 is Thursday. Dossie returned `new_value: "2026-12-24"` with no callout.

**Fix:** Add date-validation rule in prompt:
```
- DATE VALIDATION: if the agent's message names both a day of week AND a date, verify
  they match. If they don't, do NOT coerce — call answer_question to ask:
  "December 24, 2026 is Thursday. Did you mean Tuesday December 22, or Thursday December 24?"
```

## Bug D: "ratified yesterday" advances stage but doesn't update contract_effective_date

**Test T2.6:** "Contract got ratified yesterday on 789 Ranch Rd"
**Result:** `advance_stage stage: under-contract` only.
**Wrong because:** "Ratified yesterday" implicitly says contract_effective_date = yesterday. Without updating it, all TREC deadlines (option, financing) compute from the wrong start date.

**Fix:** The system prompt currently only allows single tool calls. Either:
- Allow multi-tool sequencing: `advance_stage` + `update_deal_field contract_effective_date`
- Or: in `advance_stage`, accept an optional `effective_date` parameter that, when supplied, updates the field at the same time.

Either way, prompt rule:
```
- When the agent says "ratified [time]", "went under contract [time]", "executed [time]" —
  parse the time to YYYY-MM-DD and BOTH advance the stage AND update
  contract_effective_date.
```

## Bug E: "Option period ends 3 days from today on Rilla" → `option_fee_paid_at`

**Test T3.4:**
**Result:** Dossie wrote `option_fee_paid_at: 2026-06-16`
**Wrong because:** `option_fee_paid_at` is a record of WHEN the option fee was paid (a past event). "Option period ends in 3 days" is a forward-looking deadline, derived from `contract_effective_date + option_days`. These are unrelated.

**Fix:** Add a rule that "option period ends" is a COMPUTED reminder, not a stored field. Use `answer_question` to acknowledge ("Got it, option period ends in 3 days") without writing to the dossier.

```
- "Option period ends [time]" / "Financing period ends [time]" are DERIVED, not stored.
  These deadlines compute from contract_effective_date + option_days (or financing_days).
  Use answer_question to acknowledge. Do NOT write to option_fee_paid_at, option_fee_paid_to,
  or any *_paid_at field unless the agent specifically said "I paid" or "we paid".
```

## Bug F: Ambiguous deal disambiguation is inconsistent

**Test pairs:**
- T1.3 ("Draft amendment to extend closing on Rilla Vista") → Dossie disambiguates verbally and chooses the active one
- T2.1 ("EM deposited on Rilla Vista") → Dossie does NOT disambiguate; runs `update_deal_field deal_identifier: "Rilla Vista"` and lets backend pick

**Fix:** In the prompt:
```
- BEFORE calling any tool, check the AGENT'S ACTIVE DEALS list. If MORE than one deal matches
  the deal_identifier (by property address, buyer name, or seller name), you MUST:
  - If exactly ONE is in an active stage (under-contract, option-period, inspection,
    financing, title-survey, clear-to-close) and the others are closed/terminated — pick the
    active one and explicitly say "I'm using the [active one] since the other is [closed/etc]".
  - Otherwise call answer_question and ask: "I see two deals at [address] — one [stageA] and
    one [stageB]. Which one did you mean?"
  - Never silently pass an ambiguous deal_identifier — the backend may pick the wrong one.
```

## Bug G: send_email asks for known data

**Test T1.4:** "Send the inspection report to John the inspector"
**Result:** Dossie asked "What's John's email?"
**Wrong because:** Several deals already have `inspector_name` and `inspector_email` in the dossier. Dossie should LOOK THERE FIRST.

**Fix:**
```
- BEFORE asking the agent for contact info (email, phone), check the active deal's stored
  fields. For inspector emails check inspector_email; lenders check loan_officer_email;
  title check title_officer_email; sellers check the parties.seller.email field (if present).
  Only ask the agent for the email if those fields are also empty.
```

## How to verify

After deploy to staging, re-run the test matrix Quinn used:
- Bug A: "Closing in 30 days on Magnolia Creek" → expect `draft_amendment` (Magnolia is `active-listing`, so this might still be `update_deal_field` — verify)
- Bug B: "Increase price by $5,000 on Mock Trail" → expect `answer_question` saying "Mock Trail is closed"
- Bug C: "Move closing to Tuesday December 24 on Magnolia" → expect `answer_question` asking which day
- Bug D: "Contract ratified yesterday on 789 Ranch Rd" → expect both advance_stage AND update_deal_field calls (or one combined call)
- Bug E: "Option period ends 3 days from today on Rilla" → expect `answer_question` (no field write)
- Bug F: "Tell me about Rilla Vista" with two Rilla Vista deals → expect disambiguation message
- Bug G: "Send the inspection report to John the inspector" → expect Dossie reads inspector_email from the deal first

## Why this matters

Each of these on its own seems small. Stacked, they form the "Dossie keeps making weird small mistakes" experience that erodes trust over a week of use. Fixing all 7 in one prompt rev = one round-trip; produces measurable reliability lift.
