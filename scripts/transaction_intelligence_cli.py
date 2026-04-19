import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from transaction_intelligence import (
    classify_transaction,
    completeness_summary,
    recommend_documents,
    determine_what_matters_now,
    determine_next_question,
    determine_next_action,
    conversation_update,
)

if len(sys.argv) < 3:
    raise SystemExit('Usage: python transaction_intelligence_cli.py <analyze|conversation> <transaction-json> [message]')

command = sys.argv[1]
transaction_path = Path(sys.argv[2])
raw = json.loads(transaction_path.read_text(encoding='utf-8'))

normalized, classification = classify_transaction(raw)

if command == 'analyze':
    print(json.dumps({
        'classification': classification,
        'summary': completeness_summary(classification),
        'whatMattersNow': determine_what_matters_now(raw),
        'nextQuestion': determine_next_question(raw),
        'nextAction': determine_next_action(raw),
        'recommendedDocuments': recommend_documents(normalized, raw),
    }, indent=2))
    raise SystemExit(0)

if command == 'conversation':
    message = sys.argv[3] if len(sys.argv) > 3 else ''
    updates, question, reply = conversation_update(raw, message)
    print(json.dumps({'updates': updates, 'nextQuestion': question, 'reply': reply}, indent=2))
    raise SystemExit(0)

raise SystemExit(f'Unknown command: {command}')

