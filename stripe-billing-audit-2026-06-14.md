# STRIPE BILLING AUDIT — DRY RUN
**Date:** 2026-06-14
**Status:** DRY RUN (No charges executed yet)

---

## SUMMARY

7 customers have Stripe customer records but **NO recurring subscription ID** (`stripe_subscription_id` is NULL).

| Status | Count | Revenue Impact |
|--------|-------|-----------------|
| NO Stripe Subscription ID | 7 | $203/mo unrecovered |
| Billing Current | 8 | $232/mo ✅ |
| **TOTAL FOUNDING** | **15** | **$435/mo** |

---

## CUSTOMERS MISSING STRIPE SUBSCRIPTION ID (Ready to Fix)

All 7 have Stripe customer records AND have paid their initial $29 (via checkout or invoice). They just need a recurring subscription created.

### 1. **Natalie Megerson** — `natalie@localchoicegroup.com`
- Stripe Customer ID: `cus_UYs8AwZ6sWFA4w`
- Subscription Status: active (current_period_end: 2026-06-22)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 2. **Zelda Cain** — `zelda@a2zrealestateconsultants.com`
- Stripe Customer ID: `cus_UYTPKySd3YCa0W`
- Subscription Status: active (current_period_end: 2026-06-21)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 3. **Amanda Nuckles** — `amanda@amandanuckles.com`
- Stripe Customer ID: `cus_UYQSHs1waN5ttH`
- Subscription Status: active (current_period_end: 2026-06-20)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 4. **Cecilia Whitley** — `cecilia@sterlingassociatesre.com`
- Stripe Customer ID: `cus_UYMnDLsF8JFPP6`
- Subscription Status: active (current_period_end: 2026-06-20)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 5. **Miki Mccarthy** — `mikirgvrealtor@gmail.com`
- Stripe Customer ID: `cus_UYMCvH2WrDxGy2`
- Subscription Status: active (current_period_end: 2026-06-20)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 6. **Kim Herrera** — `kimberlyherrera@kw.com`
- Stripe Customer ID: `cus_UXthETBewrALK2`
- Subscription Status: active (current_period_end: NULL)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription

### 7. **Tiffany Gill** (duplicate entry) — `tgill@phyllisbrowning.com`
- Stripe Customer ID: `cus_UWlrdrLcCjrxHG` (shared with tiffanygillrealtor)
- Subscription Status: active (current_period_end: 2026-06-16)
- Stripe Subscription ID: **NULL** ← PROBLEM
- Action: Create subscription OR investigate duplicate

---

## CUSTOMERS WITH BILLING CURRENT

These 8 have proper Stripe subscription IDs and are recurring correctly:

1. **Brittney YBarbo** — `brittney@setxrealty.com` — sub_1TU6PEL920SKTEEim9a1rKoR — expires 2026-06-06 ⚠️ PAST DUE
2. **Kay Suzanne Page** — `k.suzanne.page@gmail.com` — sub_1TSOeFL920SKTEEiTkMJOiaF — expires 2026-06-01 ⚠️ PAST DUE
3. **Terry Katz** — `michellesellshouston@gmail.com` — sub_1TZFtxL920SKTEEi3lutifH8 — expires 2026-06-20 ✅
4. **Jennifer Beltran** — `jenn.casamiateam@gmail.com` — sub_1TZyjUL920SKTEEitnzGZVfd — expires 2026-06-22 ✅
5. **Lisa Nilsson** — `lisanilssontx@gmail.com` — sub_1TbsGbL920SKTEEiy1KWatM1 — expires NULL (new)
6. **Tiffany Gill** (primary) — `tiffanygillrealtor@gmail.com` — sub_1TXiJRL920SKTEEi9DzVpx0F — expires 2026-06-16 ✅

---

## RECOMMENDED ACTIONS

### IMMEDIATE (Do this FIRST)
1. **For the 7 with no subscription ID:** Create a Stripe subscription for each using:
   - `stripe_customer_id` from our DB
   - `price_1TPxxNL920SKTEEiN7Gphq8T` (founding price)
   - Charge immediately (trial_end = today, so first charge is due now)
   - Update our DB `subscriptions.stripe_subscription_id` with the result

2. **For Brittney + Suzanne (PAST DUE):**
   - Check Stripe to see if they have a valid payment method on file
   - If yes and past due: retry the charge
   - If no: send them an email to update payment method

### EXPECTED IMMEDIATE REVENUE
- 7 customers × $29 = **$203** recovered from first charge
- Brittney + Suzanne retry: **$58** (if payment methods are valid)
- **Total potential: $261 in immediate charges**

---

## NEXT STEP

**Carter:** Wait for Heath's approval (per-batch or all-at-once) before executing charges.

**Status:** DRY RUN complete. Ready for Stage 2 execution on your command.
