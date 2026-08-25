// api/_lib/fill-trec-20-19.js
//
// Shared coordinate-fill pipeline for TREC 20-19 (One to Four Family
// Residential Contract, Resale — 2026-07-01 effective flat PDF).
//
// 2026-07-13 CARTER — extracted from api/fill-form.js so
// /api/interactive-editor-download-pdf can render the SAME filled PDF as
// /api/fill-form. Previously the download endpoint returned the blank
// template, which meant Preview + Download in the Interactive Editor
// showed empty forms. See .tmp/dossie-sign-2026-07-13-BLOCKED/.
//
// 2026-08-19 BROKERAGE — fourth-pass root-cause fix session (Kanika/Ketan
// three-property offer set: Old Homestead / Low Oak / Royal Crescent).
// Every checkbox mapping in this file was independently re-verified from
// scratch against the LIVE blank asset (.tmp/brokerage-work/blank-resale-
// 20-19.pdf) via a fresh, correctly page-attributed pdf-lib field dump
// (.tmp/brokerage-work/all-fields-FRESH.txt, built by a one-off script,
// NOT the earlier all-fields.txt which mis-sorted rows and caused prior
// passes to misjudge which page a field visually renders on) cross-
// referenced against actual rendered page PNGs
// (pdftoppm -png -r 150 on the blank template). Confirmed correct as
// already coded: survey option (¶6C), title policy main expense (¶6A
// opening), HOA membership is/is not (¶6E(2) — actually on page 3, not
// page 2 despite the generic-looking field names), possession (¶10A),
// and the ¶22 Third Party Financing / Appraisal Termination / HOA
// addendum checkboxes. NEWLY ADDED this pass (previously silently never
// fired, root cause of several "found blank" reports): ¶6A(8)(ii)
// "shortages in area at Seller's/Buyer's expense" sub-checkbox, ¶7D
// "Buyer accepts the Property As Is" checkbox, ¶7B Seller's Disclosure
// Notice received/not-received + 14-day blank, ¶7I Seller's Water
// Disclosure received/not-received + 14-day blank, ¶12B brokerage
// compensation checkboxes (leading item box + $/% sub-choice — the text
// amount was always being drawn but NO checkbox was ever checked next to
// it), ¶22 Lead-Based Paint Addendum checkbox, and per-page running
// header ("Contract Concerning ___ (Address of Property)") which this
// file previously only drew on page 1's ¶2A LAND blank — there was no
// mechanism at all for the 11 separate per-page header blanks on pages
// 2-12. ALSO REMOVED: execution_day/execution_month/execution_year_2digit
// autofill — this was firing on EVERY build (using contract_effective_date
// OR closing_date as a fallback) despite Heath's explicit, repeated,
// standing instruction that the EXECUTED/effective-date blank must always
// be left blank on an outgoing offer. This was the actual root cause of
// that specific checklist item failing on every prior pass.
//
// TREC 20-19 is a FLAT-LOOKING but ACTUALLY-HAS-AN-ACROFORM PDF (280 real
// fields including ~61 real checkboxes, confirmed via pdf-lib
// form.getFields() against the live asset — despite this file's own
// stale header comment below claiming "0 AcroForm fields"). This module
// draws text at pre-extracted coordinates from
// api/_assets/trec-20-19-field-coords.json for most blanks, and uses the
// real AcroForm checkbox fields (via applyResaleContractCheckboxes) for
// checkboxes. Coords are in pdf-lib bottom-left origin.
//
// PUBLIC API
//   fillTrec2019(pdfDoc, fieldValues) — mutates the pdfDoc in place.
//   formatMoney(value)                — "425000" -> "425,000"
//   formatDate(iso)                   — "2026-08-15" -> "08/15/2026"

const TREC_20_19_COORDS = (() => {
  try {
    return require('../_assets/trec-20-19-field-coords.json');
  } catch (e) {
    console.warn('[fill-trec-20-19] Failed to load 20-19 coordinates:', e && e.message);
    return { fields: {} };
  }
})();

function formatDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  return m[2] + '/' + m[3] + '/' + m[1];
}

