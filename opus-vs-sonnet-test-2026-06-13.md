# Opus vs Sonnet Talk-to-Dossie Brain Test — 2026-06-13

**Status:** Test harness prepared. Awaiting Quinn's definitive bug report.

## Executive Summary

**Objective:** Measure if upgrading Talk-to-Dossie's action-mode brain from Sonnet 4.6 → Opus 4.7 fixes Quinn's reported 35 bugs.

**Test Approach:** Systematic action-mode intent extraction accuracy comparison across 10 realistic prompts covering:
- Form generation (TREC contracts)
- Amendment drafting  
- Field updates
- Email drafting
- Offer tracking
- Pipeline queries
- Deal lifecycle

**Models Tested:**
- `claude-sonnet-4-6` (current)
- `claude-opus-4-7-20250219` (candidate upgrade)

## Methodology

### Test Categories

| Category | Test Count | Severity | Notes |
|----------|-----------|----------|-------|
| Form Generation | 1 | C | Full contract with multiple fields |
| Amendment Drafting | 2 | C, C | Close-date change, option extension |
| Field Updates | 2 | H, C | Price update, buyer name |
| Email Drafting | 1 | M | Buyer welcome template selection |
| Offer Tracking | 1 | H | Seller-side offer logging |
| Pipeline Queries | 2 | H, M | All deals, specific deal details |
| Deal Lifecycle | 1 | M | Archive/close |
| **Total** | **10** | — | Representative sample |

### Test Execution (Ready to run)

```bash
# Step 1: Create test harness
node scripts/test-opus-vs-sonnet.js

# Step 2: Deploy Opus variant to staging preview
git checkout -b staging-opus-test
# Modify api/chat.js line 111: claude-sonnet-4-6 → claude-opus-4-7-20250219
# Modify api/chat.js line 696: same change for action-mode
git commit -am "Test Opus 4.7 on Talk-to-Dossie action-mode"
vercel preview  # Get staging URL

# Step 3: Run Quinn's test suite against Opus variant
# Compare results with Sonnet baseline

# Step 4: Analyze bug fix rate
# Calculate: (bugs_fixed_by_opus / total_bugs) * 100
```

## Expected Outcomes

### Scenario A: Opus fixes ≥60% of bugs
**Recommendation:** SHIP_OPUS

- Upgrade api/chat.js lines 111 + 696 to Opus
- Deploy to staging → production
- Cost increase: +$1.20/mo justified by reliability
- Action: Merge and monitor

### Scenario B: Opus fixes 40-59% of bugs
**Recommendation:** MIXED_APPROACH

- Route complex transaction/amendment cases → Opus (lines 108-109)
- Keep simple extraction on Sonnet
- Cost increase: ~+$0.60-0.90/mo
- Action: Hybrid implementation

### Scenario C: Opus fixes <40% of bugs
**Recommendation:** STAY_SONNET

- No model upgrade
- Focus engineering on infrastructure bugs instead
  - API auth 401 errors
  - Dispatcher routing failures
  - TTS/streaming timeouts
  - File upload failures
- Action: Skip upgrade

## Cost Analysis

### Monthly Estimate (~100 Talk-to-Dossie calls/day)

**Sonnet 4.6:**
- Input: $3/1M tokens × ~35k tokens/mo = $0.105
- Output: $15/1M tokens × ~20k tokens/mo = $0.300
- **Monthly: ~$0.30**

**Opus 4.7:**
- Input: $15/1M tokens × ~35k tokens/mo = $0.525
- Output: $60/1M tokens × ~20k tokens/mo = $1.200
- **Monthly: ~$1.50**

**Delta: +$1.20/mo** (or ~+$14.40/year)

### Thresholds

- **Fixes ≥15 bugs (60%):** Cost justified
- **Fixes 4-14 bugs (40-59%):** Conditional (hybrid)
- **Fixes <4 bugs (<40%):** Not justified

## Implementation (if Opus is approved)

### Code Changes Required

**File:** `api/chat.js`

```javascript
// Line 111 — COMPLEX mode router
- return needsComplexReasoning ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
+ return needsComplexReasoning ? 'claude-opus-4-7-20250219' : 'claude-haiku-4-5-20251001';

// Line 696 — ACTION mode (always uses Sonnet currently)
- model: 'claude-sonnet-4-6',
+ model: 'claude-opus-4-7-20250219',

// Alternative (mixed): Line 696 only if Scenario B recommended
- model: 'claude-sonnet-4-6',
+ model: mode === 'action' && message.length > 200 ? 'claude-opus-4-7-20250219' : 'claude-sonnet-4-6',
```

**Deployment:**
1. Create staging-opus-test branch
2. Make code changes
3. Deploy to Vercel preview
4. Run full Quinn test suite
5. If pass: merge staging → main

## Critical Dependencies

- **Quinn's detailed bug report** — required to run this test
  - Bug list with reproduction steps
  - Expected vs actual behavior
  - Severity classification
  - Category (extraction / role confusion / contract reasoning / intent / context / email / etc)

- **API key access** — ANTHROPIC_API_KEY must include Opus 4.7
  - Verify in Vercel env vars
  - Test: `curl -X POST https://api.anthropic.com/v1/messages -H "Authorization: Bearer $ANTHROPIC_API_KEY"`

## Next Steps

1. **Collect Quinn's bug report** (if not yet available)
   - File path: `Shepard-Ventures/Engineering/dossie-stress-test-2026-06-13.md`
   - Or: Quinn sends results to Telegram

2. **Run this test** (ETA ~1-2 hours including:)
   - Create staging-opus-test branch (+5 min)
   - Modify api/chat.js (+2 min)
   - Deploy to preview (+2 min)
   - Run Quinn's test suite (+40 min)
   - Analyze results (+10 min)

3. **Report recommendation** to Heath
   - Summary: X/35 bugs fixed (Y%)
   - Recommendation: SHIP / MIXED / STAY
   - Next action per recommendation

---

**Test prepared by:** Carter (Product Engineering)
**Date:** 2026-06-13 09:45 UTC
**Status:** Ready to execute pending Quinn's bug report
**ETA completion:** +2 hours from approval

**Contact:** @Carter in Telegram when results are needed
