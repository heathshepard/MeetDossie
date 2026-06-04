import json, sys

BUYER_UUID = '00f4ba7d-7814-4426-8612-9ef9dab0c810'
SELLER_UUID = '6b4f8316-80bd-46f5-ac26-268a2d28ebb1'
ATTACH_UUID = '40cf3142-c321-469a-a28d-a7b42306bf78'

def field(name, ftype, page, x, y, w, h, submitter=BUYER_UUID, readonly=True, required=True):
    f = {
        'name': name,
        'type': ftype,
        'required': required,
        'submitter_uuid': submitter,
        'areas': [{
            'page': page,
            'attachment_uuid': ATTACH_UUID,
            'x': round(x, 4),
            'y': round(y, 4),
            'w': round(w, 4),
            'h': round(h, 4)
        }]
    }
    # readonly is NOT set on template -- it's applied at submission time via fields[]
    # Setting readonly on template causes 500 when passing values at submission time
    return f

fields = []

# ========== PAGE 0 (HEADER + PARTIES + PROPERTY + SALES PRICE + LEASES) ==========

# Header - Contract Concerning (property address) - appears on every page
fields.append(field('property_address_header_p1', 'text', 0, 0.21, 0.0380, 0.52, 0.016))

# Section 1 - PARTIES
# Form reads: 'The parties to this contract are _____(Seller) and _____(Buyer).'
# Seller blank: after 'contract are' to '(Seller)'
fields.append(field('seller_name', 'text', 0, 0.455, 0.1140, 0.35, 0.016, SELLER_UUID))
# Buyer blank: after 'and' to '(Buyer)'
fields.append(field('buyer_name', 'text', 0, 0.215, 0.1275, 0.58, 0.016))

# Section 2 - PROPERTY
# 2A - Lot
fields.append(field('legal_lot', 'text', 0, 0.175, 0.2065, 0.13, 0.016))
# Block
fields.append(field('legal_block', 'text', 0, 0.385, 0.2065, 0.10, 0.016))
# Addition, City of
fields.append(field('addition_city', 'text', 0, 0.270, 0.2200, 0.21, 0.016))
# County
fields.append(field('county', 'text', 0, 0.660, 0.2200, 0.24, 0.016))
# Property address (known as)
fields.append(field('property_address', 'text', 0, 0.270, 0.2335, 0.65, 0.016))

# 2D - Exclusions
fields.append(field('exclusions', 'text', 0, 0.535, 0.5035, 0.37, 0.016, required=False))

# Section 3 - SALES PRICE
# 3A - Cash portion (down payment)
fields.append(field('down_payment', 'text', 0, 0.76, 0.5830, 0.16, 0.016))
# 3B - Third Party Financing checkbox
fields.append(field('third_party_financing', 'checkbox', 0, 0.509, 0.6260, 0.014, 0.014))
# 3B - Loan amount
fields.append(field('loan_amount', 'text', 0, 0.76, 0.6435, 0.16, 0.016))
# 3C - Sales Price
fields.append(field('sales_price', 'text', 0, 0.76, 0.6600, 0.16, 0.016))

# Section 4 - LEASES checkboxes
# 4A - No residential leases (unchecked means there ARE leases)
fields.append(field('no_residential_leases', 'checkbox', 0, 0.078, 0.7380, 0.014, 0.014, required=False))
# 4B - No fixture leases
fields.append(field('no_fixture_leases', 'checkbox', 0, 0.078, 0.7700, 0.014, 0.014, required=False))
# 4C - No natural resource leases
fields.append(field('no_natural_resource_leases', 'checkbox', 0, 0.078, 0.8150, 0.014, 0.014, required=False))

