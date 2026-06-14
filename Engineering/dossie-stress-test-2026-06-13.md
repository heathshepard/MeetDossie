# Dossie Talk-to-Dossie Stress Test — 2026-06-13

**Quinn (QA agent) — Overnight Run**
**Started:** 2026-06-13 00:33 CDT (off Heath's 12:33 AM founder admission: "Talk to Dossie isn't reliable enough to trust")
**Production target:** https://meetdossie.com
**Demo accounts under test:**
- `demo@meetdossie.com` (Sarah Whitley — brenda/patricia personas, Luna voice)
- `demo2@meetdossie.com` (John Smith — victor persona, Bill voice)

## Test plan executed

Live production API + Playwright on `/app` and `/workspace`.

| # | Category | Tests | Pass | Fail | Rate-limited |
|---|---|---|---|---|---|
| 1 | Action mode tool selection | 14 | 8 | 6 | 0 |
| 2 | TX jargon (TREC, ERTL, CTC, IABS) | 8 | 4 | 4 | 0 |
| 3 | Date math | 5 | 3 | 2 | 0 |
| 4 | Edge cases | 9 | 4 | 3 | 2 |
| 5 | Power-user patterns | 6 | 0 | 0 | 6 (rate limit) |
| 6 | Conversation continuity | 2 | 0 | 0 | 2 |
| 7 | Missing integrations | 4 | 0 | 0 | 4 |
| 8 | Form extraction (TREC fields) | 15 | 14 | 1 | 0 |
| 9 | Buyer vs seller disambig | 7 | 5 | 2 | 0 |
| 10 | Live UI smoke (Playwright) | 3 | 0 | 3 | 0 |

**Total signals captured:** 50+ requests; 30+ chat rate-limited mid-run; UI smoke 3/3 critical-failed.

---

## Top critical bugs (the ones killing Heath's belief)

### Bug 1: Talk to Dossie 401s on every request from the home view
**Severity:** CRITICAL — RED ALERT
**Belief-killing severity:** 5/5

**Reproduction:**
- Log in to https://meetdossie.com/app as `demo@meetdossie.com`
- Type any command into Talk to Dossie composer
- Press Send
- **Result:** UI displays "Couldn't act on that — Something went sideways — Missing or malformed Authorization header."

**Evidence:**
- Playwright network capture: POST /api/chat → 401
- Response body: `{"ok":false,"error":"Missing or malformed Authorization header."}`
- Bundle inspection (`assets/workspace-Cf4tXxlZ.js`): the fetch sends `userId` in body but NO `Authorization: Bearer ...` header.
- 4 references to `/api/chat` in bundle, all with identical (missing-auth) pattern.

**Root cause:**
The Talk-to-Dossie composer fetch in the React workspace bundle uses:
```js
fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },  // <-- missing Authorization
  body: JSON.stringify({ mode, message, messages, userId, deals }),
});
```
But `api/chat.js` line 740 calls `verifySupabaseToken(req)` which reads the Authorization header. `userId` in body is ignored.

**Other places affected (same pattern):**
- `/api/scan-contract` — also missing auth → mobile scan upload will 401
- `/api/speak` — currently 500-ing for other reasons

**Suggested fix:** Carter spec `.claude/quinn-spec-carter-talk-to-dossie-401.md`. Pull JWT from `supabase.auth.getSession()` and add to Authorization header. Same pattern as the bundle already uses for direct Supabase REST calls.

**Why this is THE bug:**
Heath's 12:33 AM founder admission ("Dossie isn't reliable enough to trust") is literally true — she's been answering NOTHING. Every command silently fails with an ugly error message. This is the #1 belief-killer.

---

### Bug 2: 5 of 14 chat tools have NO frontend dispatcher
**Severity:** CRITICAL
**Belief-killing severity:** 5/5

**Reproduction:**
- Type "Draft an amendment to extend closing to next Friday on the 311 Rilla Vista deal"
- After the 401 bug is fixed, Dossie returns `action: "draft_amendment"` with correct params
- Frontend dispatcher `jh()` has no `if (I === "draft_amendment")` branch
- Falls through to: `return await j(G || "I heard you, but I'm not sure how to act on that yet.")`
- **G** is the AI's natural-language message — so Dossie SAYS "drafting now" but no `/api/draft-amendment` fetch is ever made.

**Evidence:**
Bundle dispatcher coverage map:
```
✅ answer_question, send_email, create_dossier, archive_deal, update_deal_field,
   advance_stage, get_deals, get_deal_details, draft_email
❌ fill_forms          (TREC 20-19 contract drafting)
❌ draft_amendment     (TREC 39-10/11 amendment)
❌ send_wire_fraud_warning  (TAR 2517)
❌ log_offer           (seller-side offer log)
❌ initiate_termination     (TREC 38-7)
```

I directly verified the backend works — `POST /api/draft-amendment` with `transactionId/amendmentType/newValue` returned `{ok: true, document: {...}}` and produced a correctly-filled TREC 39-11 PDF. The backend is solid. The frontend never calls it.

**Worst aspect:** Dossie verbally confirms the action ("Drafting the amendment now") followed by NOTHING happening. Silent inaction is worse than visible failure. Agent has no idea the operation didn't complete.

**Root cause:** Phase 1 fill-and-sign was wired backend-only on 2026-05-28; the React dispatcher was never updated. Same for amendment, wire fraud, offer log, termination.

**Bonus bug:** Parameter naming mismatch. `chat.js` tool defs use snake_case (`deal_identifier`, `amendment_type`, `new_value`). `api/draft-amendment` expects camelCase (`transactionId`, `amendmentType`, `newValue`). Even when the dispatcher is added, mapping must convert.

**Suggested fix:** Carter spec `.claude/quinn-spec-carter-missing-tool-dispatchers.md`.

---

### Bug 3: /api/speak is fully broken in production
**Severity:** CRITICAL
**Belief-killing severity:** 4/5

**Reproduction:**
```
curl -X POST https://meetdossie.com/api/speak \
  -H "Content-Type: application/json" -H "Origin: https://meetdossie.com" \
  -d '{"text":"hi","speed":1.0}'
→ HTTP 500 {"ok":false,"error":"Failed to generate speech"}
```

**Why it fails:**
`api/_utils/tts.js` tries 3 providers in sequence (PlayHT, ElevenLabs, OpenAI). The default `TTS_PROVIDER` is `playht` — which is NOT in Heath's stack (CLAUDE.md says ElevenLabs + OpenAI). If `PLAYHT_*` env vars are missing, it falls through. If ElevenLabs also fails (rate limit, key expired, missing voiceId), and OpenAI also fails (key missing), the whole chain throws "TTS unavailable: all providers failed or unconfigured."

**End-user impact:**
- Voice call mode doesn't work — Jessica fails silently with "[Jessica] audio failed, continuing loop silently"
- Morning Brief audio doesn't play — Play Brief produces no sound
- Dossie's voice IS the product — this dead silences her entirely.

**Suggested fix:**
1. Vercel: verify `ELEVENLABS_API_KEY` is set and the configured voiceId is valid.
2. Add structured server-side logging to know WHICH provider failed and WHY.
3. Set `TTS_PROVIDER=elevenlabs` (we don't use PlayHT — don't put it first).
4. Add `/api/speak/health` that probes each provider and reports.
5. User-facing fallback: if Jessica silently swallows audio errors, surface "Couldn't speak right now — text only" in the UI.

---

### Bug 4: Buyer vs Seller assignment is non-deterministic
**Severity:** CRITICAL
**Belief-killing severity:** 5/5

**Reproduction:**
The SAME message extracted twice produced different roles:

- F3 (run 1): "Make an offer at 789 Maple St for the Garcia family, $250k, FHA 3.5% down, 15-day option, close August 1st"
  → `seller_name: "Garcia family"`, `buyer_name: undefined`
- R1 (run 2): SAME MESSAGE
  → `buyer_name: "Garcia family"`, `seller_name: undefined`

**Real-world impact:**
The agent says "Make an offer for the Garcia family." Dossie names Garcia as the SELLER on the TREC contract. Buyer-side agent has signed a contract where their client is named on the wrong side. **The contract is legally unsound.**

This is a structural reliability issue with the LLM extraction — the Haiku model can pick either field depending on temperature/prompt nondeterminism.

**Suggested fix:** Carter — make the extract-form-fields prompt explicit about agent role:
- Add transaction context: include `agent_role` ("buyer_agent" or "listing_agent") from the dossier, derived from the React-side context.
- When buyer/seller is ambiguous from message alone, require an EXPLICIT role marker phrase or fall back to asking.
- Validate before fill-form: if `agent_role: buyer_agent` and `seller_name` is set but `buyer_name` is empty, flag a confidence error and ask the agent to confirm.

---

## High-severity bugs (frequent failure, will not lose trust on first hit but will erode it)

### Bug 5: `update_deal_field` used where `draft_amendment` is correct
**Severity:** High
**Belief-killing severity:** 4/5

**Test T3.3:** "Closing in 30 days on Magnolia Creek"
- Dossie returned `update_deal_field` (silently edit dossier closing_date)
- chat.js prompt EXPLICITLY says: any closing-date change should produce an amendment (`draft_amendment`)
- Result: deal updated WITHOUT a signed amendment. Agent assumes amendment is on file; isn't.

**Why bad:** A closed file is a TX legal-compliance artifact. Silent date edits without an amendment PDF = audit risk for the brokerage. Brittney would catch this and lose all trust.

**Suggested fix:** Strengthen prompt around date/price changes — `update_deal_field` is ONLY for non-contractual fields (lender name, inspector phone). Anything that's in the executed contract → `draft_amendment`, no exceptions.

---

### Bug 6: Test "T1.8 Increase the price by $5k on Mock Trail" — draft_amendment on a CLOSED deal
**Severity:** High
**Belief-killing severity:** 4/5

**Test T1.8:**
- Mock Trail's `stage` is `closed`
- Dossie returned `draft_amendment price_change new_value 725000` (current $720k + $5k = $725k math correct)
- Backend would happily generate the amendment PDF on a closed deal

**Why bad:** Amending a CLOSED contract is meaningless — the contract is consummated. The TC software should refuse and warn the agent.

**Suggested fix:** chat.js system prompt: "Never draft_amendment on a deal with stage in (closed, terminated). Use answer_question to explain."

---

### Bug 7: TWO Rilla Vista dossiers — inconsistent disambiguation
**Severity:** High
**Belief-killing severity:** 3/5

**Reproduction:**
Demo data: `311 Rilla Vista` exists TWICE — one `closed`, one `clear-to-close`.

- T1.3 ("Draft amendment to extend closing on Rilla Vista") → Dossie disambiguates: "There are two dossiers — I'll draft on the clear-to-close one"
- T2.1 ("EM deposited on Rilla Vista") → Dossie does NOT disambiguate; runs `update_deal_field` with `deal_identifier: "Rilla Vista"` and lets the backend pick

**Suggested fix:** Always disambiguate when multiple matches; never silently let the backend pick — backend almost certainly picks the first by `id` which may not be the active one.

---

### Bug 8: Date "Tuesday Dec 24" silently coerced to Dec 24 (a Thursday)
**Severity:** Medium-High
**Belief-killing severity:** 3/5

**Test T3.5:** "Move closing to Tuesday December 24th on Magnolia"
- Dec 24, 2026 is **Thursday**
- Dossie returned `new_value: "2026-12-24"` with no callout that the day-of-week mismatches

**Suggested fix:** Add date validation: when message contains day-of-week + date, check consistency. If mismatch, call `answer_question` to ask: "Dec 24 is Thursday — did you mean Tuesday Dec 22, or Thursday Dec 24?"

---

### Bug 9: "Contract got ratified yesterday" — date param missing entirely
**Severity:** Medium-High
**Belief-killing severity:** 3/5

**Test T2.6:** "Contract got ratified yesterday on 789 Ranch Rd"
- Dossie returned `advance_stage stage: under-contract` 
- Did NOT update `contract_effective_date` to yesterday's date
- Stage advances; effective date stays at whatever it was. **TREC deadlines now compute against the wrong contract_effective_date.**

**Suggested fix:** Multi-tool call. When agent says "ratified yesterday," call BOTH `advance_stage` AND `update_deal_field contract_effective_date`.

---

### Bug 10: "Option period ends 3 days from today on Rilla" → mapped to `option_fee_paid_at`
**Severity:** High
**Belief-killing severity:** 4/5

**Test T3.4:**
- Agent: "Option period ends three days from today on Rilla"
- Dossie returned `update_deal_field field: option_fee_paid_at value: 2026-06-16`

That's the wrong field entirely. Should have been a no-op (option period end is computed from `contract_effective_date + option_days`, not stored separately) or mapped to a note.

**Why bad:** The agent thinks they noted "option ends in 3 days." Dossie wrote "option fee paid 6/16" — a totally different concept. Audit trail is now polluted with wrong data.

**Suggested fix:** chat.js prompt — emphasize `option_fee_paid_at` is for the TRACKING of when option fee was actually paid. "Option period ends" is a computed reminder, not a stored field. Use `answer_question`.

---

### Bug 11: Action items have "Sent email: ..." descriptions but are marked escalated
**Severity:** Medium
**Belief-killing severity:** 3/5

**Live data:** Demo Sarah's `action_items` contains:
- `"Sent email: Welcome to 1247 Sample Way, San Antonio, TX 78209"` (status: escalated)
- `"Sent email: Lender introduction for 1247 Sample Way"` (status: escalated)

**Why bad:**
- The text reads as an ACCOMPLISHMENT ("Sent email")
- But the status says it's overdue / escalated (= NOT actually done)
- Morning brief reads verbatim: "needs immediate attention: sent email: welcome to 1247 sample way"
- Agent hears: "needs immediate attention: sent email" — utterly confusing

**Suggested fix:** Either (a) clean up demo data (don't seed action items with "Sent email:" prefix), or (b) rewrite descriptions to be tasks not events ("Send welcome email for 1247 Sample Way"), or (c) the brief generator should detect "Sent email:" pattern and rewrite to a task.

---

### Bug 12: "Unnamed dossier" in morning brief
**Severity:** Medium
**Belief-killing severity:** 2/5

**Live data:** Sarah has a `transactions` row with NULL `property_address` (deal id `e055b7f8`).

**Brief audio:**
> "Also keeping an eye on, **an unnamed dossier is in motion**, earnest money and option fee both due in 2 days..."

Sounds amateurish on a paid product. Should either skip the dossier or call it "untitled deal #X."

---

### Bug 13: IP-based rate limit (30/hr) too tight for power users
**Severity:** Medium
**Belief-killing severity:** 3/5

**Reproduction:**
- I sent 30 voice commands across 25 minutes from one IP
- 31st request → 429 "Rate limit exceeded"
- Brittney does 80 deals/year. A morning of "what's urgent today?", "draft amendment on X", "update lender on Y", "send wire fraud warning" — easily 30+ requests/morning.
- Affects ALL users sharing my IP (different demo accounts hit the same bucket).

**Why bad:** Power users get rate-limited mid-day. They text Heath "Dossie's down." Trust crumbles.

**Suggested fix:** 
- Rate limit by `userId` for `/api/chat` (it's authenticated), not IP. Use IP rate limit only as DOS defense (much higher).
- Or raise per-IP limit to 300/hr.
- Or auto-throttle gracefully ("I'm catching up — back in 30 seconds") rather than slam 429.

---

### Bug 14: T1.4 "Send the inspection report to John the inspector" — wrong tool reasoning
**Severity:** Medium
**Belief-killing severity:** 2/5

**Test T1.4:**
- Agent: "Send the inspection report to John the inspector"
- Dossie returned NO action (asked for John's email)
- The `send_email` tool requires `to_email`, `subject`, `body` — none are inferable here
- Reasonable to ask for email — BUT could have done better:
  - Could fetch the inspector's email from the active deal's `inspector_email` field
  - Could check the deal's documents for an inspection report
  - Should not act like John is a brand-new contact

**Suggested fix:** Add tool that looks up contact from the active dossier's stored fields before asking the agent for email.

---

## Medium / low severity (cleanup items)

### Bug 15: "ERTL" mapped wrong
T2.5: "The ERTL on Rilla expired"
- Dossie interpreted as **Exclusive Right To List** (listing agreement)
- More commonly in TX RE: **Exclusive Right To Lease**
- Ambiguous without context — but the deal's `role` is `listing` so "Right To List" is reasonable here. Mark as POTENTIAL bug.

### Bug 16: Race conditions on duplicate addresses
The DB has TWO `311 Rilla Vista` entries with same buyer/seller, just different stages. Likely from a test data import bug. Either:
- Cleanup: collapse duplicates by `(user_id, property_address)`
- Or add unique constraint

### Bug 17: Talk-to-Dossie raw API errors leak to user
"Missing or malformed Authorization header" is shown directly. Need a user-friendly error layer.

### Bug 18: New construction form auto-selection
X1: "Contract for builder Lennar Homes new build at 999 Sycamore" was extracted into `resale-contract` (because that's what we sent). The chat tool selector COULD pick `new-home-incomplete` based on words like "builder" + "new build", but doesn't currently. Bonus: the prompt explicitly handles this for chat-mode action selection.

### Bug 19: Buyer "The Walshes" extracted with "The" prefix
R6: "Buyer rep contract for the Walshes" → buyer_name = "The Walshes"
PDF would print "The Walshes" instead of "Walsh family." Cosmetic.

### Bug 20: Cents-vs-dollars edge "25c"
P7 untested (rate-limited). Risk: "EM 25c" or "$25" interpreted as $25 vs $2,500. Could fill a contract with $25 earnest money.

### Bug 21: Amendment date display formatting
The TREC 39-11 amendment PDF reads "June 20, 20 26 ." — the year "26" suffix has spacing oddity. Acceptable but ugly. Cosmetic.

### Bug 22: Code references "TREC 39-10" but ships TREC 39-11
`api/draft-amendment.js` line 1 comment says "Drafts a TREC 39-10 Amendment to Contract PDF". Actual asset embedded is `trec-amendment-39-11-base64.js` (TREC 39-11). Just out-of-date docs.

---

## Additional bugs (post-initial-pass deep dive)

### Bug 23: TREC 20-19 resale-contract fill returns 422 (DocuSeal role mismatch)

**Severity:** CRITICAL — every TREC 20-19 fill attempt fails before PDF rendering.

```bash
curl -X POST .../api/fill-form -d '{"form_type":"resale-contract", ...}'
→ 422 "DocuSeal submission failed (422): Unknown submitter role: Buyer. Template defines [\"First Party\"]"
```

DocuSeal template `4111319` was created with a single role "First Party". Code passes `role: 'Buyer'` and `role: 'Seller'`. The headline form (TREC 20-19) cannot be filled. Carter spec: `quinn-spec-carter-docuseal-roles.md`.

### Bug 24: TREC 40 (Financing Addendum) — loan_amount in wrong slot

**Severity:** CRITICAL.

Generated PDF: "due in full in **340,000 year(s)**, with interest not to exceed **%**" — loan amount jammed into year-count slot; interest rate missing; principal amount slot blank. Carter spec: `quinn-spec-carter-financing-addendum-fieldmap.md`.

### Bug 25: TREC 9 (Unimproved Property) — buyer/seller SWAPPED

**Severity:** CRITICAL.

Generated PDF Section 1: "The parties to this contract are **Williams family (Seller)** and **Test Seller (Buyer)**." — but my input had Williams=buyer and Test Seller=seller. **Labels are reversed.**

### Bug 26: TREC 9 — sales price section has hallucinated numbers

**Severity:** CRITICAL.

Input: `sale_price: 225000, financing_type: "cash"`. Generated PDF Section 3: A blank, B=$17,500, C=$482,500. None of those numbers match the input. Possibly leaking data from a different transaction or hardcoded defaults.

### Bug 27: TREC 9 — property section is concatenated/garbled

**Severity:** HIGH.

Generated PDF Section 2: "City of Castroville, TX 78009 Texas, known as500 FM 471, County of Medina Addition, ," — fields concatenated without separators, address smashed against "known as", county and "Addition" suffix confused.

### Bug 28: TREC 25 (Farm and Ranch) — fill function uses 'undefined_N' placeholder field names

**Severity:** CRITICAL.

Generated PDF: parties (1) BLANK. Property (2) BLANK. Sales price (3) BLANK. The fill function fills no visible data. Code uses field names like `'undefined_2'`, `'undefined_3'`, `'undefined_4'` (PDF auto-named fields). The comments in fill-form.js literally say `// best-guess naming shared with TREC 9 family`. The author didn't actually inspect the farm-ranch PDF's field names.

### Bug 29: TREC 23 (New Home Incomplete) — entirely blank PDF

**Severity:** CRITICAL.

Generated PDF: parties BLANK. Property BLANK. Sales price BLANK. Same pattern as farm-ranch — placeholder field names that don't match the real PDF's AcroForm field structure.

### Bug 30: TREC 50 (Seller's Termination Notice) — termination_reason missing; party names jammed

**Severity:** HIGH.

Generated PDF heading: "BETWEEN THE UNDERSIGNED SELLER AND **Sandra Test Seller James Bennett**" — both names jammed together with no separator. Neither (1) nor (2) checkbox selected; the `termination_reason` value not written anywhere.

### Bug 31: Field-map audit covers all of A-G above (one Carter spec)

Carter spec: `quinn-spec-carter-fill-form-field-audit.md`. Recommends an audit script that generates a PDF for every form_type, runs pdftotext, visually verifies field placement. Estimate: 6-12h for fix + tests.

---

## Summary scorecard (updated)

| Bug | Sev | BK | Carter spec written? |
|-----|-----|----|----|
| 1. /api/chat 401 every call | C | 5 | ✅ quinn-spec-carter-talk-to-dossie-401.md |
| 2. 5/14 tools have no dispatcher | C | 5 | ✅ quinn-spec-carter-missing-tool-dispatchers.md |
| 3. /api/speak 500 (all TTS providers fail) | C | 4 | ✅ quinn-spec-carter-speak-500.md |
| 4. Buyer/seller non-deterministic | C | 5 | ✅ quinn-spec-carter-buyer-seller-ambiguity.md |
| 5. update_deal_field for closing date | H | 4 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 6. draft_amendment on CLOSED deals | H | 4 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 7. Inconsistent disambiguation | H | 3 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 8. Tuesday Dec 24 no callout | M | 3 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 9. "ratified yesterday" missing date | H | 3 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 10. Option period ends → option_fee_paid_at | H | 4 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 11. "Sent email:" action items | M | 3 | demo data cleanup |
| 12. "Unnamed dossier" | M | 2 | TODO |
| 13. IP rate limit 30/hr too tight | M | 3 | TODO |
| 14. send_email asks for known data | M | 2 | ✅ quinn-spec-carter-chat-prompt-hardening.md |
| 15-22 (minor) | L-M | 1-3 | covered |
| 23. TREC 20-19 DocuSeal 422 | C | 5 | ✅ quinn-spec-carter-docuseal-roles.md |
| 24. TREC 40 loan_amount in wrong slot | C | 5 | ✅ quinn-spec-carter-financing-addendum-fieldmap.md |
| 25. TREC 9 buyer/seller SWAPPED | C | 5 | ✅ quinn-spec-carter-fill-form-field-audit.md |
| 26. TREC 9 sales price hallucinated | C | 5 | ✅ quinn-spec-carter-fill-form-field-audit.md |
| 27. TREC 9 property concatenated | H | 3 | ✅ quinn-spec-carter-fill-form-field-audit.md |
| 28. TREC 25 (Farm/Ranch) entirely blank | C | 4 | ✅ quinn-spec-carter-fill-form-field-audit.md |
| 29. TREC 23 (New Home Incomplete) entirely blank | C | 4 | ✅ quinn-spec-carter-fill-form-field-audit.md |
| 30. TREC 50 termination_reason missing | H | 3 | ✅ quinn-spec-carter-fill-form-field-audit.md |

## Bugs found in the final post-rate-limit batch (resumed 01:37 CDT)

### Bug 32: Multi-field update via voice command saves only the FIRST field

**Test T5.4:** "Update lender on 1847 Vintage Way to **First National Bank**, **loan officer Sam Wright**, **phone 210-555-0199**"

Dossie returned `update_deal_field` with ONLY `lender_name: "First National Bank"`. The loan-officer name and phone were dropped silently.

**Why bad:** Power user voice command pattern is "update this AND this AND this." Today Dossie only saves the first thing. The agent moves on assuming all 3 fields updated. Days later they call the LO and discover no name/phone on file.

**Suggested fix:** Allow multi-tool calling, OR teach the prompt to handle multi-field updates by making sequential update_deal_field calls in one response.

### Bug 33: Multi-deal questions only handle the FIRST deal mentioned

**Test T5.5:** "I have Carlos Martinez closing on Friday and Michael Rodriguez closing on Tuesday, what do I need to do?"

Dossie returned `get_deal_details deal_identifier: "Carlos Martinez"`. Michael Rodriguez was dropped.

**Suggested fix:** Detect plural-deal queries; either iterate over all deals OR call answer_question with both.

### Bug 34: create_dossier requires only property_address but Dossie refuses to call it

**Test T6.2:** "Open a new file at 555 Oak Lane"

The `create_dossier` tool definition requires ONLY `property_address`. Dossie returned NO action — asked for city/state/zip + buyer/seller side.

The system prompt explicitly says: "Always call a tool. Never respond with plain text only." Dossie violated her own rule.

**Suggested fix:** When the user gives a street address, IMMEDIATELY call `create_dossier`, then in the SAME conversation ask for the missing fields. Don't gate creation on extra info.

### Bug 35: draft_amendment on a pre-contract deal is wrong

**Test T8.4:** "Inspection found foundation issues on 23 Nopalito. Buyer wants $15k credit"

23 Nopalito's stage is `pre-contract` (no executed contract). Dossie returned `draft_amendment amendment_type: price_change new_value: "114500"` ($129,500 - $15,000 = $114,500 — math is right). But you don't AMEND a contract that isn't yet executed — you negotiate it.

**Suggested fix:** Block draft_amendment on stages [`pre-contract`, `active-listing`, `pre-listing`]. For pre-contract deals, use update_deal_field on sale_price + add a note.

### Wins (Dossie did these well)

- **T10.1, T10.2, T10.3 (name correction)** — "Hey Dorothy" → "It's Dossie, by the way" → executes action. Perfect.
- **T9.4 (real person)** — Polite, transparent answer + pivot to value.
- **T9.2 (love letter)** — Polite decline + offer of in-domain help.
- **T9.3 (Skyslope)** — Acknowledges competitor briefly, pivots to Dossie value.
- **T8.2 (TX legal — seller backing out)** — Gives accurate TX-specific legal answer.
- **T4.9 (chaotic urgent request)** — Calmly asks for the right address.
- **T11.2 ("Mark as funded")** — Correctly maps to `closed` stage.
- **T4.8 (Archive Presidio Parkway)** — Single-match archive worked clean.

## Final tally

- **35 distinct bugs** identified.
- **11 CRITICAL** (belief-killing): 1, 2, 3, 4, 23, 24, 25, 26, 28, 29 + Bug 4 is also a structural breach
- **8 HIGH**
- **7 MEDIUM**
- **4 LOW**

## Carter specs written (7)

1. `quinn-spec-carter-talk-to-dossie-401.md` — chat 401 fix
2. `quinn-spec-carter-missing-tool-dispatchers.md` — 5 missing tool handlers
3. `quinn-spec-carter-speak-500.md` — TTS / voice fix
4. `quinn-spec-carter-buyer-seller-ambiguity.md` — extract role determinism
5. `quinn-spec-carter-chat-prompt-hardening.md` — 7 prompt-level precision fixes (bundled)
6. `quinn-spec-carter-docuseal-roles.md` — TREC 20-19 DocuSeal template
7. `quinn-spec-carter-financing-addendum-fieldmap.md` — TREC 40 loan-slot fix
8. `quinn-spec-carter-fill-form-field-audit.md` — full TREC 9/23/25/40/50 field-map audit

## Top 3 belief-killers (final)

1. **Bug 1 + 2 (chat 401 + missing dispatchers)** — voice commands silently fail OR confirm-then-do-nothing. This IS what Heath was describing at 12:33 AM.
2. **Bug 23 + 28 + 29 (TREC 20-19, Farm/Ranch, New Home all broken)** — three of the most common contract types do not fill correctly. Backend works for amendment + financing-addendum (partially) + termination + wire-fraud. Headline contract is dead.
3. **Bug 4 (buyer/seller non-determinism) + Bug 25 (TREC 9 party swap)** — even when forms DO fill, party labels are unreliable. Brittney signs the wrong side.

Fix specs 1, 2, 6, 7, 8 (priorities) and Heath has a working voice-to-TREC-contract demo. Fix specs 3, 4, 5 and Dossie's reliability matches her positioning.

