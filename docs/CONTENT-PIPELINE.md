# Nightly Content Pipeline

Unattended nightly generation of new `/guides/`, `/features/`, `/answers/` pages. Runs while Heath sleeps, lands everything in a review queue, **never auto-publishes**. Built 2026-08-11 (Atlas).

Read this before touching any `content_pipeline_queue` row or any `api/cron-generate-pages.js` / `api/cron-content-pipeline-review.js` / `api/cron-content-pipeline-promote.js` / `api/content-pipeline-submit.js` code.

---

## Why this exists

The manual batches built earlier the same night (55 guides, 16 answers, 7 features as of 2026-08-11) held to a real quality bar: primary-source TREC/statute citations, Hadley-style fact verification, "Hadley review catch" fix commits when something was wrong. This pipeline exists to keep producing pages at that bar automatically, not to trade quality for volume. **A generation task that can't clear the bar should report BLOCKED, not ship a thin page.**

---

## Architecture

```
cron-generate-pages (nightly, 05:30 UTC = 12:30am CDT / 11:30pm CST)
  -> picks 2-4 new topics (api/_lib/content-pipeline-topics.js, deduped
     against marketing/*-data/*.json AND every past content_pipeline_queue row)
  -> INSERT content_pipeline_queue (status='researching')
  -> INSERT agent_queue (agent hadley|carter, task_brief references this doc)

scripts/agent-queue-poller.js (already running on Heath's PC, unchanged)
  -> claims the agent_queue row, spawns a REAL `claude --agent hadley|carter
     --dangerously-skip-permissions` session with full tool access
  -> the agent researches (WebFetch trec.texas.gov / statutes.capitol.texas.gov
     / the live product), writes the page JSON, and POSTs it to
     /api/content-pipeline-submit
  -> content_pipeline_queue.status='pending_review' (or 'failed' if BLOCKED)

cron-content-pipeline-review (every 20 min)
  -> sends each pending_review row to Heath via Telegram (DossieMarketingBot)
     with topic, excerpt, sources, and Approve/Reject buttons
  -> telegram_sent_at stamped

telegram-webhook.js (cpage_approve_<id> / cpage_reject_<id> handlers)
  -> Approve: status='approved'
  -> Reject: status='rejected' (TERMINAL -- never auto-resurfaced)

cron-content-pipeline-promote (every 20 min)
  -> finds status='approved' rows
  -> INSERT agent_queue (agent atlas) -- real git/file access lives on
     Heath's PC via the poller, NOT in this serverless function
  -> atlas writes json_data to marketing/<type>-data/<slug>.json, runs
     `node scripts/build-<type>s.js`, git add/commit/push to staging
  -> atlas confirms via POST /api/content-pipeline-submit {status:'promoted'}
  -> status='promoted', promoted_at stamped -- page is now LIVE on staging
     (still needs the normal "merge it" gate to reach main/production,
     per CLAUDE.md Section 3)
```

Terminal states: `rejected` (discarded, never retried), `promoted` (live on staging), `failed` (research/generation/promotion broke -- logged in `error`, never silently retried the same topic).

---

## Table: `content_pipeline_queue`

See `supabase/migrations/20260811_content_pipeline_queue.sql` for the full DDL. Key columns:

| Column | Meaning |
|---|---|
| `night_batch_id` | e.g. `nightly-2026-08-11` -- groups one night's rows |
| `page_type` | `guide` \| `feature` \| `answer` |
| `topic` | Human-readable topic description (what the Telegram message and dedup logic use) |
| `slug` | Final slug, set when the agent submits |
| `status` | `researching` -> `pending_review` -> `approved`/`rejected` -> `promoted`/`failed` |
| `json_data` | Full page payload -- exact schema below |
| `sources` | `[{label, url}]` primary-source citations, shown in the Telegram approval message |
| `excerpt` | ~400-char preview for Telegram |
| `generation_task_id` / `promote_task_id` | FKs into `agent_queue` |

RLS enabled, no policy -- service-role only, same posture as `agent_queue`.

---

## Generation contract -- what the spawned agent must do

1. Read the task brief (topic, hint, existing-coverage list, `CONTENT_PIPELINE_ID`).
2. Research using primary sources. TREC forms: `https://www.trec.texas.gov/forms` (verify the CURRENT form number and text -- forms get renumbered). Statutes: `https://statutes.capitol.texas.gov/`. Product features: read the actual Dossie source and/or Playwright the real staging app -- never assume a feature exists from a name alone.
3. If the topic turns out to be non-existent, already effectively covered, or (for a feature) not actually built and live: **do not write a page.** POST `{content_pipeline_id, status:'failed', error:'<why>'}` to `/api/content-pipeline-submit` and end with `RESULT_SUMMARY: BLOCKED: <reason>`.
4. Otherwise, build `json_data` matching the exact schema for the page type (below), collect `sources` (every citation actually used, with real URLs), write a `excerpt` (2-4 sentences, no HTML), and POST to `/api/content-pipeline-submit`:

