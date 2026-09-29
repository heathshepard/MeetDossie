// api/_lib/chat-deal-deadlines.js
//
// The deal snapshot /api/chat hands to the model in action mode, plus the
// "today" it anchors relative dates against.
//
// This lives in _lib rather than inline in api/chat.js for one reason: it is
// the last hop before a contract deadline becomes something Dossie SAYS to a
// member, or writes into an email a member forwards to a client, and it has
// to be testable without booting the handler (chat.js is ESM + pulls in the
// Anthropic SDK; this module is pure and CJS). Tests:
// scripts/regression-chat-deadline-rollover.js.
//
// Background: until 2026-09-17, api/chat.js was the only client-facing path
// that did NOT require api/_lib/business-calendar.js — the eight other
// callers (scan-contract.js, cron-deadline-reminders.js,
// interactive-editor-update-field.js, dossie-update-and-refill.js and the
// migration helpers) all did. The model was simply handed
// contractEffectiveDate and optionDays and left to do the arithmetic in its
// head. Heath's 2026-09-10 Pfeiffers Gate run is what that produces: a
// Saturday 2026-09-12 funds-delivery deadline never rolled to Monday
// 2026-09-14, and a 9-day option period reported as ending 2026-09-16
// instead of 2026-09-18 — in an email addressed to a client. In Texas a
// blown option deadline can cost a buyer their earnest money.

'use strict';

const {
  TREC_5A_DELIVERY_DAYS,
  normalizeYMD,
  addCalendarDaysYMD,
  computeFundsDeliveryDueDates,
} = require('./business-calendar');

// "Today" for every relative-date instruction the model is given ("next
// Friday", "in 3 days"). Must be the calendar date in Texas, not UTC —
// new Date().toISOString() rolls over at 19:00/20:00 CT, so between then and
// midnight the model was told tomorrow's date and resolved every relative
// date a day early. Texas is one time zone (America/Chicago); the en-CA
// locale formats as YYYY-MM-DD.
const TEXAS_TZ = 'America/Chicago';
const TEXAS_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEXAS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayInTexasYMD(now = new Date()) {
  return TEXAS_YMD_FORMATTER.format(now);
}

// DEADLINE CHAIN — derive the TREC deadline dates the model would otherwise
// have to compute in its own head from contractEffectiveDate + optionDays.
// Deliberately the same derivation as the DEADLINE CHAIN block in
// api/scan-contract.js, over the same api/_lib/business-calendar.js, so the
// number Dossie SAYS on a call can never disagree with the number the scan
// wrote to the dossier or the number the reminder cron emails about.
//
// Per that module's ROLLOVER_APPLIES, the ¶5A(2) weekend/Texas-Legal-Holiday
// rollover is scoped ONLY to option-fee / earnest-money delivery. Option
// expiration, financing, appraisal, survey, HOA docs, possession and closing
// are fixed calendar dates and never roll — that asymmetry is exactly what an
// LLM gets wrong when left to reason about it, so it is computed here, not
// prompted.
//
// A date already stored on the dossier always wins over a derived one (same
// precedence as scan-contract.js); derivation is a backstop for rows that
// predate the column, not an override.
function deriveDealDeadlines(d) {
  const effective = normalizeYMD(d.contractEffectiveDate);
  const storedOptionExpiration = normalizeYMD(d.optionExpirationDate);

  if (!effective) {
    return {
      contractEffectiveDate: null,
      optionExpirationDate: storedOptionExpiration,
      optionFeeDueDate: null,
      earnestMoneyDueDate: null,
      fundsDeliveryDueDateRaw: null,
      fundsDeliveryRolled: false,
    };
  }

  const optionDays = typeof d.optionDays === 'number' && d.optionDays > 0 ? d.optionDays : null;
  const optionExpirationDate = storedOptionExpiration
    || (optionDays ? addCalendarDaysYMD(effective, optionDays) : null);

  // ¶5.A: effective + 3 calendar days, THEN ¶5A(2) rollover.
  const rawDeliveryDate = addCalendarDaysYMD(effective, TREC_5A_DELIVERY_DAYS);
  const funds = computeFundsDeliveryDueDates(effective);

  return {
    contractEffectiveDate: effective,
    optionExpirationDate,
    optionFeeDueDate: funds.option_fee_due_date,
    earnestMoneyDueDate: funds.earnest_money_due_date,
    fundsDeliveryDueDateRaw: rawDeliveryDate,
    fundsDeliveryRolled: funds.option_fee_due_date !== rawDeliveryDate,
  };
}

