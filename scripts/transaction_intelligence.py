from normalize_transaction import normalize_transaction

FIELD_LABELS = {
    "buyer_name": "buyer name",
    "seller_name": "seller name",
    "property_address": "property address",
    "city_state_zip": "city / state / ZIP",
    "county": "county",
    "legal_description": "legal description",
    "sale_price": "sale price",
    "earnest_money": "earnest money",
    "option_fee": "option fee",
    "contract_effective_date": "effective date",
    "closing_date": "closing date",
    "title_company": "title company",
    "title_company_email": "title company email",
    "title_company_phone": "title company phone",
    "escrow_agent": "escrow officer",
    "lender_name": "lender name",
    "loan_amount": "loan amount",
    "financing_type": "financing type",
}

SCHEMA_GROUPS = {
    "core_contract": [
        "buyer_name", "seller_name", "property_address", "city_state_zip", "county",
        "legal_description", "sale_price", "earnest_money", "option_fee",
        "contract_effective_date", "closing_date", "title_company"
    ],
    "title_and_contacts": ["title_company_email", "title_company_phone", "escrow_agent"],
    "financing": ["lender_name", "loan_amount", "financing_type"],
}


def classify_transaction(raw: dict):
    normalized = normalize_transaction(raw)
    classification = {}
    for key in FIELD_LABELS:
        raw_value = raw.get(key)
        normalized_value = normalized.get(key)
        if raw_value not in (None, ""):
            status = "known"
            value = raw_value
        elif normalized_value not in (None, ""):
            status = "inferred"
            value = normalized_value
        else:
            status = "missing"
            value = ""
        classification[key] = {
            "label": FIELD_LABELS[key],
            "status": status,
            "value": value,
        }

    if normalized.get("financing_addendum") and classification["loan_amount"]["status"] == "missing":
        classification["loan_amount"]["status"] = "needs-confirmation"
    if normalized.get("financing_addendum") and classification["financing_type"]["status"] == "missing":
        classification["financing_type"]["status"] = "needs-confirmation"

    return normalized, classification


def completeness_summary(classification: dict):
    groups = {}
    for group_name, fields in SCHEMA_GROUPS.items():
        statuses = [classification[field]["status"] for field in fields]
        groups[group_name] = {
            "known": len([x for x in statuses if x == "known"]),
            "inferred": len([x for x in statuses if x == "inferred"]),
            "missing": len([x for x in statuses if x == "missing"]),
            "needs_confirmation": len([x for x in statuses if x == "needs-confirmation"]),
            "total": len(fields),
        }
    return groups


def recommend_documents(normalized: dict, raw: dict):
    docs = ["resale contract"]
    if normalized.get("financing_addendum"):
        docs.append("third party financing addendum")
    notes = (raw.get("notes") or "").lower()
    if "amend" in notes or raw.get("stage") == "option-period":
        docs.append("amendment")
    if "terminate" in notes or raw.get("status") == "terminated":
        docs.append("termination notice")
    return docs


def determine_next_question(raw: dict):
    normalized, classification = classify_transaction(raw)
    priority = [
        "buyer_name", "seller_name", "property_address", "county", "legal_description",
        "sale_price", "contract_effective_date", "closing_date", "title_company",
        "earnest_money", "option_fee", "loan_amount", "financing_type",
    ]
    for key in priority:
        if classification[key]["status"] in ("missing", "needs-confirmation"):
            question_map = {
                "buyer_name": "Who is the buyer exactly as they should appear on the contract?",
                "seller_name": "Who is the seller exactly as they should appear on the contract?",
                "property_address": "What is the full property address for this file?",
                "county": "Which county is the property in?",
                "legal_description": "What is the legal description for the property?",
                "sale_price": "What is the sale price for this contract?",
                "contract_effective_date": "What is the effective date for this contract?",
                "closing_date": "What closing date should Dossie use?",
                "title_company": "Which title company is handling this file?",
                "earnest_money": "How much earnest money is being deposited?",
                "option_fee": "What option fee should Dossie use?",
                "loan_amount": "What loan amount should Dossie use for the financing addendum?",
                "financing_type": "Is the financing conventional, FHA, VA, cash, or something else?",
            }
            return question_map[key]
    return "This file looks complete enough for Dossie to move into document prep and follow-up guidance."


def determine_what_matters_now(raw: dict):
    normalized, classification = classify_transaction(raw)
    critical_missing = [field["label"] for field in classification.values() if field["status"] in ("missing", "needs-confirmation")][:4]
    if critical_missing:
        return f"The file still has contract-critical gaps: {', '.join(critical_missing)}. Dossie should close those before trusting the document set."
    if raw.get("stage") == "financing":
        return "Financing is what matters most now. Dossie should keep lender progress and closing viability visible."
    if raw.get("stage") == "option-period":
        return "Option-period decisions matter most now. Dossie should keep amendment readiness and decision timing visible."
    return "The file is structurally complete enough that Dossie can focus on document generation and next-party coordination."


def determine_next_action(raw: dict):
    normalized, classification = classify_transaction(raw)
    if any(field["status"] in ("missing", "needs-confirmation") for field in classification.values()):
        return "Ask the next missing contract question and update the dossier before generating or relying on more documents."
    docs = recommend_documents(normalized, raw)
    return f"Generate or refresh: {', '.join(docs)}. Then prepare the next file-moving follow-up."


def conversation_update(raw: dict, message: str):
    message = message.strip()
    lower = message.lower()
    updates = {}

    if "buyer is" in lower:
        updates["buyer_name"] = message.split("buyer is", 1)[1].strip(" .")
    if "seller is" in lower:
        updates["seller_name"] = message.split("seller is", 1)[1].strip(" .")
    if "sale price" in lower:
        digits = ''.join(ch for ch in message if ch.isdigit())
        if digits:
            updates["sale_price"] = int(digits)
    if "earnest money" in lower:
        digits = ''.join(ch for ch in message if ch.isdigit())
        if digits:
            updates["earnest_money"] = int(digits)
    if "option fee" in lower:
        digits = ''.join(ch for ch in message if ch.isdigit())
        if digits:
            updates["option_fee"] = int(digits)
    if "title company" in lower:
        updates["title_company"] = message.split("title company", 1)[1].replace("is", "").strip(" .:")
    if "lender" in lower:
        updates["lender_name"] = message.split("lender", 1)[1].replace("is", "").strip(" .:")
    if "conventional" in lower:
        updates["financing_type"] = "conventional"
    elif "fha" in lower:
        updates["financing_type"] = "fha"
    elif "va" in lower:
        updates["financing_type"] = "va"
    elif "cash" in lower:
        updates["financing_type"] = "cash"

    merged = {**raw, **updates}
    question = determine_next_question(merged)
    return updates, question
