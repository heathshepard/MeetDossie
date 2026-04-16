FIELD_MAP = {
    # Phase-one starter mapping for the resale contract.
    # Keys are actual discovered PDF field names.
    # Values are normalized dossier keys.

    # Parties / property
    "1 PARTIES The parties to this contract are": "buyer_name",
    "Seller and": "seller_name",
    "Address of Property": "property_address",
    "Address of Property_2": "property_address",
    "County of": "county",
    "Addition City of": "city_state_zip",
    "A LAND Lot": "legal_description",

    # Timing / money
    "A The closing of the sale will be on or before": "closing_date",
    "earnest money of": "earnest_money",
    "Option Fee in the form of": "option_fee",
    "Date": "contract_effective_date",
    "Date_2": "closing_date",
    "will not be credited to the Sales Price at closing Time is of the": "sale_price",

    # Title / closing
    "Escrow Agent": "title_company",
    "insurance Title Policy issued by": "title_company",
}

BUTTON_MAP = {
    # Addenda / checkbox controls
    # Turn on the financing addendum when lender data exists.
    "B Sum of all financing described in the attached": "financing_addendum",
}
