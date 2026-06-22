"""
Detailed paragraph-context verification for every label in deep-read.

For each label, classifies as:
  - CONFIRMED: paragraph text matches fixture_key intent
  - MISLABEL: paragraph text contradicts fixture_key
  - UNCERTAIN: context ambiguous, needs human review
"""
import json
import re
from pathlib import Path

ctx_path = Path(r"C:\Users\Heath Shepard\Desktop\trec-20-18-audit-context.json")
with open(ctx_path, "r", encoding="utf-8") as f:
    ctx = json.load(f)

# Paragraph-key matchers (token presence in wide_context that supports the fixture_key)
# Each entry: fixture_key_prefix -> list of (required_token_regex, "human paragraph name")
# We will try the most specific match first.

KEY_EXPECTATIONS = {
    # PARTIES
    "seller_names": ["PARTIES", "Seller"],
    "buyer_names": ["PARTIES", "Buyer"],
    # LAND / PROPERTY
    "lot": ["LAND", "Lot"],
    "block": ["LAND", "Block"],
    "legal_description": ["LAND"],
    "addition": ["LAND", "Addition"],
    "county": ["LAND", "County"],
    "property_address_line1": ["Address of Property", "Contract Concerning"],
    "property_exclusions": ["EXCLUSIONS", "retained by Seller"],
    # SALES PRICE 3
    "cash_portion_amount": ["SALES PRICE", "Cash portion"],
    "financing_sum_amount": ["financing", "Sum"],
    "sales_price_amount": ["Sales Price"],
    # 3.B Addenda
    "addendum_third_party_financing": ["Third Party Financing", "financing"],
    "addendum_loan_assumption": ["Loan Assumption", "financing"],
    "addendum_seller_financing": ["Seller Financing", "financing"],
    # 4 LEASES
    "addendum_residential_leases": ["LEASES", "Residential"],
    "addendum_fixture_leases": ["LEASES", "Fixture"],
    "addendum_natural_resource_leases": ["LEASES", "Natural Resource"],
    "natural_resource_leases_delivered": ["Natural Resource", "delivered"],
    # 5 EARNEST/OPTION
    "earnest_money": ["EARNEST MONEY", "earnest money"],
    "option_fee": ["Option Fee", "OPTION"],
    "earnest_holder_name": ["Escrow Agent", "earnest"],
    "earnest_holder_address": ["Escrow Agent"],
    "additional_earnest_money": ["additional earnest"],
    "additional_earnest_money_days": ["additional earnest", "days"],
    "option_period_days": ["TERMINATION OPTION", "terminate"],
    # 6 TITLE/SURVEY
    "title_company": ["TITLE POLICY", "Title"],
    "title_policy_paid_by": ["TITLE POLICY", "expense"],
    "title_exception_amendment_paid_by": ["amendment"],
    "title_objection_days": ["OBJECTIONS"],
    "title_policy_paid_by_buyer_days": ["TITLE", "days"],
    "existing_survey_required": ["SURVEY", "existing survey"],
    "survey_days_prior_to_closing": ["SURVEY", "prior to Closing"],
    "hoa_subdivision_information_is_subject": ["MEMBERSHIP", "property owners association", "POA"],
    # 6.E NOTICES
    "required_notices_list": ["REQUIRED NOTICES", "notices have been given", "utility"],
    "improvement_district_text": ["IMPROVEMENT DISTRICTS", "improvement"],
    # 7 PROPERTY CONDITION
    "sellers_disclosure_days": ["SELLER", "DISCLOSURE", "Notice"],
    "sellers_disclosure_received": ["SELLER", "DISCLOSURE"],
    "repairs_list": ["repairs"],
    "repairs_list_continuation": ["repairs"],
    "homeowners_warranty_limit": ["RESIDENTIAL SERVICE", "service contract"],
    "property_condition_acceptance": ["ACCEPTANCE"],
    # 8 BROKERS
    # 9 CLOSING
    "closing_date": ["CLOSING", "closing"],
    "closing_date_year": ["CLOSING"],
    # 10 POSSESSION
    "possession_upon_closing": ["POSSESSION"],
    "possession_credit_to_sales_price": ["POSSESSION"],
    # 11 SPECIAL PROVISIONS
    "special_provisions_line_0": ["SPECIAL PROVISIONS"],
    "special_provisions": ["SPECIAL PROVISIONS"],
    # 12 SETTLEMENT
    "settlement_seller_pays_for_buyer_brokerage": ["expenses", "Buyer", "Seller"],
    "settlement_seller_pays_other_buyer_expenses": ["expenses"],
    # 21 NOTICES
    "notice_to_buyer_name": ["NOTICES", "Buyer"],
    "notice_to_seller_name": ["NOTICES", "Seller"],
    "notice_to_buyer_address_line_2": ["NOTICES"],
    "notice_to_seller_address_line_2": ["NOTICES"],
    "notice_to_buyer_phone_area_code": ["NOTICES", "Phone"],
    "notice_to_buyer_phone": ["NOTICES", "Phone"],
    "notice_to_seller_phone": ["NOTICES", "Phone"],
    "notice_to_buyer_email_fax_line_1": ["NOTICES", "Fax"],
    "notice_to_seller_email_fax_line_1": ["NOTICES", "Fax"],
    "notice_to_buyer_email_fax_line_2": ["NOTICES", "Fax"],
    "notice_to_seller_email_fax_line_2": ["NOTICES", "Fax"],
    "notice_to_buyer_copy_to_agent": ["NOTICES", "agent"],
    # 22 ADDENDA — most are checkbox, hard to verify via text near widget
    # 23 CONSULT AN ATTORNEY
    "buyer_attorney_name": ["CONSULT AN ATTORNEY", "Attorney"],
    "seller_attorney_name": ["CONSULT AN ATTORNEY", "Attorney"],
    "buyer_attorney_phone_area_code": ["Attorney", "Phone"],
    "buyer_attorney_phone": ["Attorney", "Phone"],
    "seller_attorney_phone_area_code": ["Attorney", "Phone"],
    "seller_attorney_phone": ["Attorney", "Phone"],
    "buyer_attorney_fax_area_code": ["Attorney", "Fax"],
    "buyer_attorney_fax": ["Attorney", "Fax"],
    "seller_attorney_fax_area_code": ["Attorney", "Fax"],
    "seller_attorney_fax": ["Attorney", "Fax"],
    "buyer_attorney_email": ["Attorney", "E-mail"],
    "seller_attorney_email": ["Attorney", "E-mail"],
    # Effective date / signatures
    "effective_date_day": ["EXECUTED", "Effective"],
    "effective_date_month": ["EXECUTED", "Effective"],
    "effective_date_year": ["EXECUTED", "Effective"],
    "buyer_signature_1": ["Buyer"],
    "buyer_signature_2": ["Buyer"],
    "seller_signature_1": ["Seller"],
    "seller_signature_2": ["Seller"],
    # Page 10 BROKER INFO
    "other_broker_firm_name": ["BROKER INFORMATION", "Other Broker"],
    "other_broker_license": ["License No"],
    "other_broker_represents": ["represents"],
    "other_broker_associate_name": ["Associate"],
    "other_broker_associate_license": ["Associate", "License"],
    "other_broker_associate_team_name": ["Team"],
    "other_broker_associate_email": ["Associate", "Email"],
    "other_broker_associate_phone": ["Associate", "Phone"],
    "other_broker_supervisor_name": ["Supervisor"],
    "other_broker_supervisor_license": ["Supervisor", "License"],
    "other_broker_address": ["Address", "Other Broker"],
    "other_broker_phone": ["Other Broker", "Phone"],
    "other_broker_city": ["City"],
    "other_broker_state": ["State"],
    "other_broker_zip": ["Zip"],
    "listing_broker_license": ["Listing Broker", "License"],
    "listing_broker_represents": ["represents"],
    "listing_associate_name": ["Listing Associate"],
    "listing_associate_license": ["License", "Listing"],
    "listing_associate_email": ["Listing Associate", "Email"],
    "listing_associate_phone": ["Listing Associate", "Phone"],
    "listing_associate_supervisor_name": ["Supervisor", "Listing"],
    "listing_associate_supervisor_license": ["Supervisor", "License"],
    "listing_broker_office_address": ["Listing Broker", "Office Address"],
    "listing_broker_office_phone": ["Listing Broker", "Office", "Phone"],
    "listing_broker_office_city": ["City"],
    "listing_broker_office_state": ["State"],
    "listing_broker_office_zip": ["Zip"],
    "selling_associate_name": ["Selling Associate"],
    "selling_associate_license": ["Selling Associate", "License"],
    "selling_associate_team_name": ["Team"],
    "selling_associate_email": ["Selling Associate", "Email"],
    "selling_associate_phone": ["Selling Associate", "Phone"],
    "selling_associate_supervisor_name": ["Supervisor", "Selling"],
    "selling_associate_supervisor_license": ["Supervisor", "License"],
    "selling_associate_office_address": ["Selling Associate", "Office"],
    "selling_associate_office_city": ["City"],
    "selling_associate_office_state": ["State"],
    "selling_associate_office_zip": ["Zip"],
    "other_broker_compensation_percentage": ["Sales Price", "%"],
    "other_broker_compensation_amount": ["Sales Price", "$"],
    # Page 11 receipts
    "option_fee_form_of_payment": ["OPTION FEE RECEIPT", "form of"],
    "option_fee_escrow_agent_name": ["OPTION FEE", "Escrow Agent"],
    "earnest_money_form_of_payment": ["EARNEST MONEY RECEIPT", "form of"],
    "earnest_money_escrow_agent_name": ["EARNEST MONEY", "Escrow Agent"],
    "earnest_money_escrow_email": ["EARNEST MONEY", "Email"],
    "earnest_money_receipt_date": ["EARNEST MONEY", "Date"],
    "earnest_money_escrow_address": ["EARNEST MONEY", "Address"],
    "earnest_money_escrow_phone": ["EARNEST MONEY", "Phone"],
    "earnest_money_escrow_city": ["EARNEST MONEY", "City"],
    "earnest_money_escrow_state": ["EARNEST MONEY", "State"],
    "earnest_money_escrow_zip": ["EARNEST MONEY", "Zip"],
    "earnest_money_escrow_fax": ["EARNEST MONEY", "Fax"],
    "contract_receipt_escrow_agent_name": ["CONTRACT RECEIPT", "Escrow Agent"],
    "contract_receipt_escrow_email": ["CONTRACT RECEIPT", "Email"],
    "contract_receipt_date": ["CONTRACT RECEIPT", "Date"],
    "contract_receipt_escrow_address": ["CONTRACT RECEIPT", "Address"],
    "contract_receipt_escrow_phone": ["CONTRACT RECEIPT", "Phone"],
    "contract_receipt_escrow_city": ["CONTRACT RECEIPT", "City"],
    "contract_receipt_escrow_state": ["CONTRACT RECEIPT", "State"],
    "contract_receipt_escrow_zip": ["CONTRACT RECEIPT", "Zip"],
    "contract_receipt_escrow_fax": ["CONTRACT RECEIPT", "Fax"],
    "additional_earnest_money_form_of_payment": ["ADDITIONAL EARNEST", "form of"],
    "additional_earnest_money_escrow_agent_name": ["ADDITIONAL EARNEST", "Escrow Agent"],
    "additional_earnest_money_escrow_email": ["ADDITIONAL EARNEST", "Email"],
    "additional_earnest_money_receipt_date": ["ADDITIONAL EARNEST", "Date"],
    "additional_earnest_money_escrow_address": ["ADDITIONAL EARNEST", "Address"],
    "additional_earnest_money_escrow_phone": ["ADDITIONAL EARNEST", "Phone"],
    "additional_earnest_money_escrow_city": ["ADDITIONAL EARNEST", "City"],
    "additional_earnest_money_escrow_state": ["ADDITIONAL EARNEST", "State"],
    "additional_earnest_money_escrow_zip": ["ADDITIONAL EARNEST", "Zip"],
    "additional_earnest_money_escrow_fax": ["ADDITIONAL EARNEST", "Fax"],
    # Initials (always footer — skip text match, presume correct by y>=0.95)
    "buyer_initials": ["FOOTER"],
    "seller_initials": ["FOOTER"],
}

