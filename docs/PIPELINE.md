# Social Media Pipeline

## Social posting (code = source of truth)

1. `cron-generate-posts` 11AM UTC — 6 posts via Sonnet 4.6, upsert `on_conflict=post_id`, resets `telegram_sent_at`, renders cards via HCTI (IG+FB), stores `card_body` (50w max) + `caption` separately.
2. `cron-send-for-approval` 11:30 UTC — drafts where `status='draft'` AND `telegram_sent_at IS NULL`. Sends 2 messages to DossieMarketingBot: (1) card image, no buttons; (2) full caption+hashtags with Approve/Reject/Edit.
3. `cron-publish-approved` every 30min — `status='approved'` → Zernio (FB/Twitter/IG/LinkedIn/TikTok). Twitter splits to max 6 chunks paragraph-first. Sets `posted` or `failed`.

---

## CONTENT RULES — NON-NEGOTIABLE

**Persona voice:** all content in **third person** — never first-person "I". Brenda=she/her, Patricia=she/her, Victor=he/him. WRONG "I closed 6 deals." RIGHT "She closed 6 deals."

**Field constraints:** `card_body` max 50w (card only); `caption` full text; `stat` max 10 chars ("$8,000","80+"); `stat_label` max 50 chars; `hook` max 8 words, pattern-interrupting.

**Text encoding:** ASCII only — no em-dashes (—), en-dashes (–), curly quotes, special Unicode. Plain hyphens + straight quotes. HCTI + Telegram require this.

---

## KNOWN ISSUES / WATCH LIST

- TikTok posts sit as `pending_video` — video pipeline separate (inactive until ~May 20).
- FB hashtags inconsistent — check AI prompt if missing.
- Founding spot count = `subscriptions` where `status='active'` AND `plan='founding'`.
- HCTI free 50/mo — monitor; upgrade $14/mo at 1k.

---

## SOCIAL MEDIA ACCOUNTS

| Platform | Handle | Zernio status |
|---|---|---|
| Facebook Page | MeetDossie | ✅ connected |
| Instagram | @meetdossie | ✅ connected |
| Twitter / X | @meetdossie | ✅ connected |
| TikTok | @meetdossietc | ✅ connected ✅ active (live since 2026-05-08) |
| Threads | @meetdossie | not automated |
| LinkedIn | linkedin.com/company/meetdossie | ✅ connected ✅ active (live since 2026-05-07) |

---

## ZERNIO ACCOUNT IDs

| Platform | Account ID | Active |
|---|---|---|
| facebook | `69f253c3985e734bf3d8f9bc` | ✅ |
| instagram | `69f25431985e734bf3d8fcbe` | ✅ |
| twitter | `69f255c6985e734bf3d90ba1` | ✅ |
| linkedin | `69fccd7392b3d8e85f8f12be` | ✅ (URN `urn:li:organization:115997183`) |
| tiktok | `69f15791985e734bf3d13b89` | ✅ |