# Buyer Initials Page 0
fields.append(field('Buyer Initials P1', 'initials', 0, 0.34, 0.957, 0.07, 0.022))
# Seller Initials Page 0
fields.append(field('Seller Initials P1', 'initials', 0, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 1 (EARNEST MONEY + TITLE POLICY) ==========

fields.append(field('property_address_header_p2', 'text', 1, 0.21, 0.0380, 0.52, 0.016))

# 5A - Escrow Agent name
fields.append(field('escrow_agent_name', 'text', 1, 0.295, 0.1000, 0.19, 0.016, required=False))
# Escrow Agent address
fields.append(field('escrow_agent_address', 'text', 1, 0.670, 0.1000, 0.25, 0.016, required=False))
# Earnest money amount (after (address): $)
fields.append(field('earnest_money_amount', 'text', 1, 0.485, 0.1140, 0.10, 0.016))
# Option fee (after 'as earnest money and $')
fields.append(field('option_fee', 'text', 1, 0.810, 0.1140, 0.11, 0.016))

# 5A(1) Additional earnest money
fields.append(field('additional_earnest_money', 'text', 1, 0.570, 0.1545, 0.15, 0.016, required=False))
# Days after effective date for additional EM
fields.append(field('additional_em_days', 'text', 1, 0.117, 0.1680, 0.07, 0.016, required=False))

# 5B - Option period days
fields.append(field('option_period_days', 'text', 1, 0.123, 0.3520, 0.05, 0.016))

# 6A - Title Policy
# Seller's expense checkbox
fields.append(field('title_seller_pays', 'checkbox', 1, 0.440, 0.5410, 0.014, 0.014))
# Buyer's expense checkbox
fields.append(field('title_buyer_pays', 'checkbox', 1, 0.536, 0.5410, 0.014, 0.014, required=False))
# Title Company name
fields.append(field('title_company_name', 'text', 1, 0.475, 0.5545, 0.30, 0.016))

# 6A(8) Survey amendment checkboxes
fields.append(field('survey_not_amended', 'checkbox', 1, 0.123, 0.7603, 0.014, 0.014, required=False))
fields.append(field('survey_amended', 'checkbox', 1, 0.123, 0.7733, 0.014, 0.014, required=False))
fields.append(field('survey_amend_buyer', 'checkbox', 1, 0.790, 0.7733, 0.014, 0.014, required=False))
fields.append(field('survey_amend_seller', 'checkbox', 1, 0.820, 0.7733, 0.014, 0.014, required=False))

# Buyer/Seller Initials Page 1
fields.append(field('Buyer Initials P2', 'initials', 1, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P2', 'initials', 1, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 2 (SURVEY + TITLE NOTICES) ==========

fields.append(field('property_address_header_p3', 'text', 2, 0.21, 0.0380, 0.52, 0.016))

# Survey C.1 checkbox and days
fields.append(field('survey_c1', 'checkbox', 2, 0.097, 0.0913, 0.014, 0.014, required=False))
fields.append(field('survey_c1_days', 'text', 2, 0.195, 0.0925, 0.05, 0.016, required=False))
# Survey C.2 checkbox and days
fields.append(field('survey_c2', 'checkbox', 2, 0.097, 0.1903, 0.014, 0.014, required=False))
fields.append(field('survey_c2_days', 'text', 2, 0.215, 0.1915, 0.05, 0.016, required=False))
# Survey C.3 checkbox and days
fields.append(field('survey_c3', 'checkbox', 2, 0.097, 0.2535, 0.014, 0.014, required=False))
fields.append(field('survey_c3_days', 'text', 2, 0.215, 0.2530, 0.05, 0.016, required=False))

# 6D - Permitted use
fields.append(field('permitted_use', 'text', 2, 0.245, 0.3235, 0.65, 0.016, required=False))
# Title objection days
fields.append(field('title_objection_days', 'text', 2, 0.617, 0.3358, 0.04, 0.016, required=False))

# POA is/is not checkboxes
fields.append(field('poa_is', 'checkbox', 2, 0.678, 0.5870, 0.014, 0.014, required=False))
fields.append(field('poa_is_not', 'checkbox', 2, 0.710, 0.5870, 0.014, 0.014, required=False))

# Buyer/Seller Initials Page 2
fields.append(field('Buyer Initials P3', 'initials', 2, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P3', 'initials', 2, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 3 (TITLE NOTICES cont + PROPERTY CONDITION) ==========

fields.append(field('property_address_header_p4', 'text', 3, 0.21, 0.0380, 0.52, 0.016))

# Required notices text
fields.append(field('required_notices', 'text', 3, 0.145, 0.6300, 0.76, 0.016, required=False))

# 7B - Seller's Disclosure Notice checkboxes
fields.append(field('sdn_received', 'checkbox', 3, 0.100, 0.7965, 0.014, 0.014, required=False))
fields.append(field('sdn_not_received', 'checkbox', 3, 0.100, 0.8095, 0.014, 0.014, required=False))
fields.append(field('sdn_delivery_days', 'text', 3, 0.545, 0.8085, 0.04, 0.016, required=False))
fields.append(field('sdn_not_required', 'checkbox', 3, 0.100, 0.8850, 0.014, 0.014, required=False))

# Buyer/Seller Initials Page 3
fields.append(field('Buyer Initials P4', 'initials', 3, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P4', 'initials', 3, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 4 (PROPERTY CONDITION cont + CLOSING) ==========

fields.append(field('property_address_header_p5', 'text', 4, 0.21, 0.0380, 0.52, 0.016))

# 7D - As Is checkbox
fields.append(field('as_is', 'checkbox', 4, 0.095, 0.1260, 0.014, 0.014))
# 7D(2) - As Is with repairs
fields.append(field('as_is_with_repairs', 'checkbox', 4, 0.095, 0.1398, 0.014, 0.014, required=False))

# 7H - Service contract amount
fields.append(field('service_contract_amount', 'text', 4, 0.614, 0.5330, 0.15, 0.016, required=False))

# 8A - Broker disclosure
fields.append(field('broker_disclosure', 'text', 4, 0.645, 0.6805, 0.26, 0.016, required=False))

# 9A - Closing date
fields.append(field('closing_date', 'text', 4, 0.370, 0.7380, 0.26, 0.016))
fields.append(field('closing_year', 'text', 4, 0.658, 0.7380, 0.04, 0.016))

# Buyer/Seller Initials Page 4
fields.append(field('Buyer Initials P5', 'initials', 4, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P5', 'initials', 4, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 5 (POSSESSION + SPECIAL PROVISIONS + SETTLEMENT) ==========

fields.append(field('property_address_header_p6', 'text', 5, 0.21, 0.0380, 0.52, 0.016))

# 10A - Possession upon closing checkbox
fields.append(field('possession_closing', 'checkbox', 5, 0.549, 0.1535, 0.014, 0.014, required=False))

# 11 - Special provisions
fields.append(field('special_provisions', 'text', 5, 0.098, 0.4525, 0.81, 0.020, required=False))

# 12A(1)(b) - Seller contribution to buyer broker
fields.append(field('seller_buyer_broker_dollar_check', 'checkbox', 5, 0.181, 0.6005, 0.014, 0.014, required=False))
fields.append(field('seller_buyer_broker_amount', 'text', 5, 0.212, 0.6000, 0.13, 0.016, required=False))
fields.append(field('seller_buyer_broker_pct_check', 'checkbox', 5, 0.361, 0.6005, 0.014, 0.014, required=False))
fields.append(field('seller_buyer_broker_pct', 'text', 5, 0.383, 0.6000, 0.05, 0.016, required=False))

# 12A(1)(c) - Seller closing cost credit
fields.append(field('seller_closing_cost_credit', 'text', 5, 0.425, 0.6135, 0.10, 0.016, required=False))

# Buyer/Seller Initials Page 5
fields.append(field('Buyer Initials P6', 'initials', 5, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P6', 'initials', 5, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 6 (MEDIATION/DEFAULT/ESCROW - no fillable fields) ==========

fields.append(field('property_address_header_p7', 'text', 6, 0.21, 0.0380, 0.52, 0.016))
fields.append(field('Buyer Initials P7', 'initials', 6, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P7', 'initials', 6, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 7 (NOTICES + ADDENDA + ATTORNEY) ==========

fields.append(field('property_address_header_p8', 'text', 7, 0.21, 0.0380, 0.52, 0.016))

# 21 - Notices
fields.append(field('buyer_notice_address', 'text', 7, 0.235, 0.0980, 0.22, 0.016, required=False))
fields.append(field('buyer_phone', 'text', 7, 0.280, 0.1645, 0.15, 0.016, required=False))
fields.append(field('buyer_email', 'text', 7, 0.230, 0.1935, 0.21, 0.016, required=False))
fields.append(field('seller_notice_address', 'text', 7, 0.650, 0.0980, 0.22, 0.016, SELLER_UUID, required=False))
fields.append(field('seller_phone', 'text', 7, 0.700, 0.1645, 0.15, 0.016, SELLER_UUID, required=False))
fields.append(field('seller_email', 'text', 7, 0.650, 0.1935, 0.21, 0.016, SELLER_UUID, required=False))

# 22 - Addendum checkboxes (left column)
fields.append(field('addendum_financing', 'checkbox', 7, 0.107, 0.3320, 0.014, 0.014, required=False))
fields.append(field('addendum_seller_financing', 'checkbox', 7, 0.107, 0.3508, 0.014, 0.014, required=False))
fields.append(field('addendum_poa', 'checkbox', 7, 0.107, 0.3698, 0.014, 0.014, required=False))
fields.append(field('addendum_buyer_lease', 'checkbox', 7, 0.107, 0.4115, 0.014, 0.014, required=False))
fields.append(field('addendum_loan_assumption', 'checkbox', 7, 0.107, 0.4305, 0.014, 0.014, required=False))
fields.append(field('addendum_sale_other_property', 'checkbox', 7, 0.107, 0.4495, 0.014, 0.014, required=False))
fields.append(field('addendum_oil_gas_minerals', 'checkbox', 7, 0.107, 0.4808, 0.014, 0.014, required=False))
fields.append(field('addendum_backup_contract', 'checkbox', 7, 0.107, 0.5103, 0.014, 0.014, required=False))
fields.append(field('addendum_coastal', 'checkbox', 7, 0.107, 0.5295, 0.014, 0.014, required=False))
fields.append(field('addendum_hydrostatic', 'checkbox', 7, 0.107, 0.5538, 0.014, 0.014, required=False))
fields.append(field('addendum_appraisal_terminate', 'checkbox', 7, 0.107, 0.5855, 0.014, 0.014, required=False))
fields.append(field('addendum_environmental', 'checkbox', 7, 0.107, 0.6126, 0.014, 0.014, required=False))

# 22 - Addendum checkboxes (right column)
fields.append(field('addendum_seller_lease', 'checkbox', 7, 0.517, 0.3338, 0.014, 0.014, required=False))
fields.append(field('addendum_short_sale', 'checkbox', 7, 0.517, 0.3565, 0.014, 0.014, required=False))
fields.append(field('addendum_seaward', 'checkbox', 7, 0.517, 0.3793, 0.014, 0.014, required=False))
fields.append(field('addendum_lead_paint', 'checkbox', 7, 0.517, 0.4133, 0.014, 0.014, required=False))
fields.append(field('addendum_propane', 'checkbox', 7, 0.517, 0.4703, 0.014, 0.014, required=False))
fields.append(field('addendum_residential_leases', 'checkbox', 7, 0.517, 0.4993, 0.014, 0.014, required=False))
fields.append(field('addendum_fixture_leases', 'checkbox', 7, 0.517, 0.5155, 0.014, 0.014, required=False))
fields.append(field('addendum_pid', 'checkbox', 7, 0.517, 0.5460, 0.014, 0.014, required=False))
fields.append(field('addendum_1031_exchange', 'checkbox', 7, 0.517, 0.5800, 0.014, 0.014, required=False))
fields.append(field('addendum_other', 'checkbox', 7, 0.517, 0.5948, 0.014, 0.014, required=False))
fields.append(field('addendum_other_text', 'text', 7, 0.637, 0.6050, 0.28, 0.016, required=False))

# 23 - Attorney
fields.append(field('buyer_attorney', 'text', 7, 0.225, 0.7280, 0.22, 0.016, required=False))
fields.append(field('seller_attorney', 'text', 7, 0.645, 0.7280, 0.22, 0.016, SELLER_UUID, required=False))

# Buyer/Seller Initials Page 7
fields.append(field('Buyer Initials P8', 'initials', 7, 0.34, 0.957, 0.07, 0.022))
fields.append(field('Seller Initials P8', 'initials', 7, 0.57, 0.957, 0.07, 0.022, SELLER_UUID))


# ========== PAGE 8 (EXECUTION + SIGNATURES) ==========

fields.append(field('property_address_header_p9', 'text', 8, 0.21, 0.0380, 0.52, 0.016))

# EXECUTED date fields
fields.append(field('execution_day', 'text', 8, 0.240, 0.2815, 0.05, 0.016, required=False))
fields.append(field('execution_month', 'text', 8, 0.340, 0.2815, 0.18, 0.016, required=False))
fields.append(field('execution_year', 'text', 8, 0.568, 0.2815, 0.04, 0.016, required=False))

# Signatures
fields.append(field('Buyer Signature', 'signature', 8, 0.117, 0.475, 0.35, 0.035, BUYER_UUID, readonly=False))
fields.append(field('Seller Signature', 'signature', 8, 0.513, 0.475, 0.35, 0.035, SELLER_UUID, readonly=False))
fields.append(field('Buyer Signature 2', 'signature', 8, 0.117, 0.620, 0.35, 0.035, BUYER_UUID, readonly=False, required=False))
fields.append(field('Seller Signature 2', 'signature', 8, 0.513, 0.620, 0.35, 0.035, SELLER_UUID, readonly=False, required=False))


# ========== PAGE 9 (BROKER INFORMATION) ==========

fields.append(field('property_address_header_p10', 'text', 9, 0.21, 0.0380, 0.52, 0.016))

# Other Broker (Buyer's side) - left column
fields.append(field('other_broker_firm', 'text', 9, 0.082, 0.1980, 0.23, 0.016, required=False))
fields.append(field('other_broker_license', 'text', 9, 0.355, 0.1980, 0.10, 0.016, required=False))
fields.append(field('other_broker_buyer_agent', 'checkbox', 9, 0.178, 0.2280, 0.014, 0.014, required=False))
fields.append(field('other_agent_name', 'text', 9, 0.082, 0.2870, 0.23, 0.016, required=False))
fields.append(field('other_agent_license', 'text', 9, 0.355, 0.2870, 0.10, 0.016, required=False))
fields.append(field('other_team_name', 'text', 9, 0.172, 0.3265, 0.28, 0.016, required=False))
fields.append(field('other_agent_email', 'text', 9, 0.082, 0.3640, 0.27, 0.016, required=False))
fields.append(field('other_agent_phone', 'text', 9, 0.385, 0.3640, 0.08, 0.016, required=False))

# Listing Broker (Seller's side) - right column
fields.append(field('listing_broker_firm', 'text', 9, 0.499, 0.1980, 0.30, 0.016, required=False))
fields.append(field('listing_broker_license', 'text', 9, 0.845, 0.1980, 0.10, 0.016, required=False))
fields.append(field('listing_broker_seller_agent', 'checkbox', 9, 0.499, 0.2465, 0.014, 0.014, required=False))
fields.append(field('listing_agent_name', 'text', 9, 0.499, 0.2870, 0.30, 0.016, required=False))
fields.append(field('listing_agent_license', 'text', 9, 0.845, 0.2870, 0.10, 0.016, required=False))
fields.append(field('listing_team_name', 'text', 9, 0.590, 0.3265, 0.28, 0.016, required=False))
fields.append(field('listing_agent_email', 'text', 9, 0.499, 0.3640, 0.30, 0.016, required=False))
fields.append(field('listing_agent_phone', 'text', 9, 0.845, 0.3640, 0.08, 0.016, required=False))


# ========== PAGE 10 (RECEIPT - title company fills, no Dossie fields) ==========

fields.append(field('property_address_header_p11', 'text', 10, 0.21, 0.0380, 0.52, 0.016))


print(f'Total fields: {len(fields)}', file=sys.stderr)

with open('docuseal-fields.json', 'w') as f:
    json.dump(fields, f, indent=2)

print('Fields written to docuseal-fields.json', file=sys.stderr)
