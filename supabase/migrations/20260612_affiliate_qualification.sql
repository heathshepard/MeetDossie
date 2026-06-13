-- Add 6-month qualification period columns to affiliate_referrals
ALTER TABLE IF EXISTS affiliate_referrals
  ADD COLUMN IF NOT EXISTS payout_eligible_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;

-- Update CHECK constraint to include new qualification states
ALTER TABLE affiliate_referrals DROP CONSTRAINT IF EXISTS affiliate_referrals_status_check;
ALTER TABLE affiliate_referrals ADD CONSTRAINT affiliate_referrals_status_check
  CHECK (status IN ('clicked','signed_up','pending_qualification','qualified','paid','rewarded','reversed'));
