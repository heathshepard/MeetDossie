from document_utils import normalize_date, stringify_money


def normalize_transaction(data: dict) -> dict:
    role = data.get("role") or "listing"
    client_name = data.get("buyer_name") if role == "buyer" else data.get("seller_name")
    city_state_zip = data.get("city_state_zip") or ""
    property_address = data.get("property_address") or ""
    normalized = {
        "buyer_name": data.get("buyer_name") or (client_name if role == "buyer" else ""),
        "seller_name": data.get("seller_name") or (client_name if role == "listing" else ""),
        "property_address": property_address,
        "city_state_zip": city_state_zip,
        "property_full": ", ".join([part for part in [property_address, city_state_zip] if part]),
        "county": data.get("county") or "",
        "legal_description": data.get("legal_description") or "",
        "sale_price": stringify_money(data.get("sale_price")),
        "earnest_money": stringify_money(data.get("earnest_money")),
        "option_fee": stringify_money(data.get("option_fee")),
        "contract_effective_date": normalize_date(data.get("contract_effective_date")),
        "closing_date": normalize_date(data.get("closing_date")),
        "title_company": data.get("title_company") or "",
        "title_company_email": data.get("title_company_email") or "",
        "title_company_phone": data.get("title_company_phone") or "",
        "escrow_agent": data.get("escrow_agent") or "",
        "lender_name": data.get("lender_name") or "",
        "loan_amount": stringify_money(data.get("loan_amount")),
        "financing_type": data.get("financing_type") or "",
        "financing_addendum": bool(data.get("lender_name") or data.get("loan_amount") or data.get("financing_type")),
        "financing_conventional": (data.get("financing_type") or "") == "conventional",
        "financing_fha": (data.get("financing_type") or "") == "fha",
        "financing_va": (data.get("financing_type") or "") == "va",
    }
    return normalized
