"""
Final paragraph-attribution pass for TREC 20-18 deep-read labels.

For each label, derive the actual paragraph by mapping (page, y) -> paragraph
using a hand-curated y-range map per page derived from the PDF text dump.
"""
import json
from pathlib import Path

ctx_path = Path(r"C:\Users\Heath Shepard\Desktop\trec-20-18-audit-context.json")
with open(ctx_path, "r", encoding="utf-8") as f:
    ctx = json.load(f)

# (page, y_min, y_max) -> paragraph_id, paragraph_name
# Y values are normalized (0=top, 1=bottom). Ranges are inclusive lower, exclusive upper.
PARAGRAPH_RANGES = [
    # PAGE 1
    (1, 0.000, 0.075, "p1_header", "page header (Contract Concerning ___)"),
    (1, 0.075, 0.175, "p1_para_1", "1. PARTIES (Seller / Buyer names)"),
    (1, 0.175, 0.265, "p1_para_2_A", "2.A LAND (Lot/Block/Addition/City/County/Texas/zip)"),
    (1, 0.265, 0.485, "p1_para_2_B_C", "2.B IMPROVEMENTS / 2.C ACCESSORIES (boilerplate)"),
    (1, 0.485, 0.555, "p1_para_2_D_E", "2.D EXCLUSIONS / 2.E RESERVATIONS"),
    (1, 0.555, 0.680, "p1_para_3", "3. SALES PRICE (cash, financing addenda, sales price)"),
    (1, 0.680, 0.870, "p1_para_4", "4. LEASES (4.A residential, 4.B fixture, 4.C natural resource)"),
    (1, 0.870, 0.955, "p1_para_4_C", "4.C NATURAL RESOURCE LEASES continuation (delivered Y/N + days)"),
    (1, 0.955, 1.001, "p1_footer", "page footer (initials)"),
    # PAGE 2
    (2, 0.000, 0.070, "p2_header", "page header"),
    (2, 0.070, 0.505, "p2_para_5", "5. EARNEST MONEY AND TERMINATION OPTION (5.A delivery + 5.B termination)"),
    (2, 0.505, 0.540, "p2_para_6_intro", "6. TITLE POLICY AND SURVEY intro"),
    (2, 0.540, 0.800, "p2_para_6_A", "6.A TITLE POLICY (Title Company, expense, area shortage amendment, mineral exception)"),
    (2, 0.800, 0.955, "p2_para_6_B", "6.B COMMITMENT"),
    (2, 0.955, 1.001, "p2_footer", "page footer"),
    # PAGE 3
    (3, 0.000, 0.070, "p3_header", "page header"),
    (3, 0.070, 0.260, "p3_para_6_C", "6.C SURVEY (3 mutually exclusive checkboxes + days)"),
    (3, 0.260, 0.525, "p3_para_6_D", "6.D OBJECTIONS"),
    (3, 0.525, 0.955, "p3_para_6_E", "6.E TITLE NOTICES (abstract, HOA, Tax Districts, Tide, Annexation, Cert Service Area, etc.)"),
    (3, 0.955, 1.001, "p3_footer", "page footer"),
    # PAGE 4
    (4, 0.000, 0.070, "p4_header", "page header"),
    (4, 0.070, 0.610, "p4_para_6_E", "6.E TITLE NOTICES continued (Tide, Annexation, Cert Service, PID, Transfer Fees, Propane, Water, Mold)"),
    (4, 0.610, 0.690, "p4_para_6_E_12", "6.E.(12) REQUIRED NOTICES free-text list"),
    (4, 0.690, 0.770, "p4_para_7_A", "7.A ACCESS, INSPECTIONS AND UTILITIES"),
    (4, 0.770, 0.890, "p4_para_7_B", "7.B SELLER'S DISCLOSURE NOTICE (3 checkboxes + days)"),
    (4, 0.890, 0.955, "p4_para_7_C_D", "7.C LEAD-PAINT (boilerplate) / 7.D ACCEPTANCE OF PROPERTY CONDITION intro"),
    (4, 0.955, 1.001, "p4_footer", "page footer"),
    # PAGE 5
    (5, 0.000, 0.070, "p5_header", "page header"),
    (5, 0.070, 0.210, "p5_para_7_D", "7.D ACCEPTANCE OF PROPERTY CONDITION (As Is / repairs)"),
    (5, 0.210, 0.420, "p5_para_7_E_F_G", "7.E lender repairs / 7.F repairs completion / 7.G environmental"),
    (5, 0.420, 0.600, "p5_para_7_G_H", "7.G environmental / 7.H residential service contracts (incl. $ cap)"),
    (5, 0.600, 0.720, "p5_para_8", "8. BROKERS AND SALES AGENTS"),
    (5, 0.720, 0.955, "p5_para_9", "9. CLOSING (date + delivery requirements)"),
    (5, 0.955, 1.001, "p5_footer", "page footer"),
    # PAGE 6
    (6, 0.000, 0.070, "p6_header", "page header"),
    (6, 0.070, 0.140, "p6_para_9", "9. CLOSING continued"),
    (6, 0.140, 0.380, "p6_para_10", "10. POSSESSION (10.A delivery + 10.B Smart Devices)"),
    (6, 0.380, 0.490, "p6_para_11", "11. SPECIAL PROVISIONS"),
    (6, 0.490, 0.855, "p6_para_12", "12. SETTLEMENT AND OTHER EXPENSES"),
    (6, 0.855, 0.955, "p6_para_13", "13. PRORATIONS"),
    (6, 0.955, 1.001, "p6_footer", "page footer"),
    # PAGE 7 (no fillable widgets except header + footer)
    (7, 0.000, 0.070, "p7_header", "page header"),
    (7, 0.070, 0.955, "p7_paras_14_20", "14 Casualty / 15 Default / 16 Mediation / 17 Attorney's Fees / 18 Escrow / 19 Reps / 20 Federal"),
    (7, 0.955, 1.001, "p7_footer", "page footer"),
    # PAGE 8
    (8, 0.000, 0.070, "p8_header", "page header"),
    (8, 0.070, 0.270, "p8_para_21", "21. NOTICES (Buyer/Seller addresses, phones, email/fax, copy-to-agent)"),
    (8, 0.270, 0.655, "p8_para_22", "22. AGREEMENT OF PARTIES (addenda checkbox list)"),
    (8, 0.655, 0.955, "p8_para_23", "23. CONSULT AN ATTORNEY (Buyer/Seller attorney name, phone, fax, email)"),
    (8, 0.955, 1.001, "p8_footer", "page footer"),
    # PAGE 9
    (9, 0.000, 0.070, "p9_header", "page header"),
    (9, 0.070, 0.470, "p9_executed", "EXECUTED block (day, month, year — Effective Date)"),
    (9, 0.470, 0.755, "p9_signatures", "Buyer/Seller signature lines (Buyer1/Seller1 row ~0.479; Buyer2/Seller2 row ~0.616)"),
    (9, 0.755, 0.955, "p9_disclaimer", "TREC approval boilerplate"),
    (9, 0.955, 1.001, "p9_footer", "page footer"),
    # PAGE 10 — BROKER INFORMATION
    # Widget y-positions sit ABOVE their label text (input box on top, label below).
    # Page 10 label-text y from PDF dump: 0.202(firm), 0.229(represents), 0.247(rep cont), 0.291(assoc name),
    # 0.329(team), 0.367(assoc email/phone), 0.403(supervisor), 0.441(broker address), 0.480(city),
    # 0.518(selling assoc name), 0.554(selling team), 0.592(selling email), 0.629(selling supervisor),
    # 0.667(selling address), 0.707(selling city), 0.751(disclosure)
    # Widgets sit ~0.015-0.020 ABOVE label; so row boundaries cover widget_y from (label_y - 0.025) to label_y itself.
    (10, 0.000, 0.070, "p10_header", "page header"),
    (10, 0.070, 0.180, "p10_broker_intro", "BROKER INFORMATION intro (Print name(s) only)"),
    (10, 0.180, 0.225, "p10_broker_firm_row", "Other Broker Firm | Listing Broker Firm + License Nos (label y=0.202; widget y ~0.189)"),
    (10, 0.225, 0.270, "p10_broker_represents", "represents block (label y=0.229+0.247; widget y ~0.218 + 0.251)"),
    (10, 0.270, 0.310, "p10_associate_name_row", "Associate's Name (Other) | Listing Associate's Name (label y=0.291; widget y ~0.273-0.290)"),
    (10, 0.310, 0.345, "p10_team_name_row", "Team Name (label y=0.329; widget y ~0.312)"),
    (10, 0.345, 0.385, "p10_associate_email_row", "Associate's Email/Phone | Listing Associate's Email/Phone (label y=0.367; widget y ~0.347-0.350)"),
    (10, 0.385, 0.420, "p10_supervisor_row", "Licensed Supervisor of Associate / Listing Associate (label y=0.403; widget y ~0.386)"),
    (10, 0.420, 0.460, "p10_broker_address_row", "Other Broker's Address/Phone | Listing Broker's Office Address/Phone (label y=0.441; widget y ~0.424-0.425)"),
    (10, 0.460, 0.495, "p10_broker_city_row", "City/State/Zip Other + Listing Broker (label y=0.480; widget y ~0.461-0.462)"),
    (10, 0.495, 0.530, "p10_selling_associate_name_row", "Selling Associate's Name + License No (label y=0.518; widget y ~0.500)"),
    (10, 0.530, 0.570, "p10_selling_team_row", "Team Name Selling (label y=0.554; widget y ~0.536)"),
    (10, 0.570, 0.605, "p10_selling_email_row", "Selling Associate's Email/Phone (label y=0.592; widget y ~0.574)"),
    (10, 0.605, 0.640, "p10_selling_supervisor_row", "Licensed Supervisor of Selling Associate (label y=0.629; widget y ~0.612)"),
    (10, 0.640, 0.680, "p10_selling_address_row", "Selling Associate's Office Address (label y=0.667; widget y ~0.650)"),
    (10, 0.680, 0.745, "p10_selling_city_row", "City/State/Zip Selling (label y=0.707; widget y ~0.689-0.690)"),
    (10, 0.745, 0.830, "p10_disclosure", "Disclosure: Listing Broker pays Other Broker $/% of Sales Price (label y=0.751; widget y ~0.802 in checkbox row)"),
    (10, 0.830, 0.955, "p10_disclosure_continuation", "Disclosure continuation"),
    (10, 0.955, 1.001, "p10_footer", "page footer"),
    # PAGE 11 — RECEIPTS
    (11, 0.000, 0.070, "p11_header", "page header"),
    (11, 0.070, 0.205, "p11_option_fee", "OPTION FEE RECEIPT (Receipt of $... Option Fee... in the form of... Escrow Agent)"),
    (11, 0.205, 0.370, "p11_earnest", "EARNEST MONEY RECEIPT (Escrow Agent / Email / Date / Address / Phone / City / State / Zip / Fax)"),
    (11, 0.370, 0.525, "p11_contract", "CONTRACT RECEIPT (Escrow Agent / Email / Date / Address / Phone / City / State / Zip / Fax)"),
    (11, 0.525, 0.685, "p11_addl_earnest", "ADDITIONAL EARNEST MONEY RECEIPT (Escrow Agent / Email / Date / Address / Phone / City / State / Zip / Fax)"),
    (11, 0.685, 0.955, "p11_footer_area", "page bottom"),
    (11, 0.955, 1.001, "p11_footer", "page footer"),
]

