// api/_lib/trec-20-19-editor-field-translate.js
//
// 2026-08-20 CARTER — Quinn QA fix (staging commit 9aab37d6, real-browser
// POST-body capture).
//
// The Phase 1 Interactive Editor (Dossie repo, FormEditor.jsx) ships its
// field inventory straight from the cached Fable5 auto-map run
// (dossiesign_auto_map_runs id 8e3bc446-eb01-43b9-8447-6da9de22bcc7) — the
// field KEY NAMES are data pulled from that DB row, not hardcoded in the
// editor's JSX (FieldGroup.jsx/RadioField.jsx render generically off
// whatever `key` each row carries). The 2026-08-19 checkbox-wiring rewrite
// of fill-trec-20-19.js changed the key names that pipeline reads for
// several TREC 20-19 sections, but the Fable5 run's field names (what the
// editor actually sends) were never updated to match — so those sections
// went silently blank, or in Possession's case, silently wrong (backend
// defaults to 'closing' whenever the key is absent).
//
// Every editor key name below was verified directly against the live
// dossiesign_auto_map_runs row (not assumed) — each is an independent
// Yes/No toggle (RadioField falls back to a single true/false pair whenever
// Fable5 doesn't supply field.options, and it never does on this run), NOT
// a true multi-choice radio group. This module translates those toggles
// into the fv keys fill-trec-20-19.js now reads. Called by BOTH
// interactive-editor-download-pdf.js and interactive-editor-verify.js so
// the previewed/downloaded PDF and the hashed legal-trail snapshot always
// agree.
//
// Never guesses a legally material election the editor didn't clearly
// supply — if neither side of a mutually-exclusive pair is set, the
// translated key is simply omitted so fillTrec2019's own "not guessed when
// omitted" branches apply, EXCEPT Possession, which fillTrec2019 already
// defaults to 'closing' when its key is absent (pre-existing behavior, left
// untouched — this module just makes the real Lease election actually reach
// that key instead of never being sent at all).
//
// KNOWN GAPS (editor has no control at all — do not fabricate a mapping):
//   - TREC 20-19 §6C SURVEY option (3) "Seller obtains new survey at
//     Seller's expense" — Fable5 only mapped options (1) and (2).
//   - §7D ACCEPTANCE OF PROPERTY CONDITION option (2) "As Is provided
//     Seller completes repairs" has no dedicated checkbox in the editor,
//     only free-text repair-list blanks. We infer accepts_as_is_with_repairs
//     from repairs text being present (the only real signal available) —
//     see inline comment below.
//   - §12B COMMISSION — no UI control exists in the editor at all yet.
// Flag these to Heath as separate follow-up work; this module cannot fix a
// missing control, only mis-named ones.

