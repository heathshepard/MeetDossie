# Weekly Newsletter APV Proof

Locked 2026-07-02 after the 2nd time non-customer items leaked into the Friday customer email.

## What this folder is for

Every Friday, `api/cron-weekly-newsletter.js` looks for a signed proof file BEFORE sending. If missing, the send cron aborts and Telegrams Heath.

## File naming

`weekly-apv-YYYY-MM-DD.md` where the date is the send Friday, America/Chicago.

Example: `weekly-apv-2026-07-03.md`.

## Required contents

The file MUST contain a line matching:

```
APPROVED_BY: cole
```

(case-insensitive on `cole`). Everything else is optional metadata.

## Cole/Jarvis Thursday workflow

Thursday 8 AM CDT the DRAFT cron generates `newsletter_drafts` row + emails Heath the preview. Cole:

1. Reads the draft (via `newsletter_drafts` row or the Thursday preview email).
2. Confirms every bullet is customer-facing.
3. Writes the APV file to `.newsletter-audit/weekly-apv-YYYY-MM-DD.md` with:
   - `APPROVED_BY: cole`
   - `approved_at: <ISO timestamp>`
   - `notes:` any redactions or edit requests
4. Commits the APV file to main.

If any bullet is non-customer, Cole must EDIT/REGEN the draft first (via the Telegram command flow) THEN write the proof.

## Bypass

Manual bypass with `?force=1&Authorization: Bearer $CRON_SECRET` on the send endpoint. Vercel cron cannot use this bypass.
