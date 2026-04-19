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
    "status": "file status",
    "notes": "file notes",
}

CONTRACT_CRITICAL_FIELDS = {
    "buyer_name", "seller_name", "property_address", "city_state_zip", "county",
    "legal_description", "sale_price", "earnest_money", "option_fee",
    "contract_effective_date", "closing_date", "title_company", "loan_amount", "financing_type"
}

QUESTION_MAP = {
    "buyer_name": "Who is the buyer exactly as they should appear on the contract?",
    "seller_name": "Who is the seller exactly as they should appear on the contract?",
    "property_address": "What is the full property address for this file?",
    "city_state_zip": "What city, state, and ZIP should I use for this property?",
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

STAGE_PERSONAS = {
    "under-contract": {
        "summary": "This file is in setup mode. My job is to close the trust gaps early so the rest of the transaction can move cleanly.",
        "action": "Keep the contract baseline clean, then move into title, lender, and next-party coordination.",
    },
    "option-period": {
        "summary": "This file is inside the option window, so timing and decision clarity matter more than volume.",
        "action": "Keep the decision path simple, protect amendment readiness, and avoid letting the file drift.",
    },
    "financing": {
        "summary": "This file is in financing now, so I am watching lender momentum and closing viability first.",
        "action": "Keep lender progress visible, protect the closing path, and stay ahead of the next handoff.",
    },
    "clear-to-close": {
        "summary": "This file is close enough to the finish line that the work shifts from cleanup into calm execution.",
        "action": "Keep final coordination tight and remove anything that could create last-minute friction.",
    },
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

PAUSE_WORDS = ["pause", "hold", "not now", "later", "circle back", "wait on this"]
RESUME_WORDS = ["resume", "continue", "pick back up", "let's keep going", "ready now"]
UNCERTAIN_WORDS = ["not sure", "don't know", "dont know", "unsure", "waiting on", "need to confirm", "checking on", "still waiting"]
MULTI_INTENT_SPLITTERS = [" and ", " also ", ";"]


def split_intents(message: str):
    parts = [message]
    for splitter in MULTI_INTENT_SPLITTERS:
        next_parts = []
        for part in parts:
            next_parts.extend([p.strip() for p in part.split(splitter) if p.strip()])
        parts = next_parts
    return parts


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


def determine_next_missing_field(raw: dict):
    _, classification = classify_transaction(raw)
    priority = [
        "buyer_name", "seller_name", "property_address", "county", "legal_description",
        "sale_price", "contract_effective_date", "closing_date", "title_company",
        "earnest_money", "option_fee", "loan_amount", "financing_type",
    ]
    for key in priority:
        if classification[key]["status"] in ("missing", "needs-confirmation"):
            return key
    return None


def determine_next_question(raw: dict):
    next_field = determine_next_missing_field(raw)
    if next_field:
        return QUESTION_MAP[next_field]
    return "This file looks complete enough for Dossie to move into document prep and follow-up guidance."


def determine_what_matters_now(raw: dict):
    normalized, classification = classify_transaction(raw)
    critical_missing = [
        field["label"]
        for key, field in classification.items()
        if key in CONTRACT_CRITICAL_FIELDS and field["status"] in ("missing", "needs-confirmation")
    ][:4]
    if critical_missing:
        return f"The file still has contract-critical gaps: {', '.join(critical_missing)}. Dossie should close those before trusting the document set."
    persona = STAGE_PERSONAS.get(raw.get("stage") or "")
    if persona:
        return persona["summary"]
    return "The file is structurally complete enough that Dossie can focus on document generation and next-party coordination."


def determine_next_action(raw: dict):
    normalized, classification = classify_transaction(raw)
    if any(key in CONTRACT_CRITICAL_FIELDS and field["status"] in ("missing", "needs-confirmation") for key, field in classification.items()):
        return "Ask the next missing contract question and update the dossier before generating or relying on more documents."
    persona = STAGE_PERSONAS.get(raw.get("stage") or "")
    if persona:
        return persona["action"]
    docs = recommend_documents(normalized, raw)
    return f"Generate or refresh: {', '.join(docs)}. Then prepare the next file-moving follow-up."


def merge_note(raw: dict, text: str):
    existing = (raw.get("notes") or "").strip()
    if not existing:
        return text
    if text.lower() in existing.lower():
        return existing
    return f"{existing} | {text}"


def extract_updates_from_part(part: str, raw: dict = None):
    lower = part.lower()
    updates = {}
    raw = raw or {}

    if "buyer changed to" in lower:
        updates["buyer_name"] = part.lower().split("buyer changed to", 1)[1].strip(" .").title()
    elif "buyer name is" in lower or "buyer is" in lower:
        source = "buyer name is" if "buyer name is" in lower else "buyer is"
        updates["buyer_name"] = part.lower().split(source, 1)[1].strip(" .").title()

    if "seller changed to" in lower:
        updates["seller_name"] = part.lower().split("seller changed to", 1)[1].strip(" .").title()
    elif "seller name is" in lower or "seller is" in lower:
        source = "seller name is" if "seller name is" in lower else "seller is"
        updates["seller_name"] = part.lower().split(source, 1)[1].strip(" .").title()

    if "sale price" in lower or "price is" in lower:
        digits = ''.join(ch for ch in part if ch.isdigit())
        if digits:
            updates["sale_price"] = int(digits)

    if "earnest money" in lower or "em is" in lower:
        digits = ''.join(ch for ch in part if ch.isdigit())
        if digits:
            updates["earnest_money"] = int(digits)

    if "option fee" in lower:
        digits = ''.join(ch for ch in part if ch.isdigit())
        if digits:
            updates["option_fee"] = int(digits)

    if "title says" in lower:
        notes = part.split("title says", 1)[1].strip(" .")
        if notes:
            updates["notes"] = merge_note(raw, notes)
    elif "title company" in lower:
        candidate = part.split("title company", 1)[1].replace("is", "").replace("will be", "").strip(" .:")
        if candidate and not any(phrase in lower for phrase in UNCERTAIN_WORDS):
            updates["title_company"] = candidate

    if "lender still hasn't" in lower or "lender still hasnt" in lower:
        updates["notes"] = merge_note(raw, part.strip())
    elif "lender" in lower:
        candidate = part.split("lender", 1)[1].replace("is", "").replace("will be", "").strip(" .:")
        if candidate and not any(phrase in lower for phrase in UNCERTAIN_WORDS):
            updates["lender_name"] = candidate

    if "closing got pushed to" in lower:
        candidate = part.lower().split("closing got pushed to", 1)[1].strip(" .:")
        if candidate:
            updates["closing_date"] = candidate
    elif "closing date" in lower:
        candidate = part.split("closing date", 1)[1].replace("is", "").strip(" .:")
        if candidate:
            updates["closing_date"] = candidate

    if "effective date" in lower:
        candidate = part.split("effective date", 1)[1].replace("is", "").strip(" .:")
        if candidate:
            updates["contract_effective_date"] = candidate

    if "option period ends" in lower:
        updates["notes"] = merge_note(raw, part.strip())

    if "county" in lower:
        candidate = part.split("county", 1)[1].replace("is", "").strip(" .:")
        if candidate and not any(phrase in lower for phrase in UNCERTAIN_WORDS):
            updates["county"] = candidate.title()

    if "we need to amend" in lower or "seller wants" in lower:
        updates["notes"] = merge_note(raw, part.strip())
    if "we're terminating" in lower or "we are terminating" in lower or "terminate the file" in lower:
        updates["status"] = "terminated"
        updates["notes"] = merge_note(raw, part.strip())

    financing_signals = [token for token in ["conventional", "fha", "va", "cash"] if token in lower.split()]
    if financing_signals:
        updates["financing_type"] = financing_signals[0]

    return updates


def extract_updates(message: str, raw: dict = None):
    combined = {}
    raw = raw or {}
    for part in split_intents(message):
        updates = extract_updates_from_part(part, {**raw, **combined})
        combined.update(updates)
    return combined


def detect_contradictions(raw: dict, updates: dict):
    contradictions = []
    for key, new_value in updates.items():
        old_value = raw.get(key)
        if key in {"buyer_name", "seller_name", "sale_price", "closing_date", "title_company", "lender_name", "earnest_money"}:
            if old_value not in (None, "") and new_value not in (None, "") and str(old_value).strip().lower() != str(new_value).strip().lower():
                contradictions.append((FIELD_LABELS.get(key, key), old_value, new_value))
    return contradictions


def build_status_summary(raw: dict, merged: dict):
    what_matters = determine_what_matters_now(merged)
    next_action = determine_next_action(merged)
    next_field = determine_next_missing_field(merged)
    if next_field:
        return f"Here is where the file stands: {what_matters} The next thing I would close is {FIELD_LABELS[next_field]}. {next_action}"
    return f"Here is where the file stands: {what_matters} {next_action}"


def build_conversation_reply(raw: dict, merged: dict, updates: dict, next_question: str, message: str):
    lower = message.lower().strip()
    next_field = determine_next_missing_field(merged)
    next_label = FIELD_LABELS.get(next_field, "the next contract detail") if next_field else None
    stage = merged.get("stage") or raw.get("stage") or "under-contract"
    persona = STAGE_PERSONAS.get(stage, {})
    contradictions = detect_contradictions(raw, updates)

    if any(phrase in lower for phrase in PAUSE_WORDS):
        return {
            "reply": "Of course. I can hold here. When you're ready, I'll pick back up with the next missing contract detail instead of making you restart the file.",
            "mode": "paused",
        }
    if any(phrase in lower for phrase in RESUME_WORDS):
        return {
            "reply": f"Perfect. Picking this back up now. {next_question}",
            "mode": "resumed",
        }
    if contradictions:
        label, old_value, new_value = contradictions[0]
        return {
            "reply": f"I can update {label}, but I want to be careful because I already have it as {old_value}. If {new_value} is the new correct version, I can treat that as the latest file state.",
            "mode": "contradiction",
        }
    if any(phrase in lower for phrase in UNCERTAIN_WORDS):
        if next_label:
            return {
                "reply": f"That is completely fine. I'll treat {next_label} as still open for now. {persona.get('action', 'The next clean step is simply to confirm it when you have it.')}",
                "mode": "uncertain",
            }
        return {
            "reply": "That is completely fine. I'll leave the file as-is for now and wait for the next confirmed detail before I push anything forward.",
            "mode": "uncertain",
        }
    if updates:
        changed = ', '.join(FIELD_LABELS.get(key, key).replace('_', ' ') for key in updates.keys())
        if updates.get("status") == "terminated":
            return {
                "reply": "Understood. I'll treat this as a termination path and keep the file focused on clean closeout instead of forward motion.",
                "mode": "updated",
            }
        if next_field:
            return {
                "reply": f"Perfect — I've updated {changed}. The next thing I still need is {next_label}. {next_question}",
                "mode": "updated",
            }
        return {
            "reply": f"Perfect — I've updated {changed}. {persona.get('summary', 'This file is complete enough now for me to move into document prep and next-step coordination.')}",
            "mode": "updated",
        }
    if "where do things stand" in lower or "where are we" in lower:
        return {
            "reply": build_status_summary(raw, merged),
            "mode": "status-summary",
        }
    if next_field:
        return {
            "reply": f"I heard you, but I still need {next_label} before I can move this file forward cleanly. {next_question}",
            "mode": "clarify",
        }
    return {
        "reply": f"I heard you. {persona.get('summary', 'This file already looks complete enough for me to stay focused on coordination, follow-up, and document timing rather than data cleanup.')}",
        "mode": "clarify",
    }


def conversation_update(raw: dict, message: str):
    message = message.strip()
    updates = extract_updates(message, raw)
    merged = {**raw, **updates}
    question = determine_next_question(merged)
    reply = build_conversation_reply(raw, merged, updates, question, message)
    return updates, question, reply