```bash
curl -X POST "https://meetdossie.com/api/content-pipeline-submit" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "content_pipeline_id": "<uuid from the task brief>",
    "status": "pending_review",
    "slug": "<final-slug>",
    "json_data": { ...full page payload... },
    "sources": [{"label":"TREC Form 20-19", "url":"https://www.trec.texas.gov/..."}],
    "excerpt": "2-4 sentence plain-text preview of the page."
  }'
```

`CRON_SECRET` is already in the poller's environment (`.env.local` / `~/.claude/agent-poller.env`) -- never paste the value, reference the env var name only.

### Guide JSON schema (`marketing/guides-data/*.json`, consumed by `scripts/build-guides.js`)

```
slug, title, title_html, meta_title, meta_description, eyebrow, deck,
calculator_blurb, updated_at (YYYY-MM-DD), related_blurb, body_html,
faq: [{q, a}], related_guides: [slug, ...]
```
Optional: `show_calculator` (bool, default true), `cta_title`, `cta_sub`.

### Answer JSON schema (`marketing/answers-data/*.json`, consumed by `scripts/build-answers.js`)

```
slug, title, title_html, meta_title, meta_description, deck,
updated_at (YYYY-MM-DD), tldr, tldr_html (optional), body_html,
faq: [{q, a}]
```

### Feature JSON schema (`marketing/features-data/*.json`, consumed by `scripts/build-features.js`)

```
slug, title, title_html, meta_title, meta_description, eyebrow, deck,
image, image_alt, image_caption, updated_at (YYYY-MM-DD), related_blurb,
intro_html, steps: [{h, p, p_html?}], callout, faq: [{q, a}],
related_features: [slug, ...]
```
`image` MUST be a real screenshot of the real live feature, saved to `assets/product/<slug>.png` (Playwright capture against staging, matching the existing 7 feature pages' convention) -- not a placeholder, not a description. If a genuine screenshot can't be captured, this is a BLOCKED outcome, not a page with a fake image path.

**Style rules (same as the manual batches):** `body_html`/`intro_html` are hand-written HTML (`<p>`, `<h2>`, `<h3>`, `<ul>`, `<strong>`, `.callout` divs) -- not markdown. ASCII-safe where practical but curly quotes/em-dashes in body copy are fine (unlike social posts, which are ASCII-only). ALWAYS cite the specific TREC form number or statute cite inline in the prose, not just in `sources`.

---

## Review flow (Telegram)

Heath sees one message per pending page via DossieMarketingBot: page type, topic, excerpt, sources list, and two buttons -- **Approve** / **Reject**. Approve moves it toward promotion (still requires the separate atlas promote task to actually land the file + push). Reject is terminal -- the topic is never auto-resurfaced by `content-pipeline-topics.js`'s dedup logic.

---

## Safety caps

- **2-4 pages per night**, hard cap via `MAX_PAGES_PER_NIGHT` (default 3) in `cron-generate-pages.js`.
- If zero unclaimed candidates exist across all three types, the cron sends a Telegram alert ("nightly content pipeline: no new topics available") instead of silently doing nothing.
- If a generation task fails/times out, the poller's existing 25-min watchdog kills it and reports `blocked` -- `cron-content-pipeline-promote` never touches a row that isn't `status='approved'`, so a stuck/failed generation can never reach the live site.
- Promotion is a two-agent handoff (Heath approves in Telegram -> atlas confirms the actual git push) -- no code path exists that writes to `marketing/*-data/` without both a human Approve tap AND a real, logged git commit.

---

## Manual testing

```bash
# Apply the table migration (idempotent, safe to re-run):
curl -X POST "https://meetdossie.com/api/admin-migrate-content-pipeline-queue" \
  -H "Authorization: Bearer $CRON_SECRET"

# Trigger one nightly generation run manually (don't wait for 05:30 UTC):
curl -X POST "https://meetdossie.com/api/cron-generate-pages" \
  -H "Authorization: Bearer $CRON_SECRET"

# Trigger the review-send manually:
curl -X POST "https://meetdossie.com/api/cron-content-pipeline-review" \
  -H "Authorization: Bearer $CRON_SECRET"

# Trigger the promote sweep manually:
curl -X POST "https://meetdossie.com/api/cron-content-pipeline-promote" \
  -H "Authorization: Bearer $CRON_SECRET"
```

All four endpoints accept `Authorization: Bearer $CRON_SECRET` per CLAUDE.md Section 15's approved manual-trigger pattern.
