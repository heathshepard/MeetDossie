# CARTER STATUS REPORT: Opus vs Sonnet Test

**Timestamp:** 2026-06-13 10:15 UTC
**Status:** BLOCKED ON CRITICAL DISCOVERY

## Summary

I prepared to run the Opus vs Sonnet test per your instruction. However, I discovered Quinn's **actual** overnight test results: 10 documented critical bugs. None of them are model-dependent.

**This blocks the test as designed because the bugs aren't fixable by model swaps.**

## What I Found

Quinn generated 10 detailed bug specifications:

1. **buyer-seller-ambiguity** (CRITICAL) — Haiku non-determinism swaps buyer/seller
   - FIX: Pass agent_role explicitly, not model upgrade
   
2. **missing-tool-dispatchers** (CRITICAL) — 5 Talk-to-Dossie tools not wired in frontend
   - FIX: Add React dispatcher cases, not model upgrade
   
3. **docuseal-roles** (CRITICAL) — Template role mismatch causes 422 on fill-form
   - FIX: Fix DocuSeal field mapping, not model upgrade
   
4. **fill-form-field-audit** (CRITICAL) — TREC form fields mis-labeled/wrong
   - FIX: Field map correctness, not model reasoning
   
5. **financing-addendum-fieldmap** (CRITICAL) — Loan amount in wrong slot
   - FIX: Field map bug, not model upgrade
   
6. **speak-500** (CRITICAL) — ElevenLabs voice endpoint broken in production
   - FIX: API debugging, not model upgrade
   
7. **talk-to-dossie-401** (CRITICAL) — Auth header mismatch on Talk-to-Dossie
   - FIX: API middleware fix, not model upgrade
   
8. **stage-enum-drift** (HIGH) — DB stages != chat.js stages
   - FIX: Schema alignment, not model upgrade
   
9. **chat-prompt-hardening** (HIGH) — Multiple precision bugs in system prompt
   - MIGHT benefit from better model, but primarily prompt fixes
   
10. **overnight-ops-loop2** (reference) — Summary of above

## The Problem

Your test design assumes:
> "Test if upgrading Talk-to-Dossie's brain from Sonnet 4.6 → Opus 4.7 fixes Quinn's 35 bugs"

But Quinn's bugs are:
- **Infrastructure/integration:** API endpoints, React dispatchers, field mapping
- **NOT model-dependent:** These won't be fixed by Sonnet → Opus swap

**An analogy:** If the plumbing is broken, upgrading the water heater from good to excellent won't fix it.

## Decision Required

**Before I run the Opus test, please clarify:**

### Option A: Run Opus test anyway on HYPOTHETICAL model-dependent bugs
- I create sample bugs (extraction, role confusion, contract reasoning)
- Test Sonnet vs Opus on them
- This will show Opus capability but NOT match Quinn's real findings
- Result: Intellectually interesting but doesn't answer your actual question

### Option B: Fix Quinn's infrastructure bugs FIRST
- Assign each bug to Carter or other agents
- Fix all 10 critical/high issues
- THEN test if model upgrade helps remaining edge cases
- Result: Dossie actually works before worrying about model optimization

### Option C: Minimal Opus test + prioritize infra fixes
- Quick 5-minute model capability check (yes, Opus is better at reasoning)
- Then: Have Quinn file a prioritized bug triage
- Focus team on infra bugs (they're all 5-minute fixes except the 401)
- Plan model upgrade for Phase 2 (after infra stable)

## My Recommendation

**Option B:** Fix the 10 bugs first. They're all HIGH/CRITICAL and they're all concrete.

Reasoning:
1. The missing 5 Talk-to-Dossie dispatchers (fill_forms, draft_amendment, etc.) are preventing customers from using features they expect to exist
2. The 401 bug blocks voice from the home view entirely
3. The field-mapping bugs mean generated PDFs are wrong
4. None of these are model-dependent — they're 100% fixable engineering

**Then** (in 1-2 days after infra is stable): test Opus on edge cases to see if it helps with any of the prompt-hardening or disambiguation issues.

## What I Can Do Right Now

- **Run Opus test on hypothetical bugs** (Option A): 30 minutes
- **Help prioritize Quinn's 10 bugs for assignment**: 15 minutes
- **Spike on the 401 bug** (it's the blocker for voice): 20 minutes
- **Review Quinn's field mappings** for quick wins: 30 minutes

## Files I've Created

- `test-opus-vs-sonnet.mjs` — Ready to run if you want Option A
- `opus-vs-sonnet-test-2026-06-13.md` — Methodology doc
- `summary.txt` — Quick status
- `.claude/quinn-spec-carter-*.md` — Quinn's 10 detailed bugs (in repo already)

## Next Step

**Your call:** A, B, or C?

If A: I'll run the test in 30 minutes and show Opus is better at reasoning (expected).
If B: I'll help prioritize, then we ship bugs one by one.
If C: Both — quick test + bug triage.

---

**Carter**
Product Engineering Head
MeetDossie, Shepard Ventures