def lookup_paragraph(page, y):
    for p, ymin, ymax, pid, pname in PARAGRAPH_RANGES:
        if p == page and ymin <= y < ymax:
            return pid, pname
    return None, f"unmapped y={y} on page {page}"

# Map each fixture_key prefix to expected paragraph IDs
KEY_TO_PARAS = {
    # PARTIES
    "seller_names": ["p1_para_1"],
    "buyer_names":  ["p1_para_1"],
    # LAND
    "lot": ["p1_para_2_A"],
    "block": ["p1_para_2_A"],
    "legal_description_continuation": ["p1_para_2_A"],
    "addition": ["p1_para_2_A"],
    "county": ["p1_para_2_A"],
    "property_address_line1": ["p1_para_2_A", "p2_header", "p3_header", "p4_header", "p5_header", "p6_header", "p7_header", "p8_header", "p9_header", "p10_header", "p11_header"],
    # EXCLUSIONS
    "property_exclusions": ["p1_para_2_D_E"],
    "property_exclusions_continuation": ["p1_para_2_B_C", "p1_para_2_D_E"],
    # SALES PRICE
    "cash_portion_amount": ["p1_para_3"],
    "financing_sum_amount": ["p1_para_3"],
    "sales_price_amount": ["p1_para_3"],
    "addendum_third_party_financing": ["p1_para_3", "p8_para_22"],
    "addendum_loan_assumption": ["p1_para_3", "p8_para_22"],
    "addendum_seller_financing": ["p1_para_3", "p8_para_22"],
    # LEASES
    "addendum_residential_leases": ["p1_para_4"],
    "addendum_fixture_leases": ["p1_para_4"],
    "addendum_natural_resource_leases": ["p1_para_4", "p1_para_4_C"],
    "natural_resource_leases_delivered": ["p1_para_4", "p1_para_4_C"],
    # EARNEST/OPTION (page 2 para 5)
    "earnest_money": ["p2_para_5"],
    "option_fee": ["p2_para_5"],
    "earnest_holder_name": ["p2_para_5"],
    "earnest_holder_address": ["p2_para_5"],
    "earnest_holder_address_continuation": ["p2_para_5"],
    "additional_earnest_money": ["p2_para_5"],
    "additional_earnest_money_days": ["p2_para_5"],
    "option_period_days": ["p2_para_5"],
    # TITLE/SURVEY
    "title_company": ["p2_para_6_A"],
    "title_policy_paid_by": ["p2_para_6_A"],
    "title_exception_amendment_paid_by": ["p2_para_6_A"],
    "title_policy_paid_by_buyer_days": ["p2_para_6_A", "p2_para_5"],  # could be either
    "title_objection_days": ["p3_para_6_D"],
    "existing_survey_required": ["p3_para_6_C"],
    "survey_days_prior_to_closing": ["p3_para_6_C"],
    # HOA / NOTICES (6.E)
    "hoa_subdivision_information_is_subject": ["p3_para_6_E"],
    "required_notices_list": ["p4_para_6_E_12", "p4_para_6_E"],
    "required_notices_list_continuation": ["p4_para_6_E_12", "p4_para_6_E", "p4_para_7_A"],
    "improvement_district_text": ["p4_para_6_E"],
    # PROPERTY CONDITION
    "sellers_disclosure_days": ["p4_para_7_B"],
    "sellers_disclosure_received": ["p4_para_7_B"],
    "repairs_list": ["p5_para_7_D"],
    "repairs_list_continuation": ["p5_para_7_D"],
    "homeowners_warranty_limit": ["p5_para_7_G_H"],
    "property_condition_acceptance": ["p5_para_7_D", "p4_para_7_C_D"],
    # CLOSING
    "closing_date": ["p5_para_9"],
    "closing_date_year": ["p5_para_9"],
    # POSSESSION (page 6)
    "possession_upon_closing": ["p6_para_10"],
    "possession_credit_to_sales_price": ["p6_para_10"],
    # SPECIAL PROVISIONS
    "special_provisions_line_0": ["p6_para_11", "p6_para_12"],  # widget at y=0.442 is borderline 11/12
    "special_provisions": ["p6_para_11"],
    # SETTLEMENT (12)
    # NOTICES (page 8 para 21)
    "notice_to_buyer_name": ["p8_para_21"],
    "notice_to_seller_name": ["p8_para_21"],
    "notice_to_buyer_address_line_2": ["p8_para_21"],
    "notice_to_seller_address_line_2": ["p8_para_21"],
    "notice_to_buyer_phone_area_code": ["p8_para_21"],
    "notice_to_buyer_phone": ["p8_para_21"],
    "notice_to_seller_phone": ["p8_para_21"],
    "notice_to_buyer_email_fax_line_1": ["p8_para_21"],
    "notice_to_seller_email_fax_line_1": ["p8_para_21"],
    "notice_to_buyer_email_fax_line_2": ["p8_para_21"],
    "notice_to_seller_email_fax_line_2": ["p8_para_21"],
    "notice_to_buyer_copy_to_agent": ["p8_para_21"],
    # ADDENDA (page 8 para 22)
    "addendum_environmental": ["p8_para_22"],
    "addendum_sellers_lease": ["p8_para_22"],
    "hoa_addendum": ["p8_para_22"],
    "addendum_short_sale": ["p8_para_22"],
    "addendum_buyers_lease": ["p8_para_22"],
    "addendum_coastal": ["p8_para_22"],
    "addendum_lead_paint_required": ["p8_para_22"],
    "addendum_sellers_disclosure": ["p8_para_22"],
    "addendum_authorizing_hydrostatic_testing": ["p8_para_22"],
    "addendum_oil_gas": ["p8_para_22"],
    "addendum_other": ["p8_para_22"],
    "addendum_lender_appraisal_termination": ["p8_para_22"],
    "addendum_hydrostatic_testing": ["p8_para_22"],
    "addendum_pid_notice": ["p8_para_22"],
    "addendum_other_list": ["p8_para_22"],
    "addendum_other_list_line_2": ["p8_para_22"],
    "addendum_other_list_line_3": ["p8_para_22"],
    "addendum_other_list_line_4": ["p8_para_22"],
    "backup_contract": ["p8_para_22"],
    "addendum_propane": ["p8_para_22"],
    # ATTORNEY (page 8 para 23)
    "buyer_attorney_name": ["p8_para_23"],
    "seller_attorney_name": ["p8_para_23"],
    "buyer_attorney_info": ["p8_para_23"],
    "seller_attorney_info": ["p8_para_23"],
    "buyer_attorney_phone_area_code": ["p8_para_23"],
    "buyer_attorney_phone": ["p8_para_23"],
    "seller_attorney_phone_area_code": ["p8_para_23"],
    "seller_attorney_phone": ["p8_para_23"],
    "buyer_attorney_fax_area_code": ["p8_para_23"],
    "buyer_attorney_fax": ["p8_para_23"],
    "seller_attorney_fax_area_code": ["p8_para_23"],
    "seller_attorney_fax": ["p8_para_23"],
    "buyer_attorney_email": ["p8_para_23"],
    "seller_attorney_email": ["p8_para_23"],
    # EFFECTIVE / SIGNATURES (page 9)
    "effective_date_day": ["p9_executed"],
    "effective_date_month": ["p9_executed"],
    "effective_date_year": ["p9_executed"],
    "buyer_signature_1": ["p9_signatures"],
    "buyer_signature_2": ["p9_signatures"],
    "seller_signature_1": ["p9_signatures"],
    "seller_signature_2": ["p9_signatures"],
    # BROKER INFO (page 10)
    "other_broker_firm_name": ["p10_broker_firm_row", "p10_broker_intro"],
    "other_broker_license": ["p10_broker_firm_row"],
    "other_broker_represents": ["p10_broker_represents"],
    "other_broker_associate_name": ["p10_associate_name_row"],
    "other_broker_associate_license": ["p10_associate_name_row"],
    "other_broker_associate_team_name": ["p10_team_name_row"],
    "other_broker_associate_email": ["p10_associate_email_row"],
    "other_broker_associate_phone": ["p10_associate_email_row"],
    "other_broker_supervisor_name": ["p10_supervisor_row"],
    "other_broker_supervisor_license": ["p10_supervisor_row"],
    "other_broker_address": ["p10_broker_address_row"],
    "other_broker_phone": ["p10_broker_address_row"],
    "other_broker_city": ["p10_broker_city_row"],
    "other_broker_state": ["p10_broker_city_row"],
    "other_broker_zip": ["p10_broker_city_row"],
    "listing_broker_license": ["p10_broker_firm_row"],
    "listing_broker_represents": ["p10_broker_represents"],
    "listing_associate_name": ["p10_associate_name_row", "p10_team_name_row"],
    "listing_associate_license": ["p10_associate_name_row"],
    "listing_associate_email": ["p10_associate_email_row"],
    "listing_associate_phone": ["p10_associate_email_row"],
    "listing_associate_supervisor_name": ["p10_supervisor_row"],
    "listing_associate_supervisor_license": ["p10_supervisor_row"],
    "listing_broker_office_address": ["p10_broker_address_row"],
    "listing_broker_office_phone": ["p10_broker_address_row"],
    "listing_broker_office_city": ["p10_broker_city_row"],
    "listing_broker_office_state": ["p10_broker_city_row"],
    "listing_broker_office_zip": ["p10_broker_city_row"],
    "selling_associate_name": ["p10_selling_associate_name_row"],
    "selling_associate_license": ["p10_selling_associate_name_row"],
    "selling_associate_team_name": ["p10_selling_team_row"],
    "selling_associate_email": ["p10_selling_email_row"],
    "selling_associate_phone": ["p10_selling_email_row"],
    "selling_associate_supervisor_name": ["p10_selling_supervisor_row"],
    "selling_associate_supervisor_license": ["p10_selling_supervisor_row"],
    "selling_associate_office_address": ["p10_selling_address_row"],
    "selling_associate_office_city": ["p10_selling_city_row"],
    "selling_associate_office_state": ["p10_selling_city_row"],
    "selling_associate_office_zip": ["p10_selling_city_row"],
    "other_broker_compensation_percentage": ["p10_disclosure"],
    "other_broker_compensation_amount": ["p10_disclosure"],
    # RECEIPTS (page 11)
    "option_fee_form_of_payment": ["p11_option_fee"],
    "option_fee_escrow_agent_name": ["p11_option_fee", "p11_earnest"],  # the y=0.167 is right at boundary
    "earnest_money_form_of_payment": ["p11_earnest"],
    "earnest_money_escrow_agent_name": ["p11_earnest"],
    "earnest_money_escrow_email": ["p11_earnest"],
    "earnest_money_receipt_date": ["p11_earnest"],
    "earnest_money_escrow_address": ["p11_earnest"],
    "earnest_money_escrow_phone": ["p11_earnest"],
    "earnest_money_escrow_city": ["p11_earnest"],
    "earnest_money_escrow_state": ["p11_earnest"],
    "earnest_money_escrow_zip": ["p11_earnest"],
    "earnest_money_escrow_fax": ["p11_earnest"],
    "contract_receipt_escrow_agent_name": ["p11_contract"],
    "contract_receipt_escrow_email": ["p11_contract"],
    "contract_receipt_date": ["p11_contract"],
    "contract_receipt_escrow_address": ["p11_contract"],
    "contract_receipt_escrow_phone": ["p11_contract"],
    "contract_receipt_escrow_city": ["p11_contract"],
    "contract_receipt_escrow_state": ["p11_contract"],
    "contract_receipt_escrow_zip": ["p11_contract"],
    "contract_receipt_escrow_fax": ["p11_contract"],
    "additional_earnest_money_form_of_payment": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_agent_name": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_email": ["p11_addl_earnest"],
    "additional_earnest_money_receipt_date": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_address": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_phone": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_city": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_state": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_zip": ["p11_addl_earnest"],
    "additional_earnest_money_escrow_fax": ["p11_addl_earnest"],
    # FOOTER INITIALS
    "buyer_initials": ["p1_footer", "p2_footer", "p3_footer", "p4_footer", "p5_footer", "p6_footer", "p7_footer", "p8_footer", "p9_footer", "p10_footer", "p11_footer"],
    "seller_initials": ["p1_footer", "p2_footer", "p3_footer", "p4_footer", "p5_footer", "p6_footer", "p7_footer", "p8_footer", "p9_footer", "p10_footer", "p11_footer"],
}

