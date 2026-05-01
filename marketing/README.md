# Dossie Marketing Pipeline — Phase 1 (text-only)

Daily content engine. Three Vercel crons + one Telegram webhook produce, approve, and publish text-only social posts across Instagram, TikTok, Facebook, Twitter, and LinkedIn via Zernio.

## Daily flow

```
06:00 CT (11:00 UTC)   cron-generate-posts        → 6 drafts to social_posts (status='draft')
06:30 CT (11:30 UTC)   cron-send-for-approval     → push each draft to Telegram with [Approve][Reject][Edit] buttons
                       telegram-webhook            ← Heath taps a button on his phone
                                                    approve  → status='approved'
                                                    reject   → status='rejected'
                                                    edit     → reply with new content; cycles back to draft
every 30 min           cron-publish-approved      → POST approved rows to Zernio; status='posted'
```

## Files

| File | Purpose |
|---|---|
| `api/cron-generate-posts.js` | Calls Claude Sonnet, drafts 6 posts (2 each for Brenda / Patricia / Victor). Inserts rows + a `content_batches` summary. |
| `api/cron-send-for-approval.js` | Picks `status='draft' AND telegram_sent_at IS NULL`, sends each via Telegram with inline keyboard. |
| `api/telegram-webhook.js` | Receives callback queries (button taps) and reply messages. Updates row + edits the original Telegram message. |
| `api/cron-publish-approved.js` | Picks `status='approved' AND posted_at IS NULL`, POSTs to Zernio, sets `status='posted'`. |
| `marketing/schema-migration.sql` | One-shot column additions on `social_posts`. |

## Env vars (Vercel → Settings → Environment Variables)

| Name | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | generate | already configured |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all | already configured |
| `CRON_SECRET` | all crons | already configured |
| `ZERNIO_API_KEY` | publish | confirm in prod env (was in `.env.local`) |
| `TELEGRAM_BOT_TOKEN` | send, webhook | from @BotFather → /mybots → API token (Claudy_Max_Bot) |
| `TELEGRAM_CHAT_ID` | send, webhook | `7874782923` (Heath's chat with the bot) |
| `TELEGRAM_WEBHOOK_SECRET` | webhook (optional but recommended) | random string; pass to `setWebhook` as `secret_token` |

## One-time setup after deploy

1. **Run the SQL migration** — open Supabase Studio → SQL Editor → paste `marketing/schema-migration.sql` → run. Should report 6 rows.
2. **Set the env vars** above on Vercel for Production (and Preview if you want to test there).
3. **Register the Telegram webhook**:
   ```bash
   curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=https://meetdossie.com/api/telegram-webhook" \
     -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
     -d "allowed_updates=[\"callback_query\",\"message\"]"
   ```
   Verify with:
   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
   ```
4. **Deploy**: `.\deploy.ps1` from MeetDossie root.

## Manual test plan (run after deploy)

```bash
# 1. Trigger generation (should land 6 drafts in social_posts)
curl -X POST https://meetdossie.com/api/cron-generate-posts \
  -H "Authorization: Bearer ${CRON_SECRET}"

# 2. Trigger Telegram send (you should receive 6 messages with buttons)
curl -X POST https://meetdossie.com/api/cron-send-for-approval \
  -H "Authorization: Bearer ${CRON_SECRET}"

# 3. Tap [Approve] on one in Telegram. Confirm status flips:
#    SELECT id, status, approved_at FROM social_posts ORDER BY created_at DESC LIMIT 6;

# 4. Trigger publish (should push the approved row to Zernio)
curl -X POST https://meetdossie.com/api/cron-publish-approved \
  -H "Authorization: Bearer ${CRON_SECRET}"

# 5. Confirm the post landed on the actual platform.
```

## Personas

| Key | Profile | Voice |
|---|---|---|
| `brenda` | Burned-out solo agent, 6 yrs, $8K/yr to TC | Tired, witty, blunt about industry pain |
| `patricia` | Part-time agent, 8-12 deals/yr, day job | Practical, budget-conscious, no fluff |
| `victor` | Top producer, 50+ deals/yr, runs a team | Confident, math-driven, ambitious |

## Topics (rotated by day-of-year mod 4)

0. The cost math (current TC cost vs Dossie at $29/mo)
1. Pain points (missed deadlines, ghosted TCs, weekend stress)
2. Day-in-the-life moments
3. Product capability one-liners

## Post plan per day

6 posts: 2 per persona, mixing long-form and short-form platforms.

| # | Persona | Platform | Length |
|---|---|---|---|
| 1 | Brenda | LinkedIn | long |
| 2 | Brenda | Twitter | short |
| 3 | Patricia | Facebook | long |
| 4 | Patricia | Instagram | short |
| 5 | Victor | LinkedIn | long |
| 6 | Victor | TikTok | short |

## Editing flow detail

When Heath taps **✏️ Edit**, the bot sends a `force_reply` message containing the post id. Heath replies with the new content. The webhook detects the reply (via `reply_to_message`), parses the post id from the prompt text, overwrites `content` + `hook`, resets `telegram_sent_at` to null, and sets `status='draft'` so the post re-enters the next approval cycle.

## Failure modes

- **Anthropic rate-limited / down** → cron-generate returns 502 and inserts nothing. Next day's run picks up cleanly.
- **Telegram delivery fails** → row stays at `telegram_sent_at=NULL`, cron-send retries it tomorrow.
- **Zernio rejects a post** → row stays at `status='approved' AND posted_at=NULL`. cron-publish retries every 30 min until success or manual rejection. (No max-retry cap implemented — TODO if it becomes an issue.)
- **Heath ignores Telegram** → drafts sit in `status='draft'` forever, doing no harm. Optional future: auto-reject after N days.

## Phase 2 (not built yet)

- Video render pipeline + media uploads.
- `media_url` column on social_posts.
- Approval analytics (which personas/topics get approved most).
- Auto-rejection of stale drafts after N days.
- Variation A/B-testing of hooks.
