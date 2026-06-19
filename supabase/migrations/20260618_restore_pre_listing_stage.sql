-- Migration: Restore 'pre-listing' as a valid stage value
-- Date: 2026-06-18
-- Purpose: Re-allow pre-listing in transactions.stage CHECK constraint.
--
-- Context: 20260613_normalize_stage_enum.sql migrated all existing pre-listing
-- rows to active-listing and dropped pre-listing from the canonical set. Brittney
-- and other agents use Pre-Listing as a distinct pipeline column for seller-side
-- warm leads BEFORE MLS goes live. The 2026-06-15 bundle hotfix added the column
-- back in the UI but the DB constraint prevented writes. Twice the column has
-- regressed because the hotfix lived in the compiled bundle only.
--
-- This migration is purely additive: adds one allowed value, invalidates no
-- existing rows. Safe to run live.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_stage_valid;

ALTER TABLE transactions
ADD CONSTRAINT transactions_stage_valid CHECK (
  stage IN (
    'pre-listing',
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
