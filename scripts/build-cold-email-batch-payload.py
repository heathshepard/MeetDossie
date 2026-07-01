"""
Pierce dry-run — build the Resend batch payload for the 50-lead first send.

Selection:
  - Pool: pattern-guessed emails on MX-verified domains.
  - Balanced sample: 5 leads per top-10 brokerage (matches probe methodology).
  - EXCLUDES the one row that hard-bounced (cheo.chayoh@lptrealty.com) from the
    deliverability probe.

Payload:
  - Format matches Resend /emails endpoint used elsewhere (see
    api/cron-thursday-blast.js sendEmail()).
  - Includes: from, to, subject, html, text, reply_to, bcc.
  - Personalization tokens {{first_name}}, {{city}}, {{brokerage}} pre-rendered
    (Resend doesn't template — we send fully rendered payloads).
  - Uses Hook 1 (founder origin) + Subject A ("did your tc quit?") per
    docs/cold-email-sa-realtors-v1.md.
  - UTM tags on /founding CTA per task spec.
  - Northwest address in CAN-SPAM footer.

Output: data/cold-email-batch-1-payload.json
  Structure: {batch_id, generated_at, total, from, subject, source_doc,
              messages: [{to, first_name, city, brokerage, html, text}]}
"""
import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone

SRC = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-leads-final-v2.csv"
DST = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\cold-email-batch-1-payload.json"

# Excluded from probe results
KNOWN_BOUNCES = {"cheo.chayoh@lptrealty.com"}

FROM_ADDRESS = "Heath Shepard <heath@meetdossie.com>"
REPLY_TO = "heath@meetdossie.com"
SUBJECT = "did your tc quit?"
BCC = "heath@meetdossie.com"

FOUNDING_URL = (
    "https://meetdossie.com/founding"
    "?utm_source=cold-email&utm_campaign=sa-batch-1&utm_medium=email"
)
UNSUB_URL = "https://meetdossie.com/unsubscribe"
NW_ADDRESS = "Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731"


def title_first_name(name: str) -> str:
    """Pull the first-name token from 'First Last' — title-case."""
    parts = name.strip().split()
    if not parts:
        return "there"
    return parts[0].title()


def city_or_default(city: str) -> str:
    """SA/Boerne default if city missing."""
    c = (city or "").strip()
    if not c:
        return "San Antonio"
    return c


def build_text(first_name: str, city: str, email: str) -> str:
    """Plain-text version of Hook 1 — matches docs/cold-email-sa-realtors-v1.md."""
    unsub = f"{UNSUB_URL}?email={email}"
    return f"""{first_name} — last year my TC quit on me while I was in Italy with three deals in escrow.

I'm a working REALTOR at KW in {city}, so I rebuilt the back office myself and ended up turning it into software. It's called Dossie. She drafts your TREC forms, watches every deadline, and writes the client updates so you don't have to.

If you're paying $400 a file to a TC right now — that's $4.8k to $12k a year for most of us.

Worth a quick reply if that math sounds familiar?

— Heath
KW City View / KW Boerne

P.S. We're holding the founding rate at $29/mo for the first 50 agents — locked for the lifetime of your subscription. Fewer than 40 spots remaining. {FOUNDING_URL}

---
Unsubscribe: {unsub}
{NW_ADDRESS}
"""


def build_html(first_name: str, city: str, email: str) -> str:
    """HTML version. Minimal styling — plain-looking cold email performs best."""
    unsub = f"{UNSUB_URL}?email={email}"
    body = f"""<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>{first_name} — last year my TC quit on me while I was in Italy with three deals in escrow.</p>

<p>I'm a working REALTOR at KW in {city}, so I rebuilt the back office myself and ended up turning it into software. It's called Dossie. She drafts your TREC forms, watches every deadline, and writes the client updates so you don't have to.</p>

<p>If you're paying $400 a file to a TC right now — that's $4.8k to $12k a year for most of us.</p>

<p>Worth a quick reply if that math sounds familiar?</p>

<p>— Heath<br>
KW City View / KW Boerne</p>

<p style="color: #555;">P.S. We're holding the founding rate at $29/mo for the first 50 agents — locked for the lifetime of your subscription. Fewer than 40 spots remaining. <a href="{FOUNDING_URL}">Founding details</a>.</p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="{unsub}" style="color: #888;">Unsubscribe</a> | {NW_ADDRESS}
</p>
</div>"""
    return body


