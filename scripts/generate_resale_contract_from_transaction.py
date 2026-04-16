import json
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
GENERATOR = BASE_DIR / "scripts" / "generate_resale_contract.py"
TEMP_DIR = BASE_DIR / "generated-docs"
TEMP_DIR.mkdir(parents=True, exist_ok=True)


def normalize_date(value):
    if not value:
        return ""
    value = str(value)
    if len(value) >= 10 and value[4] == '-' and value[7] == '-':
        y, m, d = value[:10].split('-')
        return f"{m}/{d}/{y}"
    return value


def normalize_transaction(data: dict) -> dict:
    role = data.get("role") or "listing"
    client_name = data.get("buyer_name") if role == "buyer" else data.get("seller_name")
    return {
        "buyer_name": data.get("buyer_name") or (client_name if role == "buyer" else ""),
        "seller_name": data.get("seller_name") or (client_name if role == "listing" else ""),
        "property_address": data.get("property_address") or "",
        "city_state_zip": data.get("city_state_zip") or "",
        "county": data.get("county") or "",
        "legal_description": data.get("legal_description") or "",
        "sale_price": str(data.get("sale_price") or ""),
        "earnest_money": str(data.get("earnest_money") or ""),
        "option_fee": str(data.get("option_fee") or ""),
        "contract_effective_date": normalize_date(data.get("contract_effective_date")),
        "closing_date": normalize_date(data.get("closing_date")),
        "title_company": data.get("title_company") or "",
        "lender_name": data.get("lender_name") or "",
        "financing_addendum": bool(data.get("lender_name") or data.get("loan_amount") or data.get("financing_type")),
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python generate_resale_contract_from_transaction.py <transaction-json>")

    raw_path = Path(sys.argv[1])
    with raw_path.open("r", encoding="utf-8") as f:
        transaction = json.load(f)

    normalized = normalize_transaction(transaction)
    temp_json = TEMP_DIR / "normalized-dossier.json"
    with temp_json.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, indent=2)

    subprocess.run([sys.executable, str(GENERATOR), str(temp_json)], check=True)
    print(str(BASE_DIR / "generated-docs" / "sample-resale-contract.pdf"))


if __name__ == "__main__":
    main()
