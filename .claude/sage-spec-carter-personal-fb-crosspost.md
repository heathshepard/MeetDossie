# Carter Spec — Personal FB Cross-Post Pipeline (Heath's personal profile)

**Author:** Sage
**Date:** 2026-06-12
**Priority:** HIGH (3rd-highest-leverage move from the 2026-06-12 social audit)
**Approved by Heath:** 2026-06-12 1:06 PM CDT
**Estimated build time:** 1.5 hours

---

## Why this build matters

Heath's personal `heath.shepard@kw.com` Facebook profile has **410+ followers — almost all Texas REALTORs in his sphere of trust**. The @meetdossie business page has near-zero organic reach because:

1. Personal accounts get algorithm trust that business Pages don't
2. Heath's network is the exact audience we're trying to reach (TX agents)
3. A personal-voice post from someone they know converts at 10-20x the rate of a brand post

The current pipeline posts ONLY to the @meetdossie business page. This build adds a **parallel personal-voice variant** for every post, posted to Heath's personal profile via the established PyAutoGUI pattern (per memory: `feedback_pyautogui_not_playwright.md` — never fresh Playwright, always real Chrome).

---

## What to build

### Phase 1 — Generation extension (new personal_fb variant per post)

**File:** `api/cron-generate-posts.js`

**Change:** Add a new slot to `POST_PLAN_BASE` (line ~432):

```js
// PERSONAL_FB — Heath's personal voice for cross-posting to his own profile.
// Different tone, same substance as the business page CAPABILITY_ONELINER.
// Posted via api/cron-publish-personal-fb.js -> scripts/atlas-fb-post-personal-pyautogui.py.
{
  format: 'PERSONAL_FB',
  persona: 'heath',          // not a marketing persona — Heath's real first-person voice
  platform: 'facebook_personal',
  notes: 'First-person ("I built", "I noticed", "I keep finding"). Acknowledge KW agent status casually. Tag @meetdossie once. ONE soft ask ("comment or DM me if you want to try it"). NEVER read like an ad. Treat this like a post Heath would write himself between showings — warm, slightly self-deprecating, real. Draws from the SAME topic + facts as the business-page CAPABILITY_ONELINER from the same batch.',
},
```

**Add a new content format** to the format-specific instructions block — the existing system uses `CAPABILITY_ONELINER`, `TREC_EDUCATION`, `PERSONA_STORY`, `FOUNDER_STORY`. Add `PERSONAL_FB`:

```js
// Inside the buildGenerationPrompt() function — add this branch
if (slot.format === 'PERSONAL_FB') {
  return [
    'FORMAT: PERSONAL_FB — Heath\'s real first-person voice posting to his personal Facebook profile.',
    '',
    'AUDIENCE: His personal network — ~410 followers, mostly Texas REALTORs at KW and beyond. People who know him personally.',
    '',
    'VOICE RULES — non-negotiable:',
    '- First person. "I built", "I noticed", "I keep finding", "I kept missing".',
    '- Acknowledge he\'s a working KW agent (sphere of trust). E.g. "I\'m still doing deals at KW, but I built this on the side because...".',
    '- Tag @meetdossie once in the body (so traffic flows to the business page).',
    '- ONE soft ask at the end: "If you\'re a TX agent and want to try it, comment or DM me." NEVER a hard CTA. NEVER a link.',
    '- Self-deprecating > polished. Sound like a real post, not a press release.',
    '- NO platform jargon ("we shipped", "this week\'s feature", "pipeline view"). Use plain language.',
    '- NO hashtags. Personal Facebook posts with hashtags look spammy.',
    '- 4-7 sentences total. Tight.',
    '',
    'CONTENT:',
    `- Topic this batch: ${topic.label}`,
    '- Pull from the SAME shipped feature/pain story being highlighted in the business-page Facebook post from this batch — but reframe in Heath\'s personal voice.',
    '- Reference the founder pain stories ONLY from the verified facts. Never invent specifics.',
    '',
    'STRUCTURE:',
    '1. Personal observation or admission (2-3 sentences)',
    '2. What he built / how it works (1-2 sentences) — mention @meetdossie',
    '3. Soft ask (1 sentence)',
  ].join('\n');
}
```

**Update the verifier prompt** (line ~40) to add `PERSONAL_FB` as a recognized format:

```js
### PERSONAL_FB posts (Heath's personal first-person voice — for his personal FB profile)
Heath posts in his real voice to his personal network. Must reference only verified founder stories (TC quit in Italy, $400/file/4:30am, vacation stress) — NO invented dates, member counts, or testimonials. Must tag @meetdossie. Must NOT include hashtags. Soft ask only ("comment or DM me"). Flag any hard CTA, any URL, any hashtag, any invented specific.
```

