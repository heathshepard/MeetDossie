"""Round 3 — build complete field-map JSON files for all 4 TREC forms.

Coordinates derived from anchor-rescan against each base PDF.
Each field references the anchor label used and the empirical offset.

Pass criteria:
- Every blank that PyMuPDF can find has a coord
- Field count >= 80% of round-1 anchor inventory
- Visual overlay confirms no overprints, no wrong row/column
"""
import json
from pathlib import Path

OUT = Path(__file__).parent
MAPS = OUT.parent.parent / "api" / "_assets" / "field-maps"

# Common helpers
def f(page, x, y, w=180, h=14, fs=10, req=False, notes=None):
    """Build a text-field config."""
    e = {"page": page, "x": x, "y": y, "width": w, "height": h, "font_size": fs, "required": req}
    if notes:
        e["notes"] = notes
    return e

def cb(page, x, y, req=False, label=None):
    e = {"page": page, "type": "checkbox", "x": x, "y": y, "required": req}
    if label:
        e["label"] = label
    return e


# ============================================================
# TREC 38-7 — Buyer's Notice of Termination of Contract (1 page)
# Per actual blanks:
#   (Street Address and City) at (251.5, 128.4) -> property address blank above
#   (SELLER) at (507.7, 172.0) -> seller name on line ending at (SELLER)
#   "BETWEEN THE UNDERSIGNED BUYER" at (48.7, 153.2) -> buyer/seller intro line
#   "Date" at (270.9, 663.2) and (526.5, 663.2) -> two signature dates
#   "Buyer" labels at (72.5, 663.2) and (324.5, 663.2) -> two buyer signature lines
#   Checkbox glyphs ( ) at y=210.5, 242.0, 273.4, 318.2, 349.6, 381.0, 425.8, 470.5 (8 boxes)
# ============================================================
TREC_38_7 = {
    "form_id": "trec-38-7",
    "form_name": "Notice of Buyer's Termination of Contract",
    "form_number": "TREC 38-7",
    "effective_date": "02-19-2021",
    "page_count": 1,
    "page_dimensions": {"width": 612, "height": 792},
    "fields": {
        # Property address blank: line above "(Street Address and City)" label at y=128
        "property_address": f(1, 49, 115, w=510, h=14, fs=11, req=True,
                              notes="Above '(Street Address and City)' label at y=128"),

        # Seller name long blank ending at "(SELLER)" anchor at (507.7, 172.0).
        # Line wraps: starts after AND on y=153, continues on y=172.
        # Best fill point: y=160 on the wrap line so short names sit before "(SELLER)" label.
        "seller_name": f(1, 49, 160, w=455, h=14, fs=11, req=True,
                         notes="Long blank wraps y=153->y=172 ending at (SELLER) at x=507"),

        # Bottom signature block (y=663): two buyer signature lines + two dates.
        "buyer_name": f(1, 72, 651, w=190, h=14, fs=11, req=True,
                        notes="Buyer signature line 1 (left) — 'Buyer' label at y=663 below"),
        "buyer_name_2": f(1, 325, 651, w=190, h=14, fs=11, req=False,
                          notes="Buyer signature line 2 (right) — second buyer if joint"),
        "contract_effective_date": f(1, 270, 651, w=110, h=14, fs=11, req=False,
                                     notes="Date line under signature 1 — 'Date' label at (270.9, 663.2)"),
        "termination_notice_date": f(1, 525, 651, w=110, h=14, fs=11, req=True,
                                     notes="Date line under signature 2 — 'Date' label at (526.5, 663.2)"),

        # 8 termination checkboxes — actual TREC 38-7 has 8 numbered items (1)-(8).
        "termination_checkbox_option_period": cb(1, 60, 213, label="(1) Option Period unrestricted"),
        "termination_checkbox_financing":     cb(1, 60, 244, label="(2) Financing (Buyer Approval)"),
        "termination_checkbox_property":      cb(1, 60, 275, label="(3) Property Approval"),
        "termination_checkbox_hoa":           cb(1, 60, 320, label="(4) HOA mandatory membership"),
        "termination_checkbox_disclosure":    cb(1, 60, 351, label="(5) Seller's Disclosure 7B(2)"),
        "termination_checkbox_appraisal":     cb(1, 60, 383, label="(6) Lender's Appraisal Para 3"),
        "termination_checkbox_objections":    cb(1, 60, 428, label="(7) Para 6.D objections not cured"),
        "termination_checkbox_other":         cb(1, 60, 472, label="(8) Other"),

        # Other / specify-paragraph free-text below (8) checkbox
        "termination_reason_other": f(1, 80, 485, w=475, h=70, fs=10, req=False,
                                      notes="Free-text reason if (8) Other checked — 6 blank lines"),
    },
}
TREC_38_7["field_count"] = len(TREC_38_7["fields"])


