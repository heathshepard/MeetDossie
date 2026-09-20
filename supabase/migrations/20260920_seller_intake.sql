-- SELLER INTAKE — the facts that make a net sheet computable instead of estimated.
--
-- Why this table exists
-- --------------------
-- 2026-09-16, 23 Nopalito. A full-price offer ($999,000) landed and the sellers
-- needed a net sheet the same day. Four lines on it were guesses:
--
--   title policy        $5,221  (promulgated rate table — the one defensible one)
--   HOA resale cert     $300    (invented; the addendum names a payer, not a figure)
--   escrow/tax cert/
--     deed prep         $450    ("standard Bexar County figures" — not sourced to
--                                the actual title company, because no title
--                                company had been named on the file)
--   property taxes      ???     The sellers' bill reads $0.00: homestead,
--                                disabled veteran and DV4 exemptions on file.
--                                But they had ALREADY MOVED OUT, so those
--                                exemptions no longer belong to that house, and
--                                TREC 20-19 ¶13 lets the title company prorate
--                                on the tax WITHOUT them. The email that went to
--                                the sellers had to say "somewhere between
--                                nothing and $15,000-20,000, confirm with the
--                                title company."
--
-- Every one of those was knowable when the listing was signed in April.
--
-- api/_lib/net-sheet-calc.js already computed the net and already accepted
-- mortgagePayoff / escrowFee / titlePolicyCost / hoaTransferFee. The math was
-- built. Nothing populated its inputs. That was the entire gap. This table is
-- what populates them.
--
-- The design rule, which every column here serves: a figure in front of a
-- seller is either sourced or labelled. Where a value is not captured, the net
-- sheet renders a visible "not yet confirmed" line and drops the figure out of
-- the total — it does NOT substitute a plausible number, and it does NOT
-- silently treat the blank as $0.00. Before this change the calculator
-- defaulted every missing input to 0 and then filtered zero-amount lines out of
-- the breakdown entirely, so an uncaptured HOA fee did not merely read as zero:
-- it vanished, and the net proceeds silently came out too high.
--
-- Field-by-field rationale lives in api/_lib/seller-intake-fields.js, which is
-- the source of truth for the question wording, the enum values and the mapping
-- from answer -> net sheet line. Keep the two in sync; the API validates
-- against that file, not against this DDL.
--
-- MULTI-TENANCY. `transactions` is shared by every Dossie customer. A leak of a
-- seller's payoff balance or tax exposure across tenants would be severe, so
-- this table is defended three ways:
--   1. RLS with an owner-only policy (auth.uid() = user_id).
--   2. UNIQUE (transaction_id) — one intake per file, no shadow rows.
--   3. A BEFORE INSERT/UPDATE trigger asserting that the referenced
--      transaction is owned by the SAME user_id. Without it, a caller could
--      attach an intake row carrying their own user_id to somebody else's
--      transaction_id, and any future join that walks transaction -> intake
--      would read across tenants. RLS alone does not catch that, because the
--      row genuinely does belong to the attacker.