# Cross-paragraph red flag — fixture says X but context shows totally different paragraph
PARAGRAPH_MARKERS = {
    "PARTIES": "p1_para_1",
    "LAND": "p1_para_2_A",
    "EXCLUSIONS": "p1_para_2_D",
    "SALES PRICE": "p1_para_3",
    "Third Party Financing": "p1_para_3_B",
    "RESIDENTIAL LEASES": "p1_para_4_A",
    "FIXTURE LEASES": "p1_para_4_B",
    "Natural Resource": "p1_para_4_C",
    "EARNEST MONEY AND TERMINATION": "p2_para_5",
    "TERMINATION OPTION": "p2_para_5_B",
    "TITLE POLICY": "p2_para_6_A",
    "SURVEY": "p3_para_6_C",
    "OBJECTIONS": "p3_para_6_D",
    "TITLE NOTICES": "p3_para_6_E",
    "MEMBERSHIP IN PROPERTY OWNERS": "p3_para_6_E_2",
    "REQUIRED NOTICES": "p4_para_6_E_12",
    "MOLD REMEDIATION": "p4_para_6_E_11",
    "SELLER'S DISCLOSURE": "p4_para_7_B",
    "LEAD": "p4_para_7_C",
    "ACCEPTANCE OF PROPERTY": "p5_para_7_D",
    "RESIDENTIAL SERVICE CONTRACTS": "p5_para_7_H",
    "BROKERS AND SALES": "p5_para_8",
    "CLOSING": "p5_para_9",
    "POSSESSION": "p6_para_10",
    "SPECIAL PROVISIONS": "p6_para_11",
    "SETTLEMENT AND OTHER": "p6_para_12",
    "NOTICES": "p8_para_21",
    "AGREEMENT OF PARTIES": "p8_para_22",
    "CONSULT AN ATTORNEY": "p8_para_23",
    "EXECUTED": "p9_executed",
    "BROKER INFORMATION": "p10_broker",
    "OPTION FEE RECEIPT": "p11_option_fee",
    "EARNEST MONEY RECEIPT": "p11_earnest",
    "CONTRACT RECEIPT": "p11_contract",
    "ADDITIONAL EARNEST MONEY RECEIPT": "p11_addl_earnest",
}