// Normalize a stored date column to 'YYYY-MM-DD' (or null) before it reaches
// the model, so it never has to reformat an ISO timestamp by hand.
const ymd = (value) => normalizeYMD(value);

function compactDealsForAction(deals) {
  if (!Array.isArray(deals)) return [];
  return deals
    .filter((d) => d && d.id)
    .slice(0, 50)
    .map((d) => ({
      id: d.id,
      propertyAddress: d.propertyAddress || null,
      cityStateZip: d.cityStateZip || null,
      buyerName: d.buyerName || null,
      sellerName: d.sellerName || null,
      stage: d.stage || null,
      status: d.status || null,
      role: d.role || null,
      salePrice: typeof d.salePrice === 'number' ? d.salePrice : null,
      earnestMoney: typeof d.earnestMoney === 'number' ? d.earnestMoney : null,
      optionFee: typeof d.optionFee === 'number' ? d.optionFee : null,
      optionDays: typeof d.optionDays === 'number' ? d.optionDays : null,
      financingDays: typeof d.financingDays === 'number' ? d.financingDays : null,
      // Every date below is normalized to YYYY-MM-DD and, where TREC derives
      // it, COMPUTED here rather than left to the model. See
      // deriveDealDeadlines() and the DEADLINE AUTHORITY prompt block in
      // api/chat.js.
      ...deriveDealDeadlines(d),
      closingDate: ymd(d.closingDate),
      titleCompany: d.titleCompany || null,
      titleOfficerName: d.titleOfficerName || null,
      titleOfficerEmail: d.titleOfficerEmail || null,
      titleOfficerPhone: d.titleOfficerPhone || null,
      lenderName: d.lenderName || null,
      loanOfficerName: d.loanOfficerName || null,
      loanOfficerEmail: d.loanOfficerEmail || null,
      loanOfficerPhone: d.loanOfficerPhone || null,
      hoaName: d.hoaName || null,
      hoaPhone: d.hoaPhone || null,
      hoaManagementCompany: d.hoaManagementCompany || null,
      inspectorName: d.inspectorName || null,
      inspectorPhone: d.inspectorPhone || null,
      inspectorEmail: d.inspectorEmail || null,
      mlsNumber: d.mlsNumber || null,
      bedrooms: d.bedrooms ?? null,
      bathrooms: d.bathrooms ?? null,
      sqft: d.sqft ?? null,
      yearBuilt: d.yearBuilt ?? null,
      possessionDate: ymd(d.possessionDate),
      appraisalDeadline: ymd(d.appraisalDeadline),
      surveyDeadline: ymd(d.surveyDeadline),
      hoaDocumentDeadline: ymd(d.hoaDocumentDeadline),
      loanApprovalDeadline: ymd(d.loanApprovalDeadline),
      // Negotiated-detail fields from the scanned executed contract — see
      // ANSWERING QUESTIONS ABOUT NEGOTIATED CONTRACT DETAILS in chat.js.
      // contractScanned tells the assistant whether an absent field means
      // "the contract doesn't say" vs "no contract has been scanned yet."
      contractScanned: Boolean(d.contractExtractedAt),
      surveyPayer: d.surveyPayer || null,
      homeWarrantyTerms: d.homeWarrantyTerms || null,
      repairsSummary: d.repairsSummary || null,
      fixturesIncluded: Array.isArray(d.fixturesIncluded) && d.fixturesIncluded.length ? d.fixturesIncluded : null,
      fixturesExcluded: Array.isArray(d.fixturesExcluded) && d.fixturesExcluded.length ? d.fixturesExcluded : null,
      specialProvisions: d.specialProvisions || null,
      expenseAllocation: (d.expenseAllocation && typeof d.expenseAllocation === 'object' && Object.keys(d.expenseAllocation).length) ? d.expenseAllocation : null,
      prorations: d.prorations || null,
      addendaAttached: Array.isArray(d.addendaAttached) && d.addendaAttached.length ? d.addendaAttached : null,
      financingTerms: (d.financingTerms && typeof d.financingTerms === 'object' && Object.keys(d.financingTerms).length) ? d.financingTerms : null,
    }));
}

module.exports = {
  TEXAS_TZ,
  todayInTexasYMD,
  deriveDealDeadlines,
  compactDealsForAction,
  ymd,
};