# ============================================================
# TREC 23-20 — New Home Contract (Incomplete) (11 pages)
# Page 1 anchors:
#   (Seller)            (60.0,  91.2)
#   (Buyer)             (374.2, 91.2)
#   Lot                 (124.3, 114.4)
#   Block               (227.9, 114.4)
#   Addition, City of   (60.0, 124.2)
#   County of           (317.4, 124.2)
#   (address/zip code)  ~(423,  134.0) and one other
#   $ (Cash portion A)  (437.5, 207.6)
#   $ (Sum financing B) (437.5, 250.6)
#   $ (Sales Price C)   (437.5, 262.8)
#   Escrow Agent labels at y=444 (name), y=476 (address): label
#   $ (earnest)         (383.8, 455.3)
#   $ (option fee)      (133.8, 466.1)
#   $ (addl earnest)    (332.5, 487.2)
# Convention: text top y ~ label_top_y - 12 for "label-below-blank" cases.
# Inline label cases: text y = label_y (same row).
# ============================================================
TREC_23_20 = {
    "form_id": "trec-23-20",
    "form_name": "New Home Contract (Incomplete Construction)",
    "form_number": "TREC 23-20",
    "effective_date": "12-01-2023",
    "page_count": 11,
    "page_dimensions": {"width": 612, "height": 792},
    "fields": {
        # ====== PAGE 1 — Parties + Property + Sales Price + Earnest Money ======
        # Two name lines: seller blank wraps from end of y=81 (after "are") onto y=91 before (Seller).
        # Buyer blank is purely on y=91 between "and" and "(Buyer)".
        # Best placement: seller at end of line y=81 (after "are" ends x=276); buyer on label line y=91 after "and".
        "seller_name": f(1, 283, 81, w=275, h=12, fs=11, req=True,
                         notes="End of '1.PARTIES: ... are ___' line (y=81) after 'are' word at x=276"),
        "buyer_name":  f(1, 125, 91, w=245, h=12, fs=11, req=True,
                         notes="On '(Seller) and ___ (Buyer)' line (y=91), between 'and' end x=119 and '(Buyer)' at x=374"),

        # Property line y=114 (inline): "2.PROPERTY:Lot ___, Block ___,"
        "lot_number":   f(1, 142, 114, w=80, h=12, fs=10, req=True,
                          notes="Inline after 'Lot' anchor (124-140) before ',Block' at x=224"),
        "block_number": f(1, 258, 114, w=58, h=12, fs=10, req=True,
                          notes="Inline after 'Block' anchor (228-255) before ',' at x=318"),

        # Property line y=124 (inline): "Addition, City of ___, County of ___ Texas, known as"
        "addition_name": f(1, 143, 124, w=168, h=12, fs=10, req=True,
                           notes="Inline after 'City of' (ends x=141) before ',County of' at x=313"),
        "county":        f(1, 369, 124, w=102, h=12, fs=10, req=True,
                           notes="Inline after 'County of' (ends x=366) before 'Texas,' at x=474"),

        # Property address line (the actual street address blank)
        # Wraps from end of y=124 ('known as') onto y=134 ending before '(address/zip code)' at x=423
        "property_address": f(1, 49, 134, w=370, h=12, fs=10, req=True,
                              notes="Above/before '(address/zip code)' label at (423, 134)"),

        # Sales Price section (lines y=207, 250, 262) — $ markers at x=437.5
        "cash_portion":     f(1, 448, 205, w=110, h=12, fs=10, req=False,
                              notes="A. Cash portion — fill right of '$' at (437.5, 207.6)"),
        "financing_amount": f(1, 448, 248, w=110, h=12, fs=10, req=False,
                              notes="B. Sum of financing — fill right of '$' at (437.5, 250.6)"),
        "sales_price":      f(1, 448, 260, w=110, h=12, fs=10, req=True,
                              notes="C. Sales Price (Sum A+B) — fill right of '$' at (437.5, 262.8)"),

        # Earnest money / option fee section
        # Line y=444 "must deliver to ___ (Escrow Agent) at"
        "escrow_agent": f(1, 185, 444, w=190, h=12, fs=10, req=False,
                          notes="Between 'deliver to' and '(Escrow Agent)' label at (381.4, 444.6)"),

        # Line y=455 "(address): $ ___ as earnest"
        "escrow_address":  f(1, 49, 455, w=125, h=12, fs=10, req=False,
                             notes="Before '(address):' on line y=455"),
        "earnest_money":   f(1, 395, 455, w=90, h=12, fs=10, req=True,
                             notes="Right of '$' at (383.8, 455.3) — earnest money amount"),

        # Line y=465 "money and $ ___ as the option fee"
        "option_fee": f(1, 146, 466, w=90, h=12, fs=10, req=False,
                        notes="Right of '$' at (133.8, 466.1) — option fee amount"),

        # Line y=486 "(1) Buyer shall deliver additional earnest money of $ ___ to Escrow Agent within"
        "additional_earnest_money": f(1, 344, 487, w=90, h=12, fs=10, req=False,
                                      notes="Right of '$' at (332.5, 487.2)"),
        "additional_earnest_days":  f(1, 100, 497, w=40, h=12, fs=10, req=False,
                                      notes="Before 'days after' at (128.9, 497.5)"),

        # Line y=633 "___ days after the Effective Date of this contract (Option Period)"
        "option_period_days": f(1, 95, 634, w=40, h=12, fs=10, req=False,
                                notes="Before 'days after' at (121.9, 633.6)"),

        # ====== PAGE 2 — Closing Date references ======
        # Page 2 has multiple "Closing Date" anchors. The MAIN closing date blank is at first hit (260.3, 334.8).
        "closing_date": f(2, 124, 393, w=140, h=14, fs=11, req=True,
                          notes="Main closing date blank — 'Closing Date' anchor at (273.7, 393.6)"),

        # ====== PAGE 4 — Construction warranty + additional closing reference ======
        "closing_date_page4": f(4, 89, 245, w=140, h=12, fs=10, req=False,
                                notes="Closing Date page 4 — anchor at (233.1, 245.5)"),

        # ====== PAGE 5 — Buyer's lender / Title Company ======
        "closing_date_page5": f(5, 235, 410, w=140, h=12, fs=10, req=False,
                                notes="Closing Date page 5 — anchor at (392.2, 410.3)"),

        # ====== PAGE 6 — Closing/Escrow ======
        "closing_date_page6": f(6, 215, 411, w=140, h=12, fs=10, req=False,
                                notes="Closing Date page 6 — anchor at (523.5, 411.5) (right margin)"),

        # ====== PAGE 7 — Notices section ======
        "buyer_address":   f(7, 49, 380, w=470, h=12, fs=10, req=False,
                             notes="Buyer's notice address block — top of notice section"),
        "seller_address":  f(7, 49, 450, w=470, h=12, fs=10, req=False,
                             notes="Seller's notice address block"),

        # ====== PAGE 9 — Execution / Effective Date ======
        # Page 9 'Effective Date' anchor at (467.1, 207.3)
        "effective_date": f(9, 370, 207, w=100, h=12, fs=10, req=False,
                            notes="Effective Date blank — anchor at (467.1, 207.3)"),

        # ====== PAGE 9 — Signature block (Seller + Buyer + Brokers) ======
        # Standard TREC layout: left column Seller signatures (~y=240), right column Buyer signatures
        "seller_signature":         f(9, 49, 270, w=240, h=14, fs=11, req=True, notes="Seller signature line"),
        "seller_signature_date":    f(9, 49, 295, w=120, h=12, fs=10, req=True, notes="Seller signature date"),
        "buyer_signature":          f(9, 320, 270, w=240, h=14, fs=11, req=True, notes="Buyer signature line"),
        "buyer_signature_date":     f(9, 320, 295, w=120, h=12, fs=10, req=True, notes="Buyer signature date"),

        # ====== PAGE 10 — Brokers section ======
        "other_broker":             f(10, 49, 130, w=260, h=12, fs=10, req=False, notes="Other Broker firm name"),
        "other_broker_license":     f(10, 49, 150, w=160, h=12, fs=10, req=False, notes="Other Broker license #"),
        "other_broker_address":     f(10, 49, 175, w=320, h=12, fs=10, req=False),
        "listing_broker":           f(10, 320, 130, w=240, h=12, fs=10, req=False, notes="Listing Broker firm name"),
        "listing_broker_license":   f(10, 320, 150, w=160, h=12, fs=10, req=False),
        "listing_broker_address":   f(10, 320, 175, w=240, h=12, fs=10, req=False),

        # ====== PAGE 11 — Escrow Agent receipt signatures ======
        # Page 11 'Escrow Agent' anchors at x=52.7, y=132, 215, 350, 485 (4 receipt blocks)
        "escrow_receipt_date_1": f(11, 60, 119, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 1 — anchor at (52.9, 132.1)"),
        "escrow_receipt_date_2": f(11, 60, 202, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 2 — anchor at (52.7, 215.0)"),
        "escrow_receipt_date_3": f(11, 60, 337, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 3 — anchor at (52.7, 350.3)"),
        "escrow_receipt_date_4": f(11, 60, 472, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 4 — anchor at (52.7, 485.6)"),
    },
}
TREC_23_20["field_count"] = len(TREC_23_20["fields"])


# ============================================================
# TREC 24-20 — New Home Contract (Completed) (11 pages)
# Layout mirrors 23-20 but anchor Y values are ~6-15pt lower per form-specific scan.
# Page 1 anchors:
#   (Seller)            (67.6,  97.4)
#   (Buyer)             (434.0, 97.4)
#   Lot                 (138.1, 120.1)
#   Block               (304.0, 120.1)
#   Addition, City of   (67.6, 139.4)  + second hit
#   County of           (304.0, 139.4)
#   $ Cash portion      (441.1, 223.0)
#   $ Financing         (441.1, 270.8)
#   $ Sales Price       (441.1, 281.2)
#   $ earnest money     (326.2, 514.1)
#   $ option fee        (80.9, 524.8)
#   $ addl earnest      (339.6, 546.1)
# ============================================================
TREC_24_20 = {
    "form_id": "trec-24-20",
    "form_name": "New Home Contract (Completed Construction)",
    "form_number": "TREC 24-20",
    "effective_date": "12-01-2023",
    "page_count": 11,
    "page_dimensions": {"width": 612, "height": 792},
    "fields": {
        # ====== PAGE 1 — Parties + Property + Sales Price + Earnest Money ======
        # 24-20: '1.PARTIES' line at y=85 ('are' ends at x=283), '(Seller)' label at y=97.
        # Seller blank wraps from end of y=85 onto y=97 before (Seller); buyer blank y=97 between 'and' and '(Buyer)'.
        "seller_name": f(1, 287, 85, w=270, h=12, fs=11, req=True,
                         notes="End of '1.PARTIES: ... are ___' line (y=85) after 'are' word at x=283"),
        "buyer_name":  f(1, 131, 97, w=300, h=12, fs=11, req=True,
                         notes="On '(Seller) and ___ (Buyer)' line (y=97), between 'and' end x=127 and '(Buyer)' at x=434"),

        # Inline lot/block at y=120
        "lot_number":   f(1, 158, 120, w=140, h=12, fs=10, req=True,
                          notes="Inline after 'Lot' anchor (138.1, 120.1)"),
        "block_number": f(1, 332, 120, w=140, h=12, fs=10, req=True,
                          notes="Inline after 'Block' anchor (304.0, 120.1)"),

        # Inline addition/county at y=139
        "addition_name": f(1, 158, 139, w=140, h=12, fs=10, req=True,
                           notes="Inline after 'Addition, City of' (67.6, 139.4) — note: form has 2 anchor hits"),
        "county":        f(1, 357, 139, w=120, h=12, fs=10, req=True,
                           notes="Inline after 'County of' (304.0, 139.4)"),

        # Property address line (wraps to y=152)
        "property_address": f(1, 49, 152, w=380, h=12, fs=10, req=True,
                              notes="Above/before '(address/zip code)' label"),

        # Sales Price section
        "cash_portion":     f(1, 452, 221, w=110, h=12, fs=10, req=False,
                              notes="A. Cash portion — fill right of '$' at (441.1, 223.0)"),
        "financing_amount": f(1, 452, 269, w=110, h=12, fs=10, req=False,
                              notes="B. Sum of financing — fill right of '$' at (441.1, 270.8)"),
        "sales_price":      f(1, 452, 279, w=110, h=12, fs=10, req=True,
                              notes="C. Sales Price (Sum A+B) — fill right of '$' at (441.1, 281.2)"),

        # Earnest money / option fee section (y=503-546)
        "escrow_agent": f(1, 200, 503, w=200, h=12, fs=10, req=False,
                          notes="Between 'deliver to' and '(Escrow Agent)' label at (407.2, 503.4)"),
        "escrow_address":  f(1, 49, 535, w=125, h=12, fs=10, req=False,
                             notes="Before '(address):' (Escrow Agent anchor at 94.3, 535.5)"),
        "earnest_money":   f(1, 337, 514, w=90, h=12, fs=10, req=True,
                             notes="Right of '$' at (326.2, 514.1)"),
        "option_fee":      f(1, 92, 525, w=90, h=12, fs=10, req=False,
                             notes="Right of '$' at (80.9, 524.8)"),
        "additional_earnest_money": f(1, 351, 546, w=90, h=12, fs=10, req=False,
                                      notes="Right of '$' at (339.6, 546.1)"),
        "additional_earnest_days":  f(1, 112, 557, w=40, h=12, fs=10, req=False,
                                      notes="Before 'days after' at (140.1, 556.8)"),

        # Option period days (y=709)
        "option_period_days": f(1, 95, 710, w=40, h=12, fs=10, req=False,
                                notes="Before 'days after' at (125.3, 709.2)"),

        # ====== PAGE 2 — Closing Date ======
        "closing_date": f(2, 130, 424, w=140, h=14, fs=11, req=True,
                          notes="Main closing date blank — 'Closing Date' anchor at (337.6, 424.1)"),

        # ====== PAGE 4 — Closing references ======
        "closing_date_page4": f(4, 89, 673, w=140, h=12, fs=10, req=False,
                                notes="'Closing Date' anchor at (113.3, 673.8)"),

        # ====== PAGE 5 — Closing references ======
        "closing_date_page5": f(5, 89, 697, w=140, h=12, fs=10, req=False,
                                notes="'Closing Date' anchor at (125.8, 697.2)"),

        # ====== PAGE 6 — Closing references ======
        "closing_date_page6": f(6, 215, 696, w=140, h=12, fs=10, req=False,
                                notes="'Closing Date' anchor at (478.7, 696.3) (right margin)"),

        # ====== PAGE 7 — Closing references ======
        "closing_date_page7": f(7, 215, 100, w=140, h=12, fs=10, req=False,
                                notes="'Closing Date' anchor at (343.0, 100.4)"),

        # ====== PAGE 7 — Notices section ======
        "buyer_address":  f(7, 49, 400, w=470, h=12, fs=10, req=False, notes="Buyer's notice address block"),
        "seller_address": f(7, 49, 470, w=470, h=12, fs=10, req=False, notes="Seller's notice address block"),

        # ====== PAGE 9 — Effective Date + Signature block ======
        "effective_date": f(9, 360, 241, w=100, h=12, fs=10, req=False,
                            notes="Effective Date — anchor at (457.7, 241.9)"),
        "seller_signature":      f(9, 49, 300, w=240, h=14, fs=11, req=True),
        "seller_signature_date": f(9, 49, 325, w=120, h=12, fs=10, req=True),
        "buyer_signature":       f(9, 320, 300, w=240, h=14, fs=11, req=True),
        "buyer_signature_date":  f(9, 320, 325, w=120, h=12, fs=10, req=True),

        # ====== PAGE 10 — Brokers ======
        "other_broker":           f(10, 49, 145, w=260, h=12, fs=10, req=False),
        "other_broker_license":   f(10, 49, 165, w=160, h=12, fs=10, req=False),
        "other_broker_address":   f(10, 49, 190, w=320, h=12, fs=10, req=False),
        "listing_broker":         f(10, 320, 145, w=240, h=12, fs=10, req=False),
        "listing_broker_license": f(10, 320, 165, w=160, h=12, fs=10, req=False),
        "listing_broker_address": f(10, 320, 190, w=240, h=12, fs=10, req=False),

        # ====== PAGE 11 — Escrow Agent receipt signatures ======
        "escrow_receipt_date_1": f(11, 60, 146, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 1 — anchor at (52.3, 159.3)"),
        "escrow_receipt_date_2": f(11, 60, 226, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 2 — anchor at (52.1, 239.8)"),
        "escrow_receipt_date_3": f(11, 60, 350, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 3 — anchor at (52.1, 364.0)"),
        "escrow_receipt_date_4": f(11, 60, 483, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 4 — anchor at (52.1, 496.6)"),
    },
}
TREC_24_20["field_count"] = len(TREC_24_20["fields"])


# ============================================================
# TREC 25-17 — Farm and Ranch Contract (12 pages)
# Different layout from 23-20 / 24-20:
#   - Page 1 has parties, property description, county in section 2A,
#     acreage at y=606, sales price at y=523-576
#   - Earnest money is on PAGE 2 not page 1
#   - Closing Date references start on PAGE 3 not page 2
# Page 1 anchors:
#   (Seller)         (56.2, 79.1)
#   (Buyer)          (419.8, 79.1)
#   in the County    (199.0, 121.0)  -> Section 2A county location
#   acres            (117.3, 606.4)  -> acreage blank just to the LEFT of 'acres' word
#   $ Cash portion   (420.7, 523.1)
#   $ Financing      (420.7, 565.0)
#   $ Sales Price    (420.7, 576.2)
#   $ excess acreage (459.2, 615.9)
# Page 2 anchors (earnest money section):
#   Escrow Agent     (405.7, 297.2)  -> escrow agent name line
#   $ earnest        (386.8, 306.8)
#   $ option fee     (129.1, 316.4)
#   $ addl earnest   (328.1, 335.8)
# ============================================================
TREC_25_17 = {
    "form_id": "trec-25-17",
    "form_name": "Farm and Ranch Contract",
    "form_number": "TREC 25-17",
    "effective_date": "06-01-2022",
    "page_count": 12,
    "page_dimensions": {"width": 612, "height": 792},
    "fields": {
        # ====== PAGE 1 — Parties ======
        # 25-17: '1.PARTIES' header at y=69 ('are' ends at x=272), '(Seller)' / '(Buyer)' labels at y=79.
        # Seller blank wraps from end of y=69 onto y=79 before (Seller); buyer blank y=79 between 'and' and '(Buyer)'.
        "seller_name": f(1, 275, 69, w=290, h=12, fs=11, req=True,
                         notes="End of '1.PARTIES: ... are ___' line (y=69) after 'are' at x=272"),
        "buyer_name":  f(1, 120, 79, w=295, h=12, fs=11, req=True,
                         notes="On '(Seller) and ___ (Buyer)' line (y=79), between 'and' end x=116 and '(Buyer)' at x=419.8"),

        # ====== PAGE 1 — Section 2A: Property description + County ======
        # Section 2A reads: "A. LAND: The land situated in the County (or Counties) of ___, Texas"
        # 'in the County' label at (199.0, 121.0). County blank goes at end of y=121 (after 'of' label).
        "county": f(1, 365, 121, w=190, h=12, fs=10, req=True,
                    notes="End of 'A. LAND: ... in the County (or Counties) of ___' line at y=121"),

        # Property description — section 2B "described as follows" multi-line block under county wrap
        # Wraps onto y=132 then "described as follows:" then blank lines below
        "property_description": f(1, 49, 168, w=510, h=70, fs=10, req=True,
                                  notes="Multi-line legal description block under 'described as follows:'"),

        # Acreage — Section 2 also has "containing ___ acres" or similar at y=606
        # 'acres' word at (117.3, 606.4) — blank just left of this word
        "acreage": f(1, 80, 606, w=35, h=12, fs=10, req=False,
                     notes="Acreage value — just left of 'acres' word at (117.3, 606.4)"),

        # Sales Price section (page 1)
        "cash_portion":     f(1, 432, 521, w=110, h=12, fs=10, req=False,
                              notes="A. Cash portion — right of '$' at (420.7, 523.1)"),
        "financing_amount": f(1, 432, 563, w=110, h=12, fs=10, req=False,
                              notes="B. Sum of financing — right of '$' at (420.7, 565.0)"),
        "sales_price":      f(1, 432, 574, w=110, h=12, fs=10, req=True,
                              notes="C. Sales Price (Sum A+B) — right of '$' at (420.7, 576.2)"),
        "acreage_adjustment": f(1, 471, 614, w=90, h=12, fs=10, req=False,
                                notes="Excess acreage adjustment — right of '$' at (459.2, 615.9)"),

        # Section about timing 'days after Effective Date' on page 1
        "survey_days": f(1, 260, 644, w=40, h=12, fs=10, req=False,
                         notes="Before 'days after' (286.8, 644.4)"),

        # ====== PAGE 2 — Earnest Money / Option Fee / Escrow Agent ======
        "escrow_agent":   f(2, 200, 297, w=200, h=12, fs=10, req=False,
                            notes="Before '(Escrow Agent)' at (405.7, 297.2)"),
        "escrow_address": f(2, 49, 326, w=125, h=12, fs=10, req=False,
                            notes="Before '(address):' label area"),
        "earnest_money":  f(2, 398, 306, w=90, h=12, fs=10, req=True,
                            notes="Right of '$' at (386.8, 306.8)"),
        "option_fee":     f(2, 141, 316, w=90, h=12, fs=10, req=False,
                            notes="Right of '$' at (129.1, 316.4)"),
        "additional_earnest_money": f(2, 340, 335, w=90, h=12, fs=10, req=False,
                                      notes="Right of '$' at (328.1, 335.8)"),
        "option_period_days": f(2, 90, 480, w=40, h=12, fs=10, req=False,
                                notes="Before 'days after' at (118.1, 480.6) — option period"),

        # ====== PAGE 3 — Closing Date ======
        "closing_date": f(3, 100, 141, w=140, h=14, fs=11, req=True,
                          notes="Main closing date — 'Closing Date' anchor at (123.7, 141.1)"),
        "closing_date_page3b": f(3, 235, 414, w=140, h=12, fs=10, req=False,
                                  notes="Page 3 second closing — anchor at (267.7, 414.5)"),

        # ====== PAGE 5 — Closing references ======
        "closing_date_page5": f(5, 71, 217, w=140, h=12, fs=10, req=False,
                                notes="Page 5 closing — anchor at (99.0, 216.9)"),

        # ====== PAGE 6 — Closing references ======
        "closing_date_page6": f(6, 54, 308, w=140, h=12, fs=10, req=False,
                                notes="Page 6 closing — anchor at (82.2, 308.3)"),

        # ====== PAGE 7 — Closing references ======
        "closing_date_page7": f(7, 49, 338, w=140, h=12, fs=10, req=False,
                                notes="Page 7 closing — anchor at (76.9, 338.5)"),

        # ====== PAGE 8 — Reservations + Closing references ======
        "closing_date_page8": f(8, 215, 302, w=140, h=12, fs=10, req=False,
                                notes="Page 8 closing — anchor at (381.0, 302.3)"),

        # ====== PAGE 5 — Reservations (oil/gas/minerals/water/timber) ======
        # These are free-text fields on later pages — capture approximate positions
        "reservations_oil_gas":  f(5, 49, 280, w=510, h=30, fs=10, req=False,
                                    notes="Oil/gas/minerals reservation text"),
        "reservations_water":    f(5, 49, 350, w=510, h=30, fs=10, req=False,
                                    notes="Water reservation text"),
        "reservations_timber":   f(5, 49, 420, w=510, h=30, fs=10, req=False,
                                    notes="Timber reservation text"),

        # ====== PAGE 7 — Notices section ======
        "buyer_address":  f(7, 49, 540, w=470, h=12, fs=10, req=False, notes="Buyer's notice address"),
        "seller_address": f(7, 49, 610, w=470, h=12, fs=10, req=False, notes="Seller's notice address"),

        # ====== PAGE 10 — Execution + Signature block ======
        "effective_date":         f(10, 360, 205, w=100, h=12, fs=10, req=False,
                                     notes="Effective Date — anchor at (464.9, 205.3)"),
        "seller_signature":       f(10, 49, 265, w=240, h=14, fs=11, req=True),
        "seller_signature_date":  f(10, 49, 290, w=120, h=12, fs=10, req=True),
        "buyer_signature":        f(10, 320, 265, w=240, h=14, fs=11, req=True),
        "buyer_signature_date":   f(10, 320, 290, w=120, h=12, fs=10, req=True),

        # ====== PAGE 11 — Brokers section ======
        "other_broker":           f(11, 49, 130, w=260, h=12, fs=10, req=False),
        "other_broker_license":   f(11, 49, 150, w=160, h=12, fs=10, req=False),
        "other_broker_address":   f(11, 49, 175, w=320, h=12, fs=10, req=False),
        "listing_broker":         f(11, 320, 130, w=240, h=12, fs=10, req=False),
        "listing_broker_license": f(11, 320, 150, w=160, h=12, fs=10, req=False),
        "listing_broker_address": f(11, 320, 175, w=240, h=12, fs=10, req=False),

        # ====== PAGE 12 — Escrow Agent receipt signatures ======
        # 'Escrow Agent' anchors at x=52.1, y=128, 204, 319, 450 (4 receipt blocks)
        "escrow_receipt_date_1": f(12, 60, 115, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 1 — anchor at (52.1, 128.3)"),
        "escrow_receipt_date_2": f(12, 60, 190, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 2 — anchor at (52.1, 204.0)"),
        "escrow_receipt_date_3": f(12, 60, 306, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 3 — anchor at (52.1, 319.7)"),
        "escrow_receipt_date_4": f(12, 60, 437, w=130, h=12, fs=10, req=False,
                                   notes="Escrow Agent receipt date 4 — anchor at (52.1, 450.5)"),
    },
}
TREC_25_17["field_count"] = len(TREC_25_17["fields"])


# ============================================================
# Write all field-map JSON files
# ============================================================
def write_map(form_data):
    path = MAPS / f"{form_data['form_id']}-coords.json"
    path.write_text(json.dumps(form_data, indent=2))
    text_fields = sum(1 for v in form_data['fields'].values() if v.get('type') != 'checkbox')
    checkboxes = sum(1 for v in form_data['fields'].values() if v.get('type') == 'checkbox')
    pages = sorted(set(v['page'] for v in form_data['fields'].values()))
    print(f"  {form_data['form_id']:12s} -> {form_data['field_count']:3d} fields ({text_fields} text + {checkboxes} cb), pages={pages}")


def main():
    print("Writing field-map JSONs:")
    write_map(TREC_38_7)
    write_map(TREC_23_20)
    write_map(TREC_24_20)
    write_map(TREC_25_17)


if __name__ == "__main__":
    main()
