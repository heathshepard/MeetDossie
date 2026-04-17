import json
import subprocess
import sys
from pathlib import Path
from normalize_transaction import normalize_transaction

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
SCRIPTS_DIR = BASE_DIR / "scripts"
GENERATED_DIR = BASE_DIR / "generated-docs"
GENERATED_DIR.mkdir(parents=True, exist_ok=True)

DOCUMENT_GENERATORS = {
    "resale-contract": SCRIPTS_DIR / "generate_resale_contract.py",
    "third-party-financing-addendum": SCRIPTS_DIR / "generate_third_party_financing_addendum.py",
    "amendment": SCRIPTS_DIR / "generate_amendment.py",
    "termination-notice": SCRIPTS_DIR / "generate_termination_notice.py",
}


def run_script(script_path: Path, temp_json: Path):
    result = subprocess.run([sys.executable, str(script_path), str(temp_json)], capture_output=True, text=True, check=True)
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    output_path = lines[-1] if lines else ""
    return {"script": str(script_path), "outputPath": output_path, "log": result.stdout}


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python generate_documents_from_transaction.py <transaction-json> [document-key]")

    raw_path = Path(sys.argv[1])
    document_key = sys.argv[2] if len(sys.argv) > 2 else "all"

    with raw_path.open("r", encoding="utf-8") as f:
        transaction = json.load(f)

    normalized = normalize_transaction(transaction)
    temp_json = GENERATED_DIR / f"normalized-{raw_path.stem}.json"
    with temp_json.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, indent=2)

    keys = [document_key] if document_key != "all" else list(DOCUMENT_GENERATORS.keys())
    outputs = {}
    for key in keys:
        script_path = DOCUMENT_GENERATORS[key]
        outputs[key] = run_script(script_path, temp_json)

    print(json.dumps({"documents": outputs}, indent=2))


if __name__ == "__main__":
    main()