CREATE TABLE IF NOT EXISTS public.seller_intake (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id                UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id                       UUID NOT NULL,

  -- PAYOFF ----------------------------------------------------------------
  -- 'owns_outright' is an affirmative captured fact, deliberately not the
  -- absence of a lender name. The Whytes own 23 Nopalito free and clear and
  -- that lived only in Heath's head; "no mortgage row" and "seller told me
  -- there is no mortgage" have to be distinguishable or the net sheet cannot
  -- honestly drop the payoff line.
  payoff_status                 TEXT CHECK (payoff_status IN ('owns_outright','has_mortgage','unsure')),
  payoff_lender_name            TEXT,
  payoff_balance_approx         NUMERIC(12,2),
  payoff_balance_as_of          DATE,
  has_second_lien               BOOLEAN,
  second_lien_details           TEXT,
  has_other_liens               BOOLEAN,
  other_liens_details           TEXT,
  other_liens_amount            NUMERIC(12,2),

  -- PROPERTY TAX — the $20,000 line ---------------------------------------
  tax_annual_amount             NUMERIC(12,2),
  tax_year                      INTEGER,
  tax_account_number            TEXT,
  -- Array, not a boolean. A property can carry homestead AND over-65 AND DV4
  -- at once, which is exactly the Nopalito stack that drove the bill to $0.00.
  tax_exemptions                TEXT[],
  occupancy_status              TEXT CHECK (occupancy_status IN
                                  ('seller_occupies','seller_moved_out','tenant_occupied','vacant_never_occupied')),
  moved_out_date                DATE,
  -- THE column. One phone call to the appraisal district in April; a $20,000
  -- question mark in September without it. When exemptions exist and the
  -- seller has moved out, this is the ONLY value the ¶13 proration may be
  -- computed from — resolvePropertyTaxProration() returns UNKNOWN rather than
  -- falling back to tax_annual_amount, because falling back is how you print
  -- "$0.00" and have it read as a fact.
  tax_amount_without_exemptions NUMERIC(12,2),
  ag_rollback_risk              TEXT CHECK (ag_rollback_risk IN ('yes','no','unsure')),

  -- HOA -------------------------------------------------------------------
  hoa_exists                    BOOLEAN,
  hoa_name                      TEXT,
  hoa_management_company        TEXT,
  hoa_contact                   TEXT,
  hoa_dues_amount               NUMERIC(12,2),
  hoa_dues_frequency            TEXT CHECK (hoa_dues_frequency IN ('monthly','quarterly','semiannual','annual')),
  hoa_resale_certificate_fee    NUMERIC(12,2),
  hoa_resale_certificate_payer  TEXT CHECK (hoa_resale_certificate_payer IN ('seller','buyer','split','per_contract','unknown')),
  hoa_transfer_fee              NUMERIC(12,2),
  hoa_transfer_fee_payer        TEXT CHECK (hoa_transfer_fee_payer IN ('seller','buyer','split','per_contract','unknown')),
  hoa_capital_contribution      NUMERIC(12,2),
  -- Master + sub-association is common in San Antonio and Boerne, and the
  -- second one is always the one that gets missed. TRUE forces the HOA line to
  -- UNKNOWN until the second association's fees are captured too.
  hoa_second_association        BOOLEAN,
  hoa_unpaid_assessments        NUMERIC(12,2),

  -- TITLE / ESCROW --------------------------------------------------------
  preferred_title_company       TEXT,
  title_closer_name             TEXT,
  title_closer_contact          TEXT,
  title_policy_cost_quoted      NUMERIC(12,2),
  title_policy_payer            TEXT CHECK (title_policy_payer IN ('seller','buyer','split','per_contract','unknown')),
  -- These four are the $450 lump, broken out so a partial quote reads as
  -- partial instead of as a total.
  escrow_fee_quoted             NUMERIC(12,2),
  tax_certificate_fee_quoted    NUMERIC(12,2),
  deed_prep_fee_quoted          NUMERIC(12,2),
  recording_fees_quoted         NUMERIC(12,2),
  title_quote_date              DATE,

  -- SURVEY (TREC ¶6.C) ----------------------------------------------------
  has_existing_survey           BOOLEAN,
  survey_date                   DATE,
  -- An existing survey with no T-47 is not a usable survey. "Has a survey" +
  -- "will not sign the affidavit" is a new survey at seller cost, and that
  -- combination is only visible if both are asked.
  will_sign_t47                 TEXT CHECK (will_sign_t47 IN ('yes','no','unsure')),
  survey_changes_since          TEXT,
  new_survey_cost_quoted        NUMERIC(12,2),

  -- LEASED ITEMS (TREC ¶4.B) ----------------------------------------------
  -- JSONB array of {type, lessor, monthly_payment, payoff_balance, transferable}.
  -- An empty array is meaningful: it is the seller affirmatively saying there
  -- are none, which lets the line resolve to a captured $0 instead of UNKNOWN.
  leased_items                  JSONB,
  leased_items_payoff_total     NUMERIC(12,2),

  -- HOME WARRANTY ---------------------------------------------------------
  will_offer_home_warranty      TEXT CHECK (will_offer_home_warranty IN ('yes','no','unsure')),
  home_warranty_cap             NUMERIC(12,2),

  -- OCCUPANCY / LEASE -----------------------------------------------------
  is_tenant_occupied            BOOLEAN,
  lease_end_date                DATE,
  security_deposit_held         NUMERIC(12,2),
  needs_leaseback               TEXT CHECK (needs_leaseback IN ('yes','no','unsure')),

  -- SPECIAL DISTRICTS -----------------------------------------------------
  in_mud_district               TEXT CHECK (in_mud_district IN ('yes','no','unsure')),
  in_pid_district               TEXT CHECK (in_pid_district IN ('yes','no','unsure')),
  pid_assessment_balance        NUMERIC(12,2),

  -- FIRPTA ----------------------------------------------------------------
  -- Up to 15% of the GROSS sale price under 26 U.S.C. §1445. On a $999,000
  -- sale that is $149,850 — larger than every other Nopalito guess combined.
  -- Asked explicitly so the net sheet never silently assumes a U.S. seller.
  seller_is_us_person           TEXT CHECK (seller_is_us_person IN ('yes','no','unsure')),

  -- PROVENANCE ------------------------------------------------------------
  -- When and how the answers were taken. 'listing_appointment' is the one that
  -- matters: the intake belongs at the table with the sellers, not as homework
  -- emailed afterward.
  captured_at                   TIMESTAMPTZ,
  captured_via                  TEXT CHECK (captured_via IN ('listing_appointment','chat','form','import')),
  notes                         TEXT,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT seller_intake_one_per_transaction UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS seller_intake_user_idx ON public.seller_intake (user_id);
CREATE INDEX IF NOT EXISTS seller_intake_transaction_idx ON public.seller_intake (transaction_id);

-- Cross-tenant guard. See the MULTI-TENANCY note in the header: RLS proves the
-- ROW belongs to the caller, it does not prove the TRANSACTION does.
CREATE OR REPLACE FUNCTION public.seller_intake_assert_same_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tx_owner UUID;
BEGIN
  SELECT user_id INTO tx_owner FROM public.transactions WHERE id = NEW.transaction_id;
  IF tx_owner IS NULL THEN
    RAISE EXCEPTION 'seller_intake: transaction % not found', NEW.transaction_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF tx_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'seller_intake: transaction owner does not match intake user_id'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seller_intake_same_owner ON public.seller_intake;
CREATE TRIGGER seller_intake_same_owner
  BEFORE INSERT OR UPDATE ON public.seller_intake
  FOR EACH ROW EXECUTE FUNCTION public.seller_intake_assert_same_owner();

ALTER TABLE public.seller_intake ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS seller_intake_owner_all ON public.seller_intake;
CREATE POLICY seller_intake_owner_all ON public.seller_intake
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.seller_intake IS
  'Listing-appointment seller intake: the facts that make a net sheet computable instead of estimated. One row per transaction. Field rationale and the answer -> net sheet mapping live in api/_lib/seller-intake-fields.js. A NULL here is UNKNOWN, never $0.00 — api/net-sheet.js renders it as a visible unconfirmed line and drops it from the total.';

COMMENT ON COLUMN public.seller_intake.tax_amount_without_exemptions IS
  'What the annual tax would be with NO exemptions. The only legal proration base under TREC ¶13 when exemptions are on file and the seller no longer occupies the property, because exemptions follow the person and the buyer does not inherit them. NULL + exemptions + moved out = the net sheet reports UNKNOWN. Never fall back to tax_annual_amount in that case: 23 Nopalito bills $0.00 under homestead + DV + DV4, and prorating that prints $0.00 as though it were a fact.';

COMMENT ON COLUMN public.seller_intake.occupancy_status IS
  'Do you still live here? The question that makes tax_exemptions mean anything. Exemptions follow the homestead; a seller who has moved out is exposed under TREC ¶13. Without this, "homestead: yes" reads as reassurance instead of a warning.';

COMMENT ON COLUMN public.seller_intake.payoff_status IS
  'owns_outright is an affirmative fact, not an empty lender field. The distinction is what lets the net sheet drop the payoff line honestly rather than defaulting it to zero.';

COMMENT ON COLUMN public.seller_intake.seller_is_us_person IS
  'FIRPTA (26 U.S.C. §1445). "no" or "unsure" forces the withholding line to UNKNOWN — up to 15% of GROSS sale price, remitted at closing. Dossie never estimates this; the exact figure needs the title company and the seller''s CPA.';
