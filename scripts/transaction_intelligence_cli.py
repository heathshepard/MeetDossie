import json
import sys
from pathlib import Path
from transaction_intelligence import (
    classify_transaction,
    completeness_summary,
    recommend_documents,
    determine_next_question,
    determine_what_matters_now,
    determine_next_action,
    conversation_update,
)


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Usage: python transaction_intelligence_cli.py <analyze|conversation> <transaction-json> [message]')

    command = sys.argv[1]
    raw_path = Path(sys.argv[2])
    with raw_path.open('r', encoding='utf-8') as f:
        raw = json.load(f)

    if command == 'analyze':
        normalized, classification = classify_transaction(raw)
        payload = {
            'normalized': normalized,
            'classification': classification,
            'completeness': completeness_summary(classification),
            'whatMattersNow': determine_what_matters_now(raw),
            'nextQuestion': determine_next_question(raw),
            'nextAction': determine_next_action(raw),
            'recommendedDocuments': recommend_documents(normalized, raw),
        }
        print(json.dumps(payload, indent=2))
        return

    if command == 'conversation':
        message = sys.argv[3] if len(sys.argv) > 3 else ''
        updates, question = conversation_update(raw, message)
        print(json.dumps({'updates': updates, 'nextQuestion': question}, indent=2))
        return

    raise SystemExit('Unknown command')


if __name__ == '__main__':
    main()
