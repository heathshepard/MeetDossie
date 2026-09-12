'use strict';

// scripts/_lib/mls-status-taxonomy.js
//
// Single source of truth for SABOR/connectMLS status-code classification,
// shared by scripts/listing-marketing-status-sync.js and
// scripts/_lib/listing-post-compliance-gate.js. Previously duplicated
// inline in status-sync.js only -- pulled out 2026-09-11 so the compliance
// gate can classify a status code the same way the live sync does, instead
// of re-guessing wording rules.
//
// Per memory/sabor-mls-status-codes.md -- confirmed via the in-app
// "Change Status" picker, never expanded from guesswork.

const ACTIVE_FAMILY = new Set(['NEW', 'ACT', 'BOM', 'EXT', 'PCH', 'CS']); // New, Active, Back on Market, Extended, Price Change, Coming Soon
// Active-family-but-functionally-under-contract -- do NOT market these.
const UNDER_CONTRACT_ACTIVE_FAMILY = new Set(['AO', 'ARFR', 'AAR']); // Active Option, Active RFR, Active/Application Received
const OFF_MARKET = new Set(['PEN', 'PSB', 'SLD', 'EXP', 'CAN', 'WD', 'RNTD']);

function isPostableActive(statusCode) {
  return ACTIVE_FAMILY.has(statusCode) && !UNDER_CONTRACT_ACTIVE_FAMILY.has(statusCode) && !OFF_MARKET.has(statusCode);
}

module.exports = { ACTIVE_FAMILY, UNDER_CONTRACT_ACTIVE_FAMILY, OFF_MARKET, isPostableActive };