confirmed = []
mislabel = []
uncertain = []
unmapped_keys = set()

for r in ctx["rows"]:
    idx = r["index"]
    fk = r["fixture_key"]
    page = r["actual_page_from_fieldmap"]
    y = r["y"]
    pid, pname = lookup_paragraph(page, y)
    expected = KEY_TO_PARAS.get(fk)
    rec = {
        "index": idx,
        "fixture_key": fk,
        "page": page,
        "y": round(y, 4),
        "actual_paragraph_id": pid,
        "actual_paragraph_name": pname,
        "expected_paragraph_ids": expected,
        "widget_name": r["widget_name"],
        "wide_excerpt": (r.get("wide_context") or "")[:200]
    }
    if expected is None:
        unmapped_keys.add(fk)
        uncertain.append(rec)
        continue
    if pid in expected:
        confirmed.append(rec)
    else:
        mislabel.append(rec)

print(f"CONFIRMED: {len(confirmed)} ({len(confirmed)/len(ctx['rows'])*100:.1f}%)")
print(f"MISLABEL : {len(mislabel)}")
print(f"UNCERTAIN: {len(uncertain)} (keys not in expectation map)")
print()

print("===== MISLABELS =====")
for m in mislabel:
    print(f"\n  idx={m['index']} fk={m['fixture_key']}")
    print(f"    page={m['page']} y={m['y']}")
    print(f"    ACTUAL paragraph: {m['actual_paragraph_id']} = {m['actual_paragraph_name']}")
    print(f"    EXPECTED: {m['expected_paragraph_ids']}")
    print(f"    widget_name: {m['widget_name'][:60]!r}")
    print(f"    context: {m['wide_excerpt']!r}")

