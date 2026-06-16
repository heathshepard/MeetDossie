# Demo Accounts

LOCKED. DO NOT CHANGE.

| Email | Password (env var) | Profile Name | Personas | Voice |
|---|---|---|---|---|
| `demo@meetdossie.com` | `DEMO_PASSWORD` = `DossieDemo-VaIiAt6Bab` | Sarah Whitley | brenda, patricia | Luna |
| `demo2@meetdossie.com` | `DEMO2_PASSWORD` = `DossieDemo2-John2026` | John Smith | victor | Bill |

Both seeded with 6 transactions, 25 documents, 20 action items.

---

## PERSONA → DEMO ACCOUNT MAPPING — LOCKED

| Persona | Demo account | Voice |
|---|---|---|
| brenda | Sarah Whitley / `demo@meetdossie.com` | Luna |
| patricia | Sarah Whitley / `demo@meetdossie.com` | Luna |
| victor | John Smith / `demo2@meetdossie.com` | Bill |

---

## Notes

- Demo accounts are excluded from analytics via `profiles.is_demo=true` flag. Any new user-facing aggregation over profiles must add `WHERE is_demo=false`.
- Never repurpose demo account emails for real customers.
- Demo passwords are intentionally in env vars (rotate quarterly).
