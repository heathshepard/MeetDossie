"""Spot check known-good and known-bad labels to verify extraction works."""
import json
from pathlib import Path

ctx_path = Path(r"C:\Users\Heath Shepard\Desktop\trec-20-18-audit-context.json")
with open(ctx_path, "r", encoding="utf-8") as f:
    ctx = json.load(f)

# Sanity checks
TARGETS = [
    (0,  "seller_names",        "should be PARTIES — Seller name"),
    (1,  "buyer_names",         "should be PARTIES — Buyer name"),
    (2,  "lot",                 "should be 2.A LAND — Lot"),
    (3,  "block",               "should be 2.A LAND — Block"),
    (10, "cash_portion_amount", "should be 3.A SALES PRICE — Cash portion"),
    (13, "addendum_seller_financing", "should be 3.B Seller Financing Addendum"),
    (21, "title_policy_paid_by_buyer_days", "should be earnest money days?"),
    (26, "property_address_line1", "should be page 2 header Contract Concerning"),
    (27, "earnest_money", "should be 5.A earnest money $"),
    (28, "option_fee", "should be 5.A option fee $"),
    (34, "option_period_days", "should be 5.B option period days"),
    (37, "title_company", "should be 6.A Title Company name"),
    (48, "survey_days_prior_to_closing", "should be 6.C survey days"),
    (49, "existing_survey_required", "should be 6.C survey opt (1)"),
    (56, "title_objection_days", "should be 6.D objection days"),
    (57, "hoa_subdivision_information_is_subject", "should be 6.E.(2) HOA 'is' checkbox"),
    (65, "required_notices_list", "should be 6.E.(12) required notices"),
    (69, "sellers_disclosure_days", "should be 7.B.(2) days"),
    (79, "repairs_list_continuation", "should be 7.D.(2) repairs"),
    (80, "homeowners_warranty_limit", "should be 7.H residential service $"),
    (83, "closing_date", "should be 9.A closing date"),
    (92, "special_provisions_line_0", "should be para 11 SPECIAL PROVISIONS"),
    (110, "notice_to_buyer_name", "should be 21 To Buyer at:"),
    (111, "notice_to_seller_name", "should be 21 To Seller at:"),
    (150, "buyer_attorney_name", "should be 23 Buyer's Attorney is:"),
    (177, "other_broker_firm_name", "should be page 10 Other Broker Firm"),
    (197, "listing_associate_supervisor_name", "should be 'Licensed Supervisor of Listing Associate'"),
    (209, "selling_associate_name", "should be 'Selling Associate's Name'"),
    (223, "other_broker_compensation_percentage", "should be '% of Sales Price' bottom of pg 10"),
    (226, "option_fee_form_of_payment", "should be page 11 OPTION FEE RECEIPT 'in the form of'"),
    (227, "option_fee_escrow_agent_name", "should be 'Escrow Agent' under OPTION FEE RECEIPT"),
    (234, "earnest_money_receipt_date", "should be Date/Time under EARNEST MONEY RECEIPT"),
    (241, "contract_receipt_escrow_agent_name", "should be 'Escrow Agent' under CONTRACT RECEIPT"),
    (252, "additional_earnest_money_form_of_payment", "should be ADDL EM RECEIPT 'in the form of'"),
]

rows_by_idx = {r["index"]: r for r in ctx["rows"]}

print("=" * 100)
for idx, expected_key, hint in TARGETS:
    r = rows_by_idx.get(idx)
    if not r:
        print(f"idx={idx} NOT FOUND in audit context (probably not in deep-read labels)")
        continue
    print(f"\nidx={idx} | claim={r['fixture_key']} | hint: {hint}")
    print(f"  page={r['actual_page_from_fieldmap']} pos x={r['x']} y={r['y']} w={r['w']} h={r['h']}")
    print(f"  widget_name={r['widget_name'][:60]!r}")
    print(f"  WIDE: {r['wide_context'][:250]!r}")