function formatMoney(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value == null ? '' : value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// 2026-08-19 BROKERAGE FIX — per-page running header.
// "Contract Concerning ___ (Address of Property)" repeats on pages 2-12
// (page 1 is the title page, no header). Each page's header is its OWN
// separate real AcroForm text field with a garbled/inconsistent name (same
// disease as every other field on this asset) but a consistent rect
// (x~127-130, y~749-764) at the very top margin. Verified page-by-page
// against the live asset via all-fields-FRESH.txt + rendered PNGs,
// 2026-08-19. Order below is page 2 -> page 12.
// ---------------------------------------------------------------------------
const HEADER_FIELDS_BY_PAGE = {
  2: 'Page 2 of 10',
  3: 'Page 3 of 10',
  4: 'Contract Concerning',
  5: 'Contract Concerning_2',
  6: 'Contract Concerning_3',
  7: 'Page 7 of 10',
  8: 'Contract Concerning_4',
  9: 'Address of Property',
  10: 'Addr of Prop',
  11: 'Address of Property_2',
  12: 'Address of Property_26',
};

function fillRunningHeader(pdfDoc, fullAddress) {
  if (!fullAddress) return;
  let form;
  try {
    form = pdfDoc.getForm();
  } catch (e) {
    console.warn('[fill-trec-20-19] no AcroForm on this PDF, skipping header fill:', e && e.message);
    return;
  }
  for (const page of Object.keys(HEADER_FIELDS_BY_PAGE)) {
    const fieldName = HEADER_FIELDS_BY_PAGE[page];
    try {
      const field = form.getTextField(fieldName);
      field.setText(String(fullAddress).slice(0, 200));
    } catch (e) {
      console.warn('[fill-trec-20-19] could not set header field on page', page, '(field', JSON.stringify(fieldName) + '):', e && e.message);
    }
  }
}

/**
 * Fill a TREC 20-19 (flat) PDF with `fv` values. Mutates pdfDoc in place.
 * See fill-form.js fillResaleContractCoordinate() history — this is the
 * canonical implementation now, both fill-form.js and
 * interactive-editor-download-pdf.js call this.
 */
async function fillTrec2019(pdfDoc, fv) {
  const pages = pdfDoc.getPages();
  const coordMap = TREC_20_19_COORDS.fields || {};
  // Embedded once per fill for word-wrap width measurement (escrow agent
  // address 2-line wrap, 2026-08-19 fix). page.drawText() with no font
  // option auto-embeds Helvetica anyway, so this doesn't add a new font to
  // the document -- it just gives us the same metrics ahead of time.
  const { StandardFonts } = require('pdf-lib');
  const wrapFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  function drawFieldText(fieldName, value, options = {}) {
    if (value == null || value === '') return;
    const coord = coordMap[fieldName];
    if (!coord) {
      console.warn('[fill-trec-20-19] No coordinate for field:', fieldName);
      return;
    }
    if (coord.page < 1 || coord.page > pages.length) {
      console.warn('[fill-trec-20-19] Page out of range for field:', fieldName, 'page:', coord.page);
      return;
    }
    const page = pages[coord.page - 1];
    const fontSize = options.fontSize || coord.fontSize || 10;
    try {
      page.drawText(String(value).slice(0, 200), {
        x: coord.x,
        y: coord.y,
        size: fontSize,
        ...options,
      });
    } catch (e) {
      console.warn('[fill-trec-20-19] drawText failed for', fieldName + ':', e && e.message);
    }
  }

  // Splits `text` at a word boundary so the first line fits within
  // `maxWidth` at `fontSize` (measured with the real embedded font, not a
  // char-count guess). Returns [line1, line2] -- line2 is '' when the
  // whole string already fits on one line.
  function wrapTextToWidth(text, fontSize, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    let line1 = '';
    let i = 0;
    for (; i < words.length; i++) {
      const candidate = line1 ? line1 + ' ' + words[i] : words[i];
      if (wrapFont.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        line1 = candidate;
      } else {
        break;
      }
    }
    if (!line1 && words.length) { line1 = words[0]; i = 1; } // single word longer than maxWidth -- don't drop it
    return [line1, words.slice(i).join(' ')];
  }

  // PARTIES — buyer_name, seller_name
  drawFieldText('buyer_name', fv.buyer_name);
  drawFieldText('seller_name', fv.seller_name);

  // PROPERTY
  // 2026-08-19 BROKERAGE FIX -- root cause of the "legal description and
  // city are swapped" bug (Old Homestead / Low Oak / Royal Crescent all
  // affected, same shared engine). Confirmed via pdftotext -bbox against
  // the blank TREC 20-19 asset: paragraph 2A reads "A. LAND: Lot ___ Block
  // ___, [Addition Name] Addition, City of ___, County of ___, Texas,
  // known as ___ (address/zip code), or as described on attached exhibit."
  // The coordinate map's 'addition_name' key (x=158.72, y=605.98) was
  // ALWAYS the City blank (its own notes said so), but the JS variable
  // name matched the build scripts' fv.addition_name (the subdivision
  // text, e.g. "Colonial Oaks #3, NCB 13936") -- so the subdivision name
  // was drawn into the City blank, and there was no coordinate at all for
  // the real addition-name blank (tail of the Lot/Block line). Separately,
  // fv.city_state_zip was being drawn off in blank margin space to the
  // right of "or as described on attached exhibit." -- not a real blank on
  // this form at all. Fixed: addition name -> new 'addition_name' coord
  // (Lot/Block line tail); city (parsed from city_state_zip) -> renamed
  // 'city_name' coord (the real City blank); full street+city+zip -> the
  // 'property_address' blank itself (that's what "known as ___
  // (address/zip code)" actually means -- full known-as address, not just
  // street). See trec-20-19-field-coords.json notes on 'city_name' /
  // 'addition_name' for the bbox verification.
  const knownAsAddress = fv.property_full
    || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ')
    || fv.property_address || '';
  drawFieldText('property_address', knownAsAddress);
  const cityOnly = String(fv.city_state_zip || '').split(',')[0].trim();
  drawFieldText('city_name', fv.city || cityOnly);
  drawFieldText('county', fv.county);

  // RUNNING HEADER — every page 2-12. See HEADER_FIELDS_BY_PAGE comment
  // above. Uses the same full-address string task checklists refer to as
  // "Contract Concerning [address]".
  const fullAddressForHeader = fv.property_full
    || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  fillRunningHeader(pdfDoc, fullAddressForHeader);

  // LEGAL DESCRIPTION
  // 'legal_description' coordinate (x=30, y=736) is DOCUMENTED in
  // trec-20-19-field-coords.json's own notes as "fallback annotation (top
  // margin -- used only when lot/block/addition missing; no discrete blank
  // on flat 20-19)". Only draw the margin fallback when lot/block/addition
  // are ALL missing (i.e. there's no other way to identify the property on
  // this form). When lot/block/addition ARE supplied (the normal case),
  // they are the authoritative legal identification and legal_description
  // is intentionally NOT also drawn.
  const hasLotBlockAddition = !!(fv.legal_lot || fv.legal_block || fv.addition_name);
  if (!hasLotBlockAddition) {
    drawFieldText('legal_description', fv.legal_description);
  }
  drawFieldText('legal_lot', fv.legal_lot);
  drawFieldText('legal_block', fv.legal_block);
  drawFieldText('addition_name', fv.addition_name);
  drawFieldText('exclusions', fv.exclusions);

  // SALES PRICE (Section 3)
  let cashPortion = (fv.down_payment_amt != null && fv.down_payment_amt !== '') ? Number(fv.down_payment_amt) : null;
  if (cashPortion == null && fv.sale_price != null && fv.loan_amount != null) {
    cashPortion = Number(fv.sale_price) - Number(fv.loan_amount);
  }
  drawFieldText('down_payment_amt', cashPortion != null ? formatMoney(cashPortion) : '');
  drawFieldText('loan_amount', Number(fv.loan_amount) > 0 ? formatMoney(fv.loan_amount) : '');
  drawFieldText('sale_price', fv.sale_price != null && fv.sale_price !== '' ? formatMoney(fv.sale_price) : '');
  drawFieldText('additional_cash_closing', fv.additional_cash_closing);

  // POSSESSION (Section 10.A)
  // 2026-08-19 BROKERAGE FIX -- REMOVED the 'possession' text draw. There
  // is no real blank on this form next to the "10. POSSESSION:" heading --
  // verified against both the blank template and the real zipForm
  // rendering of this same form, 2026-08-19: the paragraph goes straight
  // from the heading into "A. BUYER'S POSSESSION: ... [ ] upon closing and
  // funding [ ] according to a temporary residential lease..." with no
  // annotation line in between. The word ("Upon Closing"/"Lease") this
  // used to draw there was a stray floating word with no corresponding
  // form field, redundant with (and positioned right next to, not on) the
  // real checkbox election below it. The checkbox election itself, via
  // applyResaleContractCheckboxes() below, is the only real field for
  // this paragraph and is unaffected by this removal.

  // EARNEST MONEY / TITLE (Section 5)
  drawFieldText('earnest_money', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
  drawFieldText('escrow_agent_name', fv.escrow_agent_name || fv.title_company || '');
  // 2026-08-19 BROKERAGE FIX -- root cause of the escrow-agent address
  // overflowing past the page's right edge when long. The form provides
  // exactly TWO real AcroForm-verified blanks for this address (confirmed
  // 2026-08-19 via a page-2 field-rect dump against the live blank asset):
  // line1 = "undefined_7"-mislabeled field at real rect (x~404, w~158,
  // y~705) -- the end of the "...(Escrow Agent) at ___" line; line2 =
  // "undefined_7" sibling at real rect (x~75, w~151, y~695) -- the blank
  // immediately before the printed "(address): $" text on the next
  // printed line. Both are SHORT (line2 in particular has real capacity
  // for only ~25-28 characters at 10pt Helvetica) and line2 butts directly
  // up against "(address): $[earnest money]" -- there is no third blank.
  // PRIOR BUG: line1 was wrapped to its real width, but line2 was drawn
  // with ALL remaining text and NO width limit at all, so any address
  // whose remainder (after line1) exceeded line2's real ~150pt capacity
  // ran straight through the printed "(address): $" label and into the
  // earnest-money/option-fee amounts drawn immediately after it. Fixed:
  // wrap the remainder onto line2 against line2's OWN real maxWidth too,
  // and drop anything past that (matches what a human filling this by
  // hand would do -- abbreviate rather than write off the form; there is
  // no physical space for a third line on the real document either).
  const escrowAddrFull = fv.escrow_agent_address_line1 || fv.escrow_agent_address || fv.title_company_address || '';
  if (escrowAddrFull) {
    const line1Coord = coordMap.escrow_agent_address_line1;
    const line2Coord = coordMap.escrow_agent_address_line2;
    const fontSizeEscrow = (line1Coord && line1Coord.fontSize) || 10;
    const maxWidthLine1 = (line1Coord && line1Coord.maxWidth) || 158;
    const maxWidthLine2 = (line2Coord && line2Coord.maxWidth) || 150;
    const [escrowLine1, remainder] = wrapTextToWidth(escrowAddrFull, fontSizeEscrow, maxWidthLine1);
    const [escrowLine2] = remainder ? wrapTextToWidth(remainder, fontSizeEscrow, maxWidthLine2) : [''];
    drawFieldText('escrow_agent_address_line1', escrowLine1);
    if (escrowLine2) drawFieldText('escrow_agent_address_line2', escrowLine2);
  }
  drawFieldText('title_company', fv.title_company || '');
  // 2026-08-19 BROKERAGE FIX -- REMOVED the 'title_company_address' draw.
  // There is no real blank on this form for a separate Title Company
  // address -- ¶6A only prints "...issued by ___(Title Company)" (name
  // only, verified against the real zipForm rendering of this same form,
  // 2026-08-19). The coordinate this used to draw at (page 2, bottom
  // margin y=45) was never a real field either -- its own JSON notes say
  // "documentation coord" -- and collided with the page footer
  // ("Initialed for identification by Buyer___ and Seller___ / TREC NO.
  // 20-19") whenever a value was supplied. Any address value is already
  // carried through the escrow_agent_address fallback chain above (the
  // Title Company IS the Escrow Agent on nearly every TREC deal), so no
  // information is lost by not drawing it a second time here.
  drawFieldText('earnest_receipt_date', fv.earnest_receipt_date ? formatDate(fv.earnest_receipt_date) : '');

  // ¶5A(1) Additional earnest money
  drawFieldText('additional_earnest_money',
    fv.additional_earnest_money != null && fv.additional_earnest_money !== ''
      ? formatMoney(fv.additional_earnest_money) : '');
  drawFieldText('additional_earnest_days',
    fv.additional_earnest_days != null && fv.additional_earnest_days !== ''
      ? String(fv.additional_earnest_days) : '');

  // OPTION FEE / OPTION PERIOD
  drawFieldText('option_fee', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
  const optPeriod = (fv.option_period_days != null && fv.option_period_days !== '') ? String(fv.option_period_days)
    : (fv.option_days != null && fv.option_days !== '') ? String(fv.option_days) : '';
  drawFieldText('option_period_days', optPeriod);

  // TITLE OBJECTION / SURVEY (Section 6)
  const titleObjDays = fv.title_objection_days != null && fv.title_objection_days !== ''
    ? String(fv.title_objection_days) : '10';
  drawFieldText('title_objection_days', titleObjDays);

  drawFieldText('title_objection_activity', fv.title_objection_activity || fv.permitted_use || '');

  // ¶6C Survey — three separate days blanks
  const surveyDaysSeller = fv.survey_days_seller != null && fv.survey_days_seller !== ''
    ? String(fv.survey_days_seller) : (fv.survey_furnish_days != null && fv.survey_furnish_days !== ''
      ? String(fv.survey_furnish_days) : '');
  drawFieldText('survey_days_seller', surveyDaysSeller);

  const surveyDaysBuyer = fv.survey_days_buyer != null && fv.survey_days_buyer !== ''
    ? String(fv.survey_days_buyer) : '';
  drawFieldText('survey_days_buyer', surveyDaysBuyer);

  const surveyDaysNew = fv.survey_days_new != null && fv.survey_days_new !== ''
    ? String(fv.survey_days_new) : '';
  drawFieldText('survey_days_new', surveyDaysNew);

  // PROPERTY CONDITION (Section 7)
  drawFieldText('required_repairs', fv.required_repairs || '');
  drawFieldText('repairs_additional', fv.repairs_additional || '');
  drawFieldText('service_contract_amount', fv.service_contract_amount ? formatMoney(fv.service_contract_amount) : '');

  // ¶7B(2) Seller's Disclosure Notice days and ¶7I(2) Seller's Water
  // Disclosure days are drawn ONLY by drawParagraph7And12BBlanks() below
  // (gated on fv.seller_disclosure_received === false / fv.water_
  // disclosure_received === false, paired with the checkbox logic).
  // 2026-08-19 BROKERAGE FIX -- this file used to ALSO draw both values
  // here, unconditionally, at near-identical coordMap coordinates
  // (water_disclosure_days: x=429.62,y=276.53 vs the verified water_
  // disclosure_days_blank: x=432,y=274 -- ~2.5pt apart). Two draws of the
  // same "14" almost on top of each other rendered as a doubled/overlapping
  // "1|4|4" glyph -- the actual root cause of the reported duplicated-digit
  // bug. Do not re-add a second draw call for either of these two fields.

  // ¶8 Broker relationship disclosure
  // 2026-08-20 CARTER — the editor now sends this as a real, sometimes-long
  // sentence (concatenation of its own broker_disclosure_line1/2 fields via
  // trec-20-19-editor-field-translate.js), where previously the field was
  // effectively never populated. drawFieldText() has no wrap/clip logic, so
  // an unbounded string ran straight off the right edge of the page — found
  // in real-browser verification (real click-through + rendered PNG of the
  // downloaded PDF), not code review. Root cause: the stored coord's
  // maxWidth (200pt) is simply wrong for this field's x position (497.43pt
  // on a 612pt-wide page — only ~106pt of real room exists, not 200). Rather
  // than trust that stale value, clamp to the PAGE'S ACTUAL width at fill
  // time (provably correct) and truncate there, same "abbreviate rather
  // than write off the form" rule already used for the escrow address.
  // KNOWN FOLLOW-UP: this form's printed ¶8A has two additional blank
  // continuation lines below this one with no coordinates mapped yet for
  // them — a long disclosure still truncates to one line rather than
  // wrapping onto them. Needs the same bbox-verification pass the other
  // 2026-08-19 checkbox fixes used before adding new coordinates; not done
  // here since that would be guessing, not verifying.
  {
    const brokerDisclosureText = fv.broker_relationship_disclosure || '';
    if (brokerDisclosureText) {
      const coord = coordMap.broker_relationship_disclosure;
      const fontSize = (coord && coord.fontSize) || 9;
      const storedMaxWidth = (coord && coord.maxWidth) || 200;
      const pageForField = coord && coord.page >= 1 && coord.page <= pages.length
        ? pages[coord.page - 1] : null;
      const realRoom = (pageForField && coord)
        ? Math.max(0, pageForField.getWidth() - coord.x - 8)
        : storedMaxWidth;
      const maxWidth = Math.min(storedMaxWidth, realRoom);
      const [firstLine] = wrapTextToWidth(brokerDisclosureText, fontSize, maxWidth);
      drawFieldText('broker_relationship_disclosure', firstLine);
    }
  }

  // CLOSING (Section 9)
  const closingDate = fv.closing_date ? formatDate(fv.closing_date) : '';
  drawFieldText('closing_date', closingDate);
  if (fv.closing_date) {
    const yearMatch = /^(\d{4})/.exec(String(fv.closing_date));
    if (yearMatch) {
      drawFieldText('closing_year', yearMatch[1].slice(2));
    }
  }

  // ¶12A(2)(b) Settlement expense cap (Seller for Buyer)
  drawFieldText('settlement_expense_cap',
    fv.settlement_expense_cap != null && fv.settlement_expense_cap !== ''
      ? formatMoney(fv.settlement_expense_cap) : '');

  // ATTORNEYS (Section 23)
  drawFieldText('buyer_attorney', fv.buyer_attorney || '');
  drawFieldText('seller_attorney', fv.seller_attorney || '');
  drawFieldText('buyer_attorney_phone', fv.buyer_attorney_phone || '');
  drawFieldText('seller_attorney_phone', fv.seller_attorney_phone || '');
  drawFieldText('buyer_attorney_email', fv.buyer_attorney_email || '');
  drawFieldText('seller_attorney_email', fv.seller_attorney_email || '');

  // ¶21 Notice addresses / phones / emails
  drawFieldText('buyer_notice_address', fv.buyer_notice_address || '');
  drawFieldText('seller_notice_address', fv.seller_notice_address || '');
  drawFieldText('buyer_notice_phone', fv.buyer_notice_phone || '');
  drawFieldText('seller_notice_phone', fv.seller_notice_phone || '');
  drawFieldText('buyer_notice_email', fv.buyer_notice_email || '');
  drawFieldText('seller_notice_email', fv.seller_notice_email || '');

  // ¶21 Agent notice
  drawFieldText('sellers_agent_address', fv.sellers_agent_address || fv.listing_broker_address || '');
  drawFieldText('buyers_agent_address', fv.buyers_agent_address || fv.other_broker_address || '');
  drawFieldText('sellers_agent_phone', fv.sellers_agent_phone || fv.listing_agent_phone || '');
  drawFieldText('buyers_agent_phone', fv.buyers_agent_phone || fv.other_broker_phone || '');
  drawFieldText('sellers_agent_email', fv.sellers_agent_email || fv.listing_agent_email || '');
  drawFieldText('buyers_agent_email', fv.buyers_agent_email || fv.other_broker_assoc_email || '');

  // FUNDING / CLOSING STATEMENT NOTICE (Section 15)
  const fundingDays = fv.funding_notice_days != null && fv.funding_notice_days !== ''
    ? String(fv.funding_notice_days) : '2';
  drawFieldText('funding_notice_days', fundingDays);

  const closingStmtDays = fv.closing_statement_days != null && fv.closing_statement_days !== ''
    ? String(fv.closing_statement_days) : '3';
  drawFieldText('closing_statement_days', closingStmtDays);

  // SELLER CONCESSIONS / BUYER AGENT COMMISSION (Section 12)
  drawFieldText('seller_concessions',
    (fv.seller_concessions != null && fv.seller_concessions !== '' && Number(fv.seller_concessions) > 0)
      ? formatMoney(fv.seller_concessions) : '');

  if (fv.buyer_agent_commission_amt != null && fv.buyer_agent_commission_amt !== ''
      && Number(fv.buyer_agent_commission_amt) > 0) {
    drawFieldText('buyer_agent_commission_amt', formatMoney(fv.buyer_agent_commission_amt));
  } else if (fv.buyer_agent_commission_pct != null && fv.buyer_agent_commission_pct !== ''
      && Number(fv.buyer_agent_commission_pct) > 0) {
    drawFieldText('buyer_agent_commission_pct', String(fv.buyer_agent_commission_pct));
  }

  // HOA (Section 2)
  if (fv.hoa_exists === true) {
    drawFieldText('hoa_exists', 'Yes');
  }
  // 2026-08-19 BROKERAGE FIX -- REMOVED the 'hoa_description' draw. There
  // is no real blank on this form for a free-text HOA name -- ¶6E(2) only
  // has the is/is-not-subject checkboxes (already handled by
  // applyResaleContractCheckboxes below) and refers back to "the
  // residential community identified in Paragraph 2A" (the addition/
  // subdivision name, already filled via the real 'addition_name' field
  // above). Verified against the real zipForm rendering of this same
  // form, 2026-08-19: the HOA's actual name lives on the HOA Addendum
  // (TREC 36-11, a separate attached document, checked via
  // RESALE_CHECKBOX.addendum_hoa), never on the base contract itself. The
  // coordinate this used to draw at (page 3, y=8) was never a real field
  // -- its own JSON notes say "documentation only" -- and rendered
  // outside the form's printed border in the footer margin whenever a
  // value was supplied.

  // EXECUTION BLOCK
  // 2026-08-19 BROKERAGE FIX — REMOVED the old version of this block, which
  // filled execution_day/execution_month/execution_year_2digit (the
  // "EXECUTED the ___ day of ___, 20__ (Effective Date)" blank on page 10)
  // using fv.contract_effective_date OR fv.closing_date. The closing_date
  // fallback was the actual defect — closing_date is set on almost every
  // outgoing offer, so the blank filled in on documents that had not been
  // executed yet, violating Heath's standing instruction that this blank
  // must stay empty until the broker fills it in upon final acceptance.
  //
  // 2026-08-25 CARTER — Quinn found the fix over-corrected: removing the
  // draw entirely made it disappear even when fv.contract_effective_date IS
  // genuinely set (i.e. the deal has actually been marked ratified/executed
  // via chat.js's "ratified yesterday" -> contract_effective_date path).
  // The interactive editor's field map already computes and displays a
  // "filled" executed day/month/year in that case (trec-20-19-transaction-
  // field-map.js executedPart(), derived ONLY from contract_effective_date,
  // never closing_date) — so the UI told the agent the date was filled
  // while the downloaded PDF silently left it blank. Restored, but keyed
  // ONLY off fv.contract_effective_date (no closing_date fallback) so the
  // original standing instruction still holds on every unexecuted offer.
  if (fv.contract_effective_date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fv.contract_effective_date));
    if (m) {
      const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const day = String(Number(m[3]));
      const month = MONTH_NAMES[Number(m[2]) - 1] || '';
      const year2 = m[1].slice(2);
      drawFieldText('execution_day', day);
      drawFieldText('execution_month', month);
      drawFieldText('execution_year_2digit', year2);
    } else {
      console.warn('[fill-trec-20-19] contract_effective_date not in YYYY-MM-DD form, skipping execution block:', fv.contract_effective_date);
    }
  }
  drawFieldText('buyer_email', fv.buyer_email || '');
  drawFieldText('seller_email', fv.seller_email || '');

  // INITIALS (empty by design per 2026-07-04 atlas_29 fix)
  drawFieldText('buyer_initials', '');
  drawFieldText('seller_initials', '');

  // 20-19 RESTRUCTURED BROKER COMPENSATION (¶12B page 7) -- drawn ONLY by
  // drawParagraph7And12BBlanks() below (paired with the ¶12B checkbox
  // logic in applyResaleContractCheckboxes, using the bbox-verified
  // PARA_7_12B_TEXT_COORDS positions). 2026-08-19 BROKERAGE FIX -- this
  // block used to ALSO draw all four broker-compensation values here,
  // unconditionally, at the OLD un-verified coordMap keys (e.g.
  // broker_compensation_other_broker_pct: x=401.21, sitting on/before the
  // checkbox instead of on the "______%" blank -- see the coordMap notes).
  // Two draws of the same value at two different x positions on the same
  // line rendered as a visibly doubled number (e.g. "3 3%"). Do not
  // reintroduce a second draw call for any of these four fields.

  // Sections intentionally blank at origination per DOSSIE DOMAIN ESSENTIALS
  // (2026-07-05 lock): §6E prose, page 12 escrow receipt.
  // See fill-form.js for the full domain-rule commentary. (Page 11 broker
  // section is now filled — see fillBrokerContactPage below — because this
  // specific packet explicitly requires it; the domain-essentials default
  // of leaving it blank still applies to the live Dossie product path.)

  // ---------------------------------------------------------------------
  // 2026-08-19 BROKERAGE ROOT-CAUSE FIX -- checkbox support.
  // See long header comment at top of file for the full verification
  // methodology and history.
  // ---------------------------------------------------------------------
  applyResaleContractCheckboxes(pdfDoc, fv);

  // ¶7B / ¶7D / ¶7I / ¶12B text blanks that live on the SAME line as a
  // checkbox (day counts, dollar/percentage amounts) are drawn as raw
  // page text (not AcroForm fields) since their coordinates were derived
  // the same bbox-verified way as the checkboxes. Kept as a separate pass
  // after checkboxes so the X-overlay pass above doesn't need to know
  // about them.
  drawParagraph7And12BBlanks(pdfDoc, fv);

  // 2026-08-19 BROKERAGE FIX -- WIRED IN. fillBrokerContactPage() (page 11,
  // BROKER CONTACT INFORMATION) has existed in this file since it was
  // ported in this same pass, but was never actually called from the fill
  // pipeline -- it was only exported, so page 11 came out completely
  // blank on every build regardless of caller (fill-form.js,
  // interactive-editor-download-pdf.js, interactive-editor-verify.js all
  // go through this one fillTrec2019() function). Calling it here fixes
  // all three callers at once. No-ops safely when the caller doesn't pass
  // fv.listing_side / fv.buyer_side (both gated internally).
  await fillBrokerContactPage(pdfDoc, fv);
}

// ---------------------------------------------------------------------------
// VERIFIED (2026-08-19, cross-referenced against a FRESH correctly page-
// attributed pdf-lib field dump + actual rendered page PNGs of the live
// blank asset -- NOT the earlier, unsorted all-fields.txt some previous
// passes relied on) checkbox field-name -> real meaning map for the TREC
// 20-19 resale contract AcroForm. Field names on this asset do NOT
// reliably describe what they control -- verify by PAGE + RECT position
// against the rendered page, never by the field's own literal name.
// ---------------------------------------------------------------------------
const RESALE_CHECKBOX = {
  // Paragraph 6C SURVEY (page 3) -- "(Check one box only)"
  survey_option1_main: 'Buyer',              // (1) Seller furnishes existing survey + T-47 affidavit
  survey_option1_sellers_expense: 'Within one',  // embedded sub-choice: new survey at Seller's expense if rejected
  survey_option1_buyers_expense: 'Within two',   // embedded sub-choice: new survey at Buyer's expense if rejected
  survey_option2_main: 'Within three',       // (2) Buyer obtains new survey at Buyer's expense
  survey_option3_main: 'Within four',        // (3) Seller obtains new survey at Seller's expense

  // Paragraph 6A TITLE POLICY opening line (page 2) -- "Seller shall
  // furnish to Buyer at [ ] Seller's [ ] Buyer's expense..."
  title_sellers_expense: 'Sellers_2',
  title_buyers_expense: 'Buyers expense no later',

  // Paragraph 6A(8) title-exclusion amendment (page 2) -- "(8) ... (i)
  // will not be amended or deleted from the title policy; or (ii) will be
  // amended to read, 'shortages in area' at the expense of [ ] Buyer
  // [ ] Seller." NEW 2026-08-19 -- previously never wired to any fv flag
  // at all, despite being the EXACT literal phrase in the Brokerage
  // checklist ("'will be amended to read shortages in area at the expense
  // of Seller' box checked"). Verified via pixel-position cross-reference:
  // these 4 checkboxes share the same y-band as the two page-2 title
  // checkboxes above but sit lower on the page (item 8 is near the bottom
  // of the ¶6A exclusions list). Distinct from the ¶6C survey-expense
  // sub-choice above -- that's a different paragraph.
  title_shortages_not_amended: '2Within',        // (i) will not be amended or deleted
  title_shortages_amended: '3Within',            // (ii) will be amended to read "shortages in area"
  title_shortages_buyers_expense: 'is',          // (ii) sub-choice: at Buyer's expense
  title_shortages_sellers_expense: 'is not',     // (ii) sub-choice: at Seller's expense

  // Paragraph 6E(2) MEMBERSHIP IN PROPERTY OWNERS ASSOCIATION(S) (page 3
  // -- NOT page 2 despite the generic field names; confirmed via rendered
  // PNG, this line sits ~60% down page 3 right after ¶6D Objections)
  hoa_is_subject: '1Within',                 // "The Property [X] is subject to mandatory membership..."
  hoa_is_not_subject: '2 Within',            // "The Property [X] is not subject..."

  // Paragraph 7B SELLER'S DISCLOSURE NOTICE (page 4) -- "(Check one box
  // only)". NEW 2026-08-19 -- previously never wired to any fv flag.
  // Confirmed via the "Within" text field (page 4, same y-band as the
  // (2) checkbox) which can only be the ¶7B(2) day-count blank.
  seller_disclosure_received: '1 Buyer accepts the Property As Is',                 // (1) Buyer has received
  seller_disclosure_not_received: '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the', // (2) Buyer has not received, Within ___ days
  seller_disclosure_not_required: 'upon',    // (3) Seller not required to furnish

  // Paragraph 7D ACCEPTANCE OF PROPERTY CONDITION (page 5) -- these two
  // are correctly, sensibly named on this asset (unlike almost everything
  // else). "(Check one box only)". NEW 2026-08-19 -- previously never
  // wired to any fv flag at all; this is the actual root cause of the
  // repeatedly-reported "As Is checkbox found blank" bug.
  accepts_as_is: 'As Is',                    // (1) Buyer accepts the Property As Is
  accepts_as_is_with_repairs: 'As Is except', // (2) Buyer accepts As Is provided Seller completes repairs

  // Paragraph 7I SELLER'S DISCLOSURE ABOUT GROUNDWATER AND SURFACE WATER
  // RIGHTS / Seller's Water Disclosure (page 5) -- "(Check one box only)".
  // NEW 2026-08-19 -- previously never wired to any fv flag.
  water_disclosure_received: 'Seller as List Brok Sub agent2',   // (1) Buyer has received
  water_disclosure_not_received: 'Dollar Amt2',                  // (2) Buyer has not received, Within ___ days
  water_disclosure_not_required: 'Dollar Amt',                   // (3) Seller not required to deliver

  // Paragraph 12B BROKERAGE COMPENSATION (page 7). Each row is "(check
  // one box only): [ ] $___ or [ ] ___% of the Sales Price", PLUS a
  // leading box for the row itself ("(1) Seller will pay..." / "(2) Buyer
  // will pay..."). NEW 2026-08-19 -- previously the $/% TEXT amount was
  // drawn but NO checkbox was ever checked next to it; this is the actual
  // root cause of "¶12B found completely blank" (a filled-in number with
  // no checked box reads as an orphaned, unexplained figure on the
  // contract).
  broker_12b1_item: 'Seller as List Brok Sub agent',       // (1) Seller will pay -- leading box
  broker_12b1_dollar: 'Seller as List Brok Sub agent27',   // (1) $ sub-choice
  broker_12b1_percentage: 'Seller only as Sellers agent',  // (1) % sub-choice ("Percentage")
  broker_12b2_item: 'Dollar Amt4',                         // (2) Buyer will pay -- leading box
  broker_12b2_dollar: 'Dollar Amt5',                        // (2) $ sub-choice
  broker_12b2_percentage: 'Percentage',                     // (2) % sub-choice (correctly named!)

  // Paragraph 10A POSSESSION (page 6)
  possession_closing: 'will',                          // "upon closing and funding"
  possession_temp_lease: 'will not be credited to the Sales Price at closing Time is of the',

  // Paragraph 3B FINANCING TYPE (page 1) -- the text wraps two printed
  // lines: line 1 ends "...in the attached: [ ] Third Party Financing
  // Addendum,"; line 2 reads "[ ] Loan Assumption Addendum, [ ] Seller
  // Financing Addendum ... $___". NEW 2026-08-19 -- previously never wired
  // at all (Warden audit finding); only the separate page-9 para22
  // addenda-checklist box (addendum_third_party_financing below) was ever
  // checked. FIRST ATTEMPT at this fix wrongly guessed the leftmost
  // checkbox on the y=[269,279] line-2 band ("Check Box2", x 76) was Third
  // Party Financing -- rendering proved that box actually sits next to
  // "Loan Assumption Addendum" (it's line 2's LEFT box, i.e. Loan
  // Assumption, not line 1's Third Party Financing). Re-verified by
  // rendering: the correct Third Party Financing box is the SOLE checkbox
  // on the higher y-band [283,292] (line 1), misnamed "B Sum of all
  // financing described in the attached" (x 314). Confirmed by actual
  // rendered checkmark position, not just coordinate arithmetic -- do not
  // revert to "Check Box2" for this field.
  para3b_third_party_financing: 'B Sum of all financing described in the attached',

  // Paragraph 22 ADDENDA CHECKLIST (page 9) -- extensively scrambled, see
  // comment above. Only the rows Brokerage's workflows actually use are
  // mapped; do not assume any OTHER field on this page is named correctly.
  addendum_third_party_financing: 'Addendum for Reservation of Oil Gas',
  addendum_appraisal_termination: 'Addendum for BackUp Contract', // TREC 49-1 "Right to Terminate Due to Lender's Appraisal"
  addendum_hoa: 'Check Box9',                // Addendum for Property Subject to Mandatory Membership in a POA
  // NEW 2026-08-19 -- Lead-Based Paint Addendum checkbox. Position-
  // verified (item 15 of 24 in the ¶22 checklist, "Statutory Disclosures
  // and Notices" section, first row) against the y-descending sort of
  // page 9's 24 checkboxes in all-fields-FRESH.txt.
  addendum_lead_paint: 'Loan Assumption Addendum_2',
};

// Text blanks on pages 4/5/7 that sit on the SAME printed line as a
// checkbox above and were verified the same bbox-position way. Page/x/y
// values come directly from the fresh field dump's TEXT (not checkbox)
// rows at matching y-bands, cross-referenced against the rendered PNGs.
const PARA_7_12B_TEXT_COORDS = {
  // ¶7B(2) "Within ___ days after the Effective Date..." (page 4)
  seller_disclosure_days_blank: { page: 4, x: 424, y: 203, fontSize: 10 },
  // ¶7I(2) "Within ___ days after the Effective Date..." (page 5)
  water_disclosure_days_blank: { page: 5, x: 432, y: 274, fontSize: 10 },
  // ¶12B(1) Seller pays -- $ blank (page 7)
  broker_12b1_dollar_blank: { page: 7, x: 311.84, y: 645.34, fontSize: 10 },
  // ¶12B(1) Seller pays -- % blank (page 7). 2026-08-19 BROKERAGE FIX: was
  // x=401.21, which sits ON/before the checkbox glyph (bbox-verified
  // checkbox right edge x=401.02) rather than on the "______%" blank
  // itself (bbox-verified blank start x=407.83) -- root cause of the
  // percentage number rendering off the line instead of on it. New x uses
  // the same "+7.95pt padding past blank start" offset already proven
  // correct on the $ blank two lines below (303.89 + 7.95 = 311.84).
  broker_12b1_percentage_blank: { page: 7, x: 415.78, y: 645.34, fontSize: 10 },
  // ¶12B(2) Buyer pays -- $ blank (page 7)
  broker_12b2_dollar_blank: { page: 7, x: 311.84, y: 623.26, fontSize: 10 },
  // ¶12B(2) Buyer pays -- % blank (page 7). Same x fix as broker_12b1_percentage_blank above.
  broker_12b2_percentage_blank: { page: 7, x: 415.78, y: 623.26, fontSize: 10 },
};

function drawParagraph7And12BBlanks(pdfDoc, fv) {
  const pages = pdfDoc.getPages();
  function draw(key, value) {
    if (value == null || value === '') return;
    const c = PARA_7_12B_TEXT_COORDS[key];
    if (!c || c.page < 1 || c.page > pages.length) return;
    try {
      pages[c.page - 1].drawText(String(value).slice(0, 60), { x: c.x, y: c.y, size: c.fontSize || 10 });
    } catch (e) {
      console.warn('[fill-trec-20-19] drawParagraph7And12BBlanks failed for', key, e && e.message);
    }
  }
  if (fv.seller_disclosure_received === false) {
    draw('seller_disclosure_days_blank', fv.seller_disclosure_days != null ? String(fv.seller_disclosure_days) : '');
  }
  if (fv.water_disclosure_received === false) {
    draw('water_disclosure_days_blank', fv.water_disclosure_days != null ? String(fv.water_disclosure_days) : '');
  }
  // ¶12B(1) Seller pays toward Buyer's broker -- $ or %
  if (fv.broker_compensation_other_broker_amt != null && fv.broker_compensation_other_broker_amt !== '') {
    draw('broker_12b1_dollar_blank', formatMoney(fv.broker_compensation_other_broker_amt));
  } else if (fv.broker_compensation_other_broker_pct != null && fv.broker_compensation_other_broker_pct !== '') {
    draw('broker_12b1_percentage_blank', String(fv.broker_compensation_other_broker_pct));
  }
  // ¶12B(2) Buyer pays toward Seller's broker -- $ or %
  if (fv.broker_compensation_buyer_agent_amt != null && fv.broker_compensation_buyer_agent_amt !== '') {
    draw('broker_12b2_dollar_blank', formatMoney(fv.broker_compensation_buyer_agent_amt));
  } else if (fv.broker_compensation_buyer_agent_pct != null && fv.broker_compensation_buyer_agent_pct !== '') {
    draw('broker_12b2_percentage_blank', String(fv.broker_compensation_buyer_agent_pct));
  }
}

function applyResaleContractCheckboxes(pdfDoc, fv) {
  let form;
  try {
    form = pdfDoc.getForm();
  } catch (e) {
    console.warn('[fill-trec-20-19] no AcroForm on this PDF, skipping checkboxes:', e && e.message);
    return;
  }
  const checkedFieldNames = [];
  const check = (fieldName, label) => {
    try {
      form.getCheckBox(fieldName).check();
      checkedFieldNames.push(fieldName);
    } catch (e) {
      console.warn('[fill-trec-20-19] could not check', label, '(field', JSON.stringify(fieldName) + '):', e && e.message);
    }
  };

  // SURVEY (¶6C) -- fv.survey_option: '1' | '2' | '3'. Only acted on when
  // explicitly supplied; never guessed, since it is a legally material
  // election. fv.survey_option1_expense: 'seller' | 'buyer' governs the
  // embedded sub-choice inside option 1 (defaults to 'seller' when option
  // 1 is selected and not otherwise specified -- matches the standing
  // Brokerage default: seller pays for a new survey if the existing
  // survey/T-47 affidavit is rejected).
  const surveyOption = fv.survey_option != null ? String(fv.survey_option) : '';
  if (surveyOption === '1') {
    check(RESALE_CHECKBOX.survey_option1_main, 'survey option (1)');
    const expense = String(fv.survey_option1_expense || 'seller').toLowerCase();
    if (expense === 'buyer') {
      check(RESALE_CHECKBOX.survey_option1_buyers_expense, 'survey (1) buyer\'s expense');
    } else {
      check(RESALE_CHECKBOX.survey_option1_sellers_expense, 'survey (1) seller\'s expense');
    }
  } else if (surveyOption === '2') {
    check(RESALE_CHECKBOX.survey_option2_main, 'survey option (2)');
  } else if (surveyOption === '3') {
    check(RESALE_CHECKBOX.survey_option3_main, 'survey option (3)');
  }

  // TITLE POLICY (¶6A) -- fv.title_seller_expense: true|false. Not guessed
  // when omitted. Also drives the ¶6A(8)(ii) "shortages in area" amendment
  // sub-choice (NEW 2026-08-19) -- when Seller is paying for title policy,
  // the standing Brokerage default is also to amend the shortages-in-area
  // exception at Seller's expense (fv.shortages_in_area_amended: true|false
  // can override independently if ever needed; defaults to following
  // title_seller_expense).
  if (fv.title_seller_expense === true) {
    check(RESALE_CHECKBOX.title_sellers_expense, 'title policy Seller\'s expense');
  } else if (fv.title_seller_expense === false) {
    check(RESALE_CHECKBOX.title_buyers_expense, 'title policy Buyer\'s expense');
  }
  const shortagesAmended = fv.shortages_in_area_amended != null
    ? fv.shortages_in_area_amended === true
    : fv.title_seller_expense === true;
  if (shortagesAmended) {
    check(RESALE_CHECKBOX.title_shortages_amended, '¶6A(8)(ii) shortages in area amended');
    const shortagesExpense = String(fv.shortages_in_area_expense
      || (fv.title_seller_expense === true ? 'seller' : 'buyer')).toLowerCase();
    if (shortagesExpense === 'buyer') {
      check(RESALE_CHECKBOX.title_shortages_buyers_expense, '¶6A(8)(ii) at Buyer\'s expense');
    } else {
      check(RESALE_CHECKBOX.title_shortages_sellers_expense, '¶6A(8)(ii) at Seller\'s expense');
    }
  }

  // HOA MANDATORY MEMBERSHIP (¶6E(2)) -- fv.hoa_mandatory: true|false.
  // Independent of fv.hoa_exists (which only drives the ¶2/hoa_description
  // text annotation and, below, whether the HOA addendum checklist box is
  // checked). Not guessed when omitted.
  if (fv.hoa_mandatory === true) {
    check(RESALE_CHECKBOX.hoa_is_subject, 'HOA is subject to mandatory membership');
  } else if (fv.hoa_mandatory === false) {
    check(RESALE_CHECKBOX.hoa_is_not_subject, 'HOA is not subject to mandatory membership');
  }

  // POSSESSION (¶10A) -- reuses the same fv.possession value already used
  // for the text annotation above ('closing' default, or 'lease').
  const possession = String(fv.possession || 'closing').toLowerCase();
  if (possession === 'lease' || possession === 'lease_after' || possession === 'temporary_lease') {
    check(RESALE_CHECKBOX.possession_temp_lease, 'possession via temporary lease');
  } else {
    check(RESALE_CHECKBOX.possession_closing, 'possession upon closing and funding');
  }

  // ¶7B SELLER'S DISCLOSURE NOTICE -- fv.seller_disclosure_received:
  // true|false. Not guessed when omitted (legally material -- whether the
  // actual disclosure document is in hand changes the buyer's termination
  // rights). When false, also fills the 14-day (or fv.seller_disclosure_days)
  // blank via drawParagraph7And12BBlanks.
  if (fv.seller_disclosure_received === true) {
    check(RESALE_CHECKBOX.seller_disclosure_received, '¶7B(1) Buyer has received Seller\'s Disclosure Notice');
  } else if (fv.seller_disclosure_received === false) {
    check(RESALE_CHECKBOX.seller_disclosure_not_received, '¶7B(2) Buyer has not received Seller\'s Disclosure Notice');
  } else if (fv.seller_disclosure_not_required === true) {
    check(RESALE_CHECKBOX.seller_disclosure_not_required, '¶7B(3) Seller not required to furnish Seller\'s Disclosure Notice');
  }

  // ¶7D ACCEPTANCE OF PROPERTY CONDITION -- fv.accepts_as_is: true selects
  // "Buyer accepts the Property As Is" (1). fv.accepts_as_is_with_repairs:
  // true selects (2) instead (mutually exclusive; (2) checked wins if both
  // somehow set, since it's the more specific/informative election).
  if (fv.accepts_as_is_with_repairs === true) {
    check(RESALE_CHECKBOX.accepts_as_is_with_repairs, '¶7D(2) Buyer accepts As Is with Seller repairs');
  } else if (fv.accepts_as_is === true) {
    check(RESALE_CHECKBOX.accepts_as_is, '¶7D(1) Buyer accepts the Property As Is');
  }

  // ¶7I SELLER'S WATER DISCLOSURE -- fv.water_disclosure_received:
  // true|false. Same not-guessed-when-omitted rule as ¶7B.
  if (fv.water_disclosure_received === true) {
    check(RESALE_CHECKBOX.water_disclosure_received, '¶7I(1) Buyer has received Seller\'s Water Disclosure');
  } else if (fv.water_disclosure_received === false) {
    check(RESALE_CHECKBOX.water_disclosure_not_received, '¶7I(2) Buyer has not received Seller\'s Water Disclosure');
  } else if (fv.water_disclosure_not_required === true) {
    check(RESALE_CHECKBOX.water_disclosure_not_required, '¶7I(3) Seller not required to deliver Seller\'s Water Disclosure');
  }

  // ¶12B BROKERAGE COMPENSATION -- checks the leading item box plus the
  // correct $/% sub-choice, matching whichever of the four
  // broker_compensation_* text fields is actually populated (see
  // fillTrec2019's existing text-drawing logic above and
  // drawParagraph7And12BBlanks for the matching dollar-amount text).
  const row1Dollar = fv.broker_compensation_other_broker_amt != null && fv.broker_compensation_other_broker_amt !== '';
  const row1Pct = fv.broker_compensation_other_broker_pct != null && fv.broker_compensation_other_broker_pct !== '';
  if (row1Dollar || row1Pct) {
    check(RESALE_CHECKBOX.broker_12b1_item, '¶12B(1) Seller will pay -- item box');
    if (row1Dollar) {
      check(RESALE_CHECKBOX.broker_12b1_dollar, '¶12B(1) Seller will pay -- $ sub-choice');
    } else {
      check(RESALE_CHECKBOX.broker_12b1_percentage, '¶12B(1) Seller will pay -- % sub-choice');
    }
  }
  const row2Dollar = fv.broker_compensation_buyer_agent_amt != null && fv.broker_compensation_buyer_agent_amt !== '';
  const row2Pct = fv.broker_compensation_buyer_agent_pct != null && fv.broker_compensation_buyer_agent_pct !== '';
  if (row2Dollar || row2Pct) {
    check(RESALE_CHECKBOX.broker_12b2_item, '¶12B(2) Buyer will pay -- item box');
    if (row2Dollar) {
      check(RESALE_CHECKBOX.broker_12b2_dollar, '¶12B(2) Buyer will pay -- $ sub-choice');
    } else {
      check(RESALE_CHECKBOX.broker_12b2_percentage, '¶12B(2) Buyer will pay -- % sub-choice');
    }
  }

  // ¶3B / ¶22 THIRD PARTY FINANCING -- auto-checked whenever the deal is
  // financed (loan_amount > 0); explicit fv.addendum_financing overrides.
  // Checks BOTH the page-1 ¶3B financing-type box (para3b_third_party_financing)
  // AND the page-9 ¶22 addenda-checklist box (addendum_third_party_financing).
  // FIXED 2026-08-19 (Warden audit) -- the ¶3B box was previously never
  // wired at all despite a stale comment here claiming it had "its own
  // auto-check logic elsewhere in this pipeline"; that logic did not
  // actually exist anywhere in the build path. Both boxes now share this
  // single isFinanced gate so they can never drift out of sync again.
  const isFinanced = fv.addendum_financing === true
    || (fv.addendum_financing !== false && Number(fv.loan_amount) > 0);
  if (isFinanced) {
    check(RESALE_CHECKBOX.para3b_third_party_financing, '¶3B Third Party Financing Addendum (page 1)');
    check(RESALE_CHECKBOX.addendum_third_party_financing, 'Third Party Financing Addendum (¶22)');
  }
  // Appraisal Termination Addendum (TREC 49-1) -- explicit flag only, never
  // inferred; this addendum is a separate document Brokerage attaches
  // deliberately (see fillAppraisalTermination), so the checklist box
  // should track that decision explicitly rather than being guessed here.
  if (fv.addendum_appraisal_termination === true) {
    check(RESALE_CHECKBOX.addendum_appraisal_termination, 'Right to Terminate Due to Lender\'s Appraisal Addendum (¶22)');
  }
  // HOA Addendum (TREC 36-11) -- tracks fv.hoa_exists (mandatory-membership
  // HOA), consistent with the existing hoa_description text annotation.
  if (fv.hoa_exists === true) {
    check(RESALE_CHECKBOX.addendum_hoa, 'HOA Addendum (¶22)');
  }
  // Lead-Based Paint Addendum -- explicit flag only, set by the caller
  // after verifying the property's actual build year (pre-1978 = federal
  // requirement; never guessed here).
  if (fv.addendum_lead_paint === true) {
    check(RESALE_CHECKBOX.addendum_lead_paint, 'Lead-Based Paint Addendum (¶22)');
  }

  try { form.updateFieldAppearances(); } catch (e) { /* non-fatal */ }
  // 2026-08-19 BROKERAGE FIX -- REMOVED the "belt-and-suspenders" manual
  // X-overlay pass that used to run here. Root-cause inspected directly:
  // every checked box's own /AP /N /On appearance stream on this asset is
  // a real, well-formed XObject that draws a ZapfDingbats checkmark
  // (content stream: "BT /ZaDb 10 Tf ... (4) Tj ET", where ZapfDingbats
  // char 4 is a check glyph) sized to the widget's own Rect --
  // form.updateFieldAppearances() correctly points /AS at that existing
  // stream, which is standard PDF and renders in any compliant viewer
  // without needing regeneration. The manual "X" this pass used to draw
  // directly on top of that same rect was therefore a genuine second mark,
  // not insurance -- the two overlapping (native checkmark + manual X)
  // produced the reported doubled/overlapping checkbox marks. Checking the
  // AcroForm field via check() + updateFieldAppearances() above is now the
  // ONLY mark-drawing method; do not re-add a text overlay for checkboxes.
}

// ---------------------------------------------------------------------------
// 2026-08-19 BROKERAGE — BROKER CONTACT INFORMATION page (page 11).
// Field mapping independently re-derived from scratch this pass (width +
// row-position cross-reference against the rendered page-11 PNG) and found
// to EXACTLY MATCH what the Royal Crescent build script's patchBrokerPage()
// had already verified via a different method (bbox row cross-reference)
// on 2026-08-19 earlier this same day. Two independent verification passes
// agreeing is the strongest confidence this file has for any field map.
// Ported here as a shared function so all three properties (not just Royal
// Crescent) get this page filled consistently.
// ---------------------------------------------------------------------------
const BROKER_PAGE_BLOCK1_LISTING_SELLER_SIDE = {
  firm: 'Other Broker Firm',
  address: 'License No',
  brokerLicenseNo: 'Listing Broker Firm',
  associateName: 'License No_4',
  teamName: 'Associates Name numb 1',
  associateEmail: 'License No_2',
  associatePhone: 'List Assoc Name',
  associateLicenseNo: 'License No_5',
};
const BROKER_PAGE_BLOCK2_BUYER_SIDE = {
  firm: 'Associates Email Address',
  address: 'Listing Associates Email Address',
  brokerLicenseNo: 'Phone',
  associateName: 'Licensed Supervisor of Associate',
  teamName: 'License No_3',
  associateEmail: 'License No_6',
  associatePhone: 'Other Brokers Address',
  associateLicenseNo: 'Phone_2',
};

/**
 * Fills page 11 (BROKER CONTACT INFORMATION). Block 1 = the side
 * representing Seller ("represents Seller only as Seller's agent").
 * Block 2 = the side representing Buyer ("represents Buyer only as
 * Buyer's agent"). Callers pass whichever real party belongs in each
 * side -- for Brokerage's buyer-representation deals, Heath is always
 * Block 2 (Buyer's agent) and the listing agent is Block 1 (Seller's
 * agent).
 */
async function fillBrokerContactPage(pdfDoc, fv) {
  let form;
  try {
    form = pdfDoc.getForm();
  } catch (e) {
    console.warn('[fill-trec-20-19] no AcroForm on this PDF, skipping broker contact page:', e && e.message);
    return;
  }
  const set = (name, val) => {
    if (!val) return;
    try { form.getTextField(name).setText(String(val)); } catch (e) {
      console.warn('[fill-trec-20-19] broker page: could not set', name, e && e.message);
    }
  };
  if (fv.listing_side) {
    const b = BROKER_PAGE_BLOCK1_LISTING_SELLER_SIDE;
    const s = fv.listing_side;
    set(b.firm, s.firm);
    set(b.address, s.address);
    set(b.brokerLicenseNo, s.brokerLicenseNo);
    set(b.associateName, s.associateName);
    set(b.teamName, s.teamName);
    set(b.associateEmail, s.associateEmail);
    set(b.associatePhone, s.associatePhone);
    set(b.associateLicenseNo, s.associateLicenseNo);
  }
  if (fv.buyer_side) {
    const b = BROKER_PAGE_BLOCK2_BUYER_SIDE;
    const s = fv.buyer_side;
    set(b.firm, s.firm);
    set(b.address, s.address);
    set(b.brokerLicenseNo, s.brokerLicenseNo);
    set(b.associateName, s.associateName);
    set(b.teamName, s.teamName);
    set(b.associateEmail, s.associateEmail);
    set(b.associatePhone, s.associatePhone);
    set(b.associateLicenseNo, s.associateLicenseNo);
  }
  try { form.updateFieldAppearances(); } catch (e) { /* non-fatal */ }
}

module.exports = {
  fillTrec2019,
  formatMoney,
  formatDate,
  TREC_20_19_COORDS,
  RESALE_CHECKBOX,
  applyResaleContractCheckboxes,
  fillBrokerContactPage,
  HEADER_FIELDS_BY_PAGE,
};