def main():
    with open(SRC, "r", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    populated = [
        r for r in rows
        if r.get("email_source", "").startswith("pattern_guess:")
        and r["email"] not in KNOWN_BOUNCES
    ]

    # Balanced: top 10 brokerages by count, up to 5 leads each
    by_broker = defaultdict(list)
    for r in populated:
        by_broker[r["brokerage"].strip()].append(r)
    top10 = sorted(by_broker.items(), key=lambda x: -len(x[1]))[:10]

    sample = []
    for broker, rs in top10:
        # Prefer rows with confirmed city; keep deterministic order (already sorted by source)
        sample.extend(rs[:5])

    # Cap at 50 in case a broker has < 5 — we may end up shy; grab more to fill.
    if len(sample) < 50:
        picked = {r["email"] for r in sample}
        for broker, rs in top10:
            for r in rs[5:]:
                if len(sample) >= 50:
                    break
                if r["email"] in picked:
                    continue
                sample.append(r)
                picked.add(r["email"])
            if len(sample) >= 50:
                break

    sample = sample[:50]

    messages = []
    for row in sample:
        email = row["email"]
        first_name = title_first_name(row["name"])
        city = city_or_default(row.get("city", ""))
        brokerage = row["brokerage"].strip()

        messages.append({
            "to": email,
            "personalization": {
                "first_name": first_name,
                "city": city,
                "brokerage": brokerage,
            },
            "subject": SUBJECT,
            "html": build_html(first_name, city, email),
            "text": build_text(first_name, city, email),
            "reply_to": REPLY_TO,
            "from": FROM_ADDRESS,
            "bcc": [BCC],
            "tags": [
                {"name": "campaign", "value": "sa-cold-batch-1"},
                {"name": "hook", "value": "founder-origin"},
                {"name": "subject_variant", "value": "A"},
                {"name": "brokerage", "value": re.sub(r"[^A-Za-z0-9_-]", "_", brokerage)[:60]},
            ],
        })

    payload = {
        "batch_id": "sa-cold-batch-1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generated_by": "Pierce",
        "source_leads_csv": "data/sa-realtor-leads-final-v2.csv",
        "source_copy_doc": "docs/cold-email-sa-realtors-v1.md",
        "hook": "1-founder-origin",
        "subject_variant": "A (did your tc quit?)",
        "resend_endpoint": "POST https://api.resend.com/emails",
        "resend_headers_note": "Authorization: Bearer $RESEND_API_KEY, Content-Type: application/json",
        "total_messages": len(messages),
        "guardrails": [
            "Do NOT send until Hadley CAN-SPAM approves",
            "Do NOT send until admin cold-email dashboard merged",
            "Do NOT send until Heath green-lights",
            "Send window: Tue/Wed/Thu 8:30 AM CST per feedback_email_send_timing",
            "Expected bounce rate: 15-25% (accept-all provider caveat)",
        ],
        "messages": messages,
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"Payload messages: {len(messages)}")
    print(f"Unique brokerages: {len(set(m['personalization']['brokerage'] for m in messages))}")
    print(f"Wrote: {DST}")

    # Sample-check: print first payload
    print("\n=== Sample message ===")
    m = messages[0]
    print(f"To: {m['to']}")
    print(f"Subject: {m['subject']}")
    print(f"First name: {m['personalization']['first_name']}")
    print(f"City: {m['personalization']['city']}")
    print(f"Brokerage: {m['personalization']['brokerage']}")
    print("--- text ---")
    print(m['text'])


if __name__ == "__main__":
    main()