### Phase 2 — Posting schedule entry

**Database:** Add `posting_schedule` rows for `facebook_personal`:

```sql
-- 1/day cadence, weekdays only, 10 AM CDT (after the business-page post lands at 9 AM)
INSERT INTO posting_schedule (platform, day_of_week, time_slots, timezone, is_active, max_per_day, max_per_slot)
VALUES
  ('facebook_personal', 1, '["10:00:00"]'::jsonb, 'America/Chicago', true, 1, 1),  -- Mon
  ('facebook_personal', 2, '["10:00:00"]'::jsonb, 'America/Chicago', true, 1, 1),  -- Tue
  ('facebook_personal', 3, '["10:00:00"]'::jsonb, 'America/Chicago', true, 1, 1),  -- Wed
  ('facebook_personal', 4, '["10:00:00"]'::jsonb, 'America/Chicago', true, 1, 1),  -- Thu
  ('facebook_personal', 5, '["10:00:00"]'::jsonb, 'America/Chicago', true, 1, 1);  -- Fri
-- Sat/Sun deliberately skipped — Heath's personal network engages weekdays only
```

Reasoning: 1/day max protects his personal network from feeling spammed. 10 AM CDT (1 hour after the 9 AM business-page post) lets the business post land first, then the personal post amplifies — algorithm-friendly stagger.

### Phase 3 — Publishing endpoint (parallel to cron-publish-approved)

**File:** `api/cron-publish-personal-fb.js` (new)

- Runs every 30 minutes via Vercel cron (same cadence as cron-publish-approved)
- Queries `social_posts` where `platform='facebook_personal'` AND `status='approved'` AND `scheduled_for <= NOW()`
- For each row:
  1. Writes the post body to a temp file: `Media/personal-fb-queue/post-{post_id}.txt`
  2. Fires a Telegram message to Heath with the post body + 2 buttons:
     - "📤 Post to my FB now" → triggers the PyAutoGUI runner on Heath's machine
     - "❌ Skip this one" → marks the row `status='rejected'`
  3. Sets `status='pending_manual_post'` until Heath taps a button (manual gate for personal-profile posts — Heath has final say on every word that goes to his network)

**Why manual gate:** Heath's personal FB is his real reputation. Even with verifier passing, every post to his personal profile gets one human-readable look before it ships. This is the same model as the existing `DossieMarketingBot` approval flow.

### Phase 4 — PyAutoGUI runner (the actual poster)

**File:** `scripts/atlas-fb-post-personal-pyautogui.py` (new)

Adapt the existing `scripts/atlas-fb-post-pyautogui.py` pattern. Differences:

- **Target URL:** `https://www.facebook.com/` (his personal home feed, not a group)
- **Composer trigger:** "What's on your mind, Heath?" instead of "Write something..."
- **No "pending approval" flow** — personal posts go live immediately
- **Audience check:** Before clicking Post, verify the audience selector says "Friends" or "Public" (not "Only me"). Screenshot for audit trail.
- **Outcome JSON:** `posted`, `composer_missing`, `audience_wrong`, `paste_failed`, `post_button_missing`

**Trigger mechanism:** A small Node helper `scripts/run-personal-fb-post.js` that the Telegram button callback hits. Helper spawns the Python script with the post body file path + post_id, captures stdout JSON, updates `social_posts.status` to `posted` or `failed`.

**Chrome profile rule:** Per memory `feedback_pyautogui_not_playwright.md` — drive Heath's already-open Chrome window, NEVER spawn fresh Playwright. The PyAutoGUI runner finds an existing about:blank tab (or opens a new one with Ctrl+T) and works inside Heath's real session.

### Phase 5 — Safety + observability

**Volume guard:** Hard cap of 1 personal FB post per 24h, even if the cron fires twice. Enforce in `api/cron-publish-personal-fb.js`:

```js
// Refuse to ship if there's already a posted personal_fb in last 24h
const recentCheck = await supabaseFetch(
  `/rest/v1/social_posts?platform=eq.facebook_personal&status=eq.posted&posted_at=gte.${new Date(Date.now() - 24*60*60*1000).toISOString()}&select=post_id&limit=1`
);
if (recentCheck.data && recentCheck.data.length > 0) {
  console.log('[cron-publish-personal-fb] 24h cap reached — skipping');
  return res.json({ ok: true, skipped: true, reason: '24h_cap' });
}
```

**Telegram alerts:**
- On successful post: simple "✅ Personal FB post live: [first 60 chars]..." message
- On failure: full error + screenshot path so Heath can manually post if needed
- Weekly Sunday digest: count of posts to personal FB in last 7 days + engagement summary once analytics pull is live

**Env vars (no new ones):**
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — existing
- `CRON_SECRET` — existing
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — existing (Claudy bot, not DossieMarketingBot)

