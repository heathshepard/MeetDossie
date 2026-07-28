# Demo Accounts

LOCKED. DO NOT CHANGE.

| Email | Password (env var) | Profile Name | Personas | Voice |
|---|---|---|---|---|
| `demo@meetdossie.com` | `DEMO_PASSWORD` (Vercel env) | Sarah Whitley | brenda, patricia | Luna |
| `demo2@meetdossie.com` | `DEMO2_PASSWORD` (Vercel env) | John Smith | victor | Bill |

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
- Demo passwords live ONLY in Vercel env. Never write the value in this file,
  in a script, or in a commit - this repo is public. Retrieve with
  `npx vercel env pull` or from the Vercel dashboard.
- Rotated 2026-07-28 after both values were found committed in plaintext here
  and in three .tmp/ scripts. Rotate quarterly.