print()
print(f"===== UNCERTAIN KEYS (no expectation rule) =====")
for k in sorted(unmapped_keys):
    print(f"  {k}")

# Write final audit JSON
out = {
    "audited_at": "2026-06-20T00:00:00Z",
    "audited_by": "hadley",
    "audit_method": "Cross-referenced widget (page, y) coordinates from PDF field map against hand-curated paragraph y-range map derived from PyMuPDF text extraction of the live TREC 20-18 PDF (api/_assets/trec-20-18-raw.pdf, 11-04-2024 version, 11 pages). For each label in trec-20-18-labels-jarvis-deep-read.json, classified the widget's actual paragraph by y-position and compared against the paragraph(s) consistent with the fixture_key. CONFIRMED = paragraph matches; MISLABEL = paragraph contradicts; UNCERTAIN = key not in expectation map.",
    "audit_target_file": "C:\\Users\\Heath Shepard\\Desktop\\trec-20-18-labels-jarvis-deep-read.json",
    "pdf_source": "C:\\Users\\Heath Shepard\\Desktop\\MeetDossie\\api\\_assets\\trec-20-18-raw.pdf",
    "field_map_source": "C:\\Users\\Heath Shepard\\Desktop\\MeetDossie\\scripts\\trec-20-18-field-map.json",
    "audited_count": len(ctx["rows"]),
    "confirmed_count": len(confirmed),
    "mislabels": mislabel,
    "still_uncertain_keys_no_expectation_rule": sorted(unmapped_keys),
    "still_uncertain": uncertain,
    "method_caveats": [
        "Paragraph y-ranges hand-derived from PyMuPDF text blocks; may be off by +/-0.01-0.02 at paragraph boundaries.",
        "Pages 10/11 multi-row blocks (broker info, escrow receipts) require sub-row precision; ranges chosen to match observed block y positions in the PDF.",
        "Checkbox-only addenda on page 8 sit in one big 22.AGREEMENT OF PARTIES block — y can't disambiguate WHICH addendum row. Verified by widget_name + Hadley's prior rationale referencing labeler render.",
        "Pages 7 has no fillable widgets except footer per TREC 20-18 layout."
    ]
}

out_path = Path(r"C:\Users\Heath Shepard\Desktop\trec-20-18-audit-self-pass-2.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

print(f"\nFINAL AUDIT WRITTEN TO {out_path}")