function truthy(v) {
  if (v === true) return true;
  if (v == null || v === false || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'checked' || s === 'on';
}

function hasValue(v) {
  return v != null && v !== '';
}

/**
 * Returns a NEW object: a shallow copy of `fv` with the editor's legacy key
 * names translated onto the keys fill-trec-20-19.js reads. Explicit values
 * already present under the canonical key always win (this only fills gaps).
 */
function translateEditorFieldNames(fv) {
  const src = fv || {};
  const out = { ...src };

  // ¶6C SURVEY — editor: survey_option_existing (option 1) /
  // survey_option_buyer_new (option 2), each an independent toggle. No
  // editor control for option (3) — see KNOWN GAPS above.
  if (!hasValue(out.survey_option)) {
    if (truthy(src.survey_option_existing)) {
      out.survey_option = '1';
    } else if (truthy(src.survey_option_buyer_new)) {
      out.survey_option = '2';
    }
  }
  // Option (1) embedded sub-choice: new-survey expense if the existing
  // survey/T-47 affidavit is rejected.
  if (!hasValue(out.survey_option1_expense)) {
    if (truthy(src.unacceptable_survey_new_expense_buyer)) {
      out.survey_option1_expense = 'buyer';
    } else if (truthy(src.unacceptable_survey_new_expense)) {
      out.survey_option1_expense = 'seller';
    }
  }
  // Separate day-count text blanks (independent of the checkbox election).
  if (!hasValue(out.survey_days_seller) && hasValue(src.survey_existing_days)) {
    out.survey_days_seller = src.survey_existing_days;
  }
  if (!hasValue(out.survey_days_buyer) && hasValue(src.survey_buyer_new_days)) {
    out.survey_days_buyer = src.survey_buyer_new_days;
  }

  // ¶6A(8)(ii) "shortages in area" title-exclusion amendment — editor:
  // survey_exception_amendment ("will NOT be amended", option (i)) vs.
  // shortages_amendment_expense / shortages_amendment_expense_seller
  // (option (ii)'s Buyer/Seller expense sub-choice). Backend:
  // fv.shortages_in_area_amended (true|false) + fv.shortages_in_area_expense.
  if (out.shortages_in_area_amended == null) {
    if (truthy(src.shortages_amendment_expense) || truthy(src.shortages_amendment_expense_seller)) {
      out.shortages_in_area_amended = true;
    } else if (truthy(src.survey_exception_amendment)) {
      out.shortages_in_area_amended = false;
    }
  }
  if (!hasValue(out.shortages_in_area_expense)) {
    if (truthy(src.shortages_amendment_expense)) {
      out.shortages_in_area_expense = 'buyer';
    } else if (truthy(src.shortages_amendment_expense_seller)) {
      out.shortages_in_area_expense = 'seller';
    }
  }

  // ¶6A TITLE POLICY opening expense — editor: title_policy_expense
  // (Seller) / title_policy_expense_buyer (Buyer). Backend:
  // fv.title_seller_expense (true|false).
  if (out.title_seller_expense == null) {
    if (truthy(src.title_policy_expense)) {
      out.title_seller_expense = true;
    } else if (truthy(src.title_policy_expense_buyer)) {
      out.title_seller_expense = false;
    }
  }

  // ¶6E(2) HOA mandatory membership — editor: hoa_membership (is) /
  // hoa_membership_is_not (is not). Backend: fv.hoa_mandatory.
  if (out.hoa_mandatory == null) {
    if (truthy(src.hoa_membership)) {
      out.hoa_mandatory = true;
    } else if (truthy(src.hoa_membership_is_not)) {
      out.hoa_mandatory = false;
    }
  }

  // ¶7D ACCEPTANCE OF PROPERTY CONDITION — editor only has ONE toggle
  // (acceptance_as_is = option (1)) plus free-text repair lines
  // (specific_repairs_line1/2). No dedicated control for option (2) — see
  // KNOWN GAPS. Repairs text present is the only real signal the editor
  // gives for "As Is provided Seller completes repairs"; backend already
  // prefers accepts_as_is_with_repairs over accepts_as_is when both are
  // true, so this matches existing precedence rather than inventing new
  // behavior.
  const repairsText = [src.specific_repairs_line1, src.specific_repairs_line2]
    .filter((v) => hasValue(v) && String(v).trim() !== '')
    .join(' ')
    .trim();
  if (out.accepts_as_is_with_repairs == null && repairsText) {
    out.accepts_as_is_with_repairs = true;
  }
  if (out.accepts_as_is == null && truthy(src.acceptance_as_is)) {
    out.accepts_as_is = true;
  }

  // ¶10A POSSESSION — PRIORITY. Editor: possession_upon_closing /
  // possession_temporary_lease, each an independent toggle. Backend:
  // fv.possession (string), defaults to 'closing' when the key is absent
  // (untouched — this only makes the real Lease election reach that key
  // instead of the toggle being sent under a name the backend never reads).
  if (!hasValue(out.possession)) {
    if (truthy(src.possession_temporary_lease)) {
      out.possession = 'lease';
    } else if (truthy(src.possession_upon_closing)) {
      out.possession = 'closing';
    }
  }

  // ¶8A BROKER OR SALES AGENT DISCLOSURE — editor: broker_disclosure_line1 +
  // broker_disclosure_line2 (two printed blanks). Backend: single
  // fv.broker_relationship_disclosure text draw.
  if (!hasValue(out.broker_relationship_disclosure)) {
    const combined = [src.broker_disclosure_line1, src.broker_disclosure_line2]
      .filter((v) => hasValue(v) && String(v).trim() !== '')
      .join(' ')
      .trim();
    if (combined) out.broker_relationship_disclosure = combined;
  }

  // 2026-09-11 CARTER — ¶2A LAND naming mismatch. Verified directly against
  // the live dossiesign_auto_map_runs row (interactive-editor-init.js POST
  // response, real transaction, staging): the editor's actual Fable5 field
  // keys for this section are land_lot / land_block / land_addition /
  // land_city / land_county, NOT legal_lot / legal_block / addition_name /
  // city / county that fill-trec-20-19.js's coordMap has drawn (and had
  // bbox-verified coordinates for) since the 2026-08-19 fix. Same disease as
  // every other section this file already patches: the member's typed value
  // never reached fv under a key fillTrec2019 reads, so it silently never
  // appeared in their own live preview OR the sent document. Aliased onto
  // the EXISTING calibrated keys (not new coordinates — those five blanks
  // were already correctly bbox-verified, just never fed).
  if (!hasValue(out.legal_lot) && hasValue(src.land_lot)) out.legal_lot = src.land_lot;
  if (!hasValue(out.legal_block) && hasValue(src.land_block)) out.legal_block = src.land_block;
  if (!hasValue(out.addition_name) && hasValue(src.land_addition)) out.addition_name = src.land_addition;
  if (!hasValue(out.city) && hasValue(src.land_city)) out.city = src.land_city;
  if (!hasValue(out.county) && hasValue(src.land_county)) out.county = src.land_county;

  // 2026-09-11 CARTER — ¶21 NOTICES naming mismatch (page 8). Same
  // verification method as ¶2A above. The editor's real keys:
  //   buyer_notice_address_line1 / seller_notice_address_line1  -> the SAME
  //     first blank fillTrec2019 already draws as buyer_notice_address /
  //     seller_notice_address (bbox-verified 2026-08-19/08-30). Aliased, not
  //     re-coordinated.
  //   buyer_notice_address_line2 / seller_notice_address_line2  -> a real,
  //     separate, previously-unmapped second blank line directly below the
  //     first (confirmed via a fresh AcroForm widget-rect dump of the live
  //     blank asset, 2026-09-11: buyer "at7" rect x=61.3 y=343.7, seller
  //     "at_28" rect x=326.7 y=342.7 — NOT a duplicate of line1's rect).
  //     These get their own new coordMap entries in fill-trec-20-19.js
  //     (genuinely new blanks, not a naming fix), so they are deliberately
  //     NOT aliased here — fillTrec2019 reads them directly under their own
  //     editor key names.
  //   buyer_notice_email_fax_2 / seller_notice_email_fax_2  -> the SAME
  //     Email(s)/Fax blank already drawn as buyer_notice_email /
  //     seller_notice_email (which already has its own bbox-verified
  //     secondLine overflow-wrap — no change needed there).
  //   buyer_agent_notice_copy_address / seller_agent_notice_copy_address ->
  //     the ¶21 "To Buyer's/Seller's agent at:" Address line, which
  //     fillTrec2019 already draws (bbox-verified 2026-08-30) as
  //     buyers_agent_address / sellers_agent_address.
  if (!hasValue(out.buyer_notice_address) && hasValue(src.buyer_notice_address_line1)) {
    out.buyer_notice_address = src.buyer_notice_address_line1;
  }
  if (!hasValue(out.seller_notice_address) && hasValue(src.seller_notice_address_line1)) {
    out.seller_notice_address = src.seller_notice_address_line1;
  }
  if (!hasValue(out.buyer_notice_email) && hasValue(src.buyer_notice_email_fax_2)) {
    out.buyer_notice_email = src.buyer_notice_email_fax_2;
  }
  if (!hasValue(out.seller_notice_email) && hasValue(src.seller_notice_email_fax_2)) {
    out.seller_notice_email = src.seller_notice_email_fax_2;
  }
  if (!hasValue(out.buyers_agent_address) && hasValue(src.buyer_agent_notice_copy_address)) {
    out.buyers_agent_address = src.buyer_agent_notice_copy_address;
  }
  if (!hasValue(out.sellers_agent_address) && hasValue(src.seller_agent_notice_copy_address)) {
    out.sellers_agent_address = src.seller_agent_notice_copy_address;
  }

  return out;
}

// PROPERTY ADDRESS — 2026-08-25 CARTER — Quinn found the address rendering
// duplicated ("789 Ranch Rd, San Antonio, TX 78230, San Antonio, TX 78230").
// Root cause: trec-20-19-transaction-field-map.js's `property_address`
// resolver (fullAddress()) returns the FULL "street, city/state/zip"
// known-as string for the editor's own field DISPLAY (TREC's "known as ___"
// blank is the full address, not just street). The editor round-trips every
// field's CURRENT value back on every download/verify call (FormEditor.jsx's
// fieldValuesForSnapshot sends the whole editor.fields map, not just
// deltas), so when a snapshot is present, its property_address arrives
// ALREADY concatenated — but fill-trec-20-19.js's knownAsAddress /
// fullAddressForHeader builders independently re-append fv.city_state_zip on
// top, assuming property_address is street-only (true for the raw
// transactions column, false for what the editor sends).
//
// This can only be fixed on the SNAPSHOT itself, before it's merged with the
// transactions row — not inside translateEditorFieldNames(), which runs
// AFTER that merge and can no longer tell a raw column value (street-only,
// the plain "Download filled PDF" button with no live editor snapshot) apart
// from an editor-computed one (already concatenated). Doing it post-merge
// was tried and reverted: it moved the RAW txn.property_address (street
// only, no snapshot case) onto property_full and deleted property_address,
// which silently dropped the city/state/zip on every download that has no
// live editor snapshot — the far more common real-world path. Call this on
// `snapshot` (never on the merged/txn object) before merging.
function translateSnapshotAddressFields(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (!hasValue(snapshot.property_address)) return snapshot;
  const out = { ...snapshot };
  if (!hasValue(out.property_full)) out.property_full = out.property_address;
  delete out.property_address;
  return out;
}

module.exports = { translateEditorFieldNames, translateSnapshotAddressFields };
