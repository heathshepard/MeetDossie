-- Migration: Normalize transaction stage enum and add CHECK constraint
-- Date: 2026-06-13
-- Purpose: Fix stage enum drift — normalize hyphenated variants and add CHECK constraint
--          Canonical stages: pre-contract, active-listing, under-contract, option-period,
--          inspection, financing, title-survey, clear-to-close, closed, terminated

-- Normalize underscore variants to hyphens
UPDATE transactions SET stage = 'clear-to-close' WHERE stage = 'clear_to_close';
UPDATE transactions SET stage = 'under-contract' WHERE stage = 'under_contract';
UPDATE transactions SET stage = 'title-survey' WHERE stage = 'title_survey';
UPDATE transactions SET stage = 'option-period' WHERE stage = 'option_period';

-- Normalize pre-listing to active-listing (same semantic meaning)
UPDATE transactions SET stage = 'active-listing' WHERE stage = 'pre-listing';

-- Add CHECK constraint to enforce canonical stage names
ALTER TABLE transactions
ADD CONSTRAINT transactions_stage_valid CHECK (
  stage IN (
    'pre-contract',
    'active-listing',
    'under-contract',
    'option-period',
    'inspection',
    'financing',
    'title-survey',
    'clear-to-close',
    'closed',
    'terminated'
  )
);