def detected_paragraphs(text):
    if not text:
        return []
    found = []
    for marker, slug in PARAGRAPH_MARKERS.items():
        if marker.lower() in text.lower():
            found.append(slug)
    return found

def classify(row):
    idx = row["index"]
    fk = row["fixture_key"]
    if not fk:
        return ("UNCERTAIN", "no fixture_key", [])
    wide = row.get("wide_context") or ""
    narrow = row.get("narrow_context") or ""
    # Initials always at footer y >= 0.95
    if fk in ("buyer_initials", "seller_initials"):
        if row["y"] >= 0.94:
            return ("CONFIRMED", "footer initials by position", [])
        return ("MISLABEL", f"initials but y={row['y']} not footer", detected_paragraphs(wide))
    expectations = KEY_EXPECTATIONS.get(fk)
    if expectations is None:
        return ("UNCERTAIN", f"no expectation rule for key '{fk}'", detected_paragraphs(wide))
    paras_in_context = detected_paragraphs(wide)
    matches = [e for e in expectations if e.lower() in wide.lower()]
    if len(matches) >= max(1, len(expectations) // 2):
        return ("CONFIRMED", f"matched tokens: {matches}", paras_in_context)
    return ("MISLABEL_OR_UNCERTAIN", f"expected {expectations}, found_tokens={matches}", paras_in_context)

verdicts = {"CONFIRMED": [], "MISLABEL_OR_UNCERTAIN": [], "UNCERTAIN": [], "MISLABEL": []}
for r in ctx["rows"]:
    v, why, paras = classify(r)
    verdicts[v].append({"index": r["index"], "fixture_key": r["fixture_key"], "page": r["actual_page_from_fieldmap"], "y": r["y"], "why": why, "paragraphs_in_context": paras, "wide_excerpt": (r.get("wide_context") or "")[:200]})

print(f"CONFIRMED: {len(verdicts['CONFIRMED'])}")
print(f"MISLABEL_OR_UNCERTAIN: {len(verdicts['MISLABEL_OR_UNCERTAIN'])}")
print(f"UNCERTAIN: {len(verdicts['UNCERTAIN'])}")
print(f"MISLABEL: {len(verdicts['MISLABEL'])}")
print()

print("=== MISLABEL ===")
for r in verdicts["MISLABEL"]:
    print(f"  idx={r['index']} fk={r['fixture_key']} page={r['page']} y={r['y']:.3f} | {r['why']}")
    print(f"    context: {r['wide_excerpt']!r}")
print()
print("=== MISLABEL_OR_UNCERTAIN ===")
for r in verdicts["MISLABEL_OR_UNCERTAIN"]:
    print(f"  idx={r['index']} fk={r['fixture_key']} page={r['page']} y={r['y']:.3f} | {r['why']}")
    print(f"    paragraphs_detected: {r['paragraphs_in_context']}")
    print(f"    context: {r['wide_excerpt']!r}")
print()
print("=== UNCERTAIN ===")
for r in verdicts["UNCERTAIN"]:
    print(f"  idx={r['index']} fk={r['fixture_key']} page={r['page']} y={r['y']:.3f} | {r['why']}")
    print(f"    paragraphs_detected: {r['paragraphs_in_context']}")
    print(f"    context: {r['wide_excerpt']!r}")

# Save full breakdown
out_path = Path(r"C:\Users\Heath Shepard\Desktop\trec-20-18-audit-classification.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(verdicts, f, indent=2, ensure_ascii=False)
print(f"\nFull classification written to {out_path}")