### Phase 6 — vercel.json cron registration

Add to `vercel.json`:

```json
{
  "path": "/api/cron-publish-personal-fb",
  "schedule": "*/30 * * * *"
}
```

---

## Verifier rules — non-negotiable

The existing verifier (Haiku 4.5) MUST reject personal_fb posts that:

1. **Reference any unverified specific** — e.g. "Last Tuesday at 9:43pm" (not in the verified facts) → red flag
2. **Use any hashtag** — personal FB posts with hashtags = instant spam signal → red flag
3. **Include a URL or hard CTA** — only soft ask allowed → red flag
4. **Claim a member count past `__FOUNDING_COUNT__`** → red flag (same rule as other formats)
5. **Sound like a press release** — "Today we shipped..." "Excited to announce..." → red flag (yellow if borderline, but caution on)

The verifier should APPROVE personal_fb posts that:

- Reference Heath's KW agent status (true and on-brand)
- Reference the verified founder pain stories (Italy, $400/file/4:30am, vacation stress)
- Tag @meetdossie naturally in the body
- End with a soft ask ("comment or DM me")
- Sound like a 30-second human post, not a polished marketing asset

---

## Acceptance criteria

1. `cron-generate-posts` produces 10 posts per day (currently 9) — the new `PERSONAL_FB` slot generates a personal-voice variant tied to the same batch topic
2. Personal_fb posts land in `social_posts` table with `status='draft'`, `platform='facebook_personal'`
3. Verifier reviews and either approves (→ `status='pending_manual_post'` after passing) or revises
4. Telegram button approval flow sends the post body to Heath; Heath taps "Post now" → PyAutoGUI runner posts to his personal FB → row updates to `status='posted'` with screenshot
5. Engagement data flows into `post_analytics` once Phase 2 analytics build is live (covered in `sage-spec-carter-post-analytics-feedback-loop.md`)
6. Weekly Sunday digest shows personal FB performance vs business page performance (apples-to-apples)

---

## Memory rules Carter MUST respect

- `feedback_pyautogui_not_playwright.md` — ALWAYS drive Heath's real Chrome window via PyAutoGUI. NEVER fresh Playwright. Bot detection bites.
- `feedback_no_fabricated_specifics.md` — every personal_fb post must reference only verified facts. No invented specifics ever.
- `feedback_sage_owns_social_posts.md` — Sage owns the copy + format. Carter ships the wiring. Don't tweak the voice rules.
- `feedback_fb_posts_one_at_a_time.md` — personal FB posts go through Telegram approval one at a time, never batched.
- `CLAUDE.md §15` — NEVER hardcode auth tokens or secrets. All env vars only.
- `CLAUDE.md §3` — staging → main workflow. Don't push to main without Heath's "merge it".

---

## File paths summary (what Carter creates/edits)

**New files:**
- `api/cron-publish-personal-fb.js` — the 30-min publisher with manual gate
- `scripts/atlas-fb-post-personal-pyautogui.py` — adapted from `atlas-fb-post-pyautogui.py`
- `scripts/run-personal-fb-post.js` — Telegram-button → Python helper
- `Media/personal-fb-queue/` — temp directory for post body files (gitignored)

**Edited files:**
- `api/cron-generate-posts.js` — add `PERSONAL_FB` format + new POST_PLAN_BASE slot + verifier rule
- `vercel.json` — add cron registration
- `.gitignore` — add `Media/personal-fb-queue/`

**Database:**
- Insert 5 weekday rows into `posting_schedule` for `facebook_personal`
- No new tables needed — `social_posts` already supports the new platform string

---

## What Carter should report back to Sage

When done, Carter pings Sage with:

1. Confirmation that staging push is live + Vercel deployment URL
2. Confirmation the new POST_PLAN slot is generating a `facebook_personal` row in the next cron run (run cron-generate-posts manually against staging to verify)
3. Screenshot of the Telegram approval message format
4. Test result of the PyAutoGUI runner against Heath's Chrome (1 dry-run post, then deleted, just to confirm the click path works)

Sage will then:
- Review the test post
- Hand the 5 approved drafts (in `Shepard-Ventures/Marketing/personal-fb-variants-2026-06-12.md`) over to Heath for tone approval
- Once Heath approves the voice + Carter ships the wiring, daily personal FB posting goes live Monday 2026-06-15

---

## Out of scope for this build

- LinkedIn personal profile cross-post (Heath has a personal LI but it's lower-leverage — defer to a separate spec)
- Instagram personal account cross-post (Heath's personal IG is not real-estate-focused)
- Auto-posting without manual gate — never. Personal FB always gets Heath's eyes on every post.
- Engagement analytics (covered in the separate post_analytics spec)
