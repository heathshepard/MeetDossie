# Mission Watchdog Audit — 2026-06-12

**Auditor:** Ridge
**Subject:** `api/cron-mission-watchdog.js` (SV-ENG-WATCHDOG-001, Atlas, 2026-06-11)
**Schedule:** hourly, 13:00–01:00 UTC (8 AM – 8 PM CDT) via Vercel + Windows Task Scheduler

---

## What the watchdog already does well

1. **Pace math is correct.** Compares actual posts (with `zernio_post_id NOT NULL` — real, not just queued) against schedule cap × passed-slots fraction. The `zernio_post_id` requirement is the right defense against the "Zernio returned 200 but didn't post" silent-fail class that ran for weeks before being caught.
2. **Route-around is decisive.** Behind-pace + next slot ≤2h away → fires `cron-sage-regenerate` then `cron-publish-approved`. No human-in-the-loop until things have actually been tried.
3. **End-of-day digest is rate-limited correctly.** Only fires at ≥20:00 CDT, once per day, so Heath gets ONE roll-up — no mid-day noise.
4. **LinkedIn rejection replacement.** If LinkedIn got a rejection today AND has nothing approved-and-due, flips the latest rejected post back through Sage regen. Max 3 attempts so we don't infinite-loop. This is exactly the right enforcement of the "failure is not an option" rule.
5. **TikTok swap intent is correct in shape** (no video by 4 PM CDT → defer to other lanes within existing caps; never violate posting_schedule.max_per_day).
6. **Auth is correct.** Accepts Vercel cron header OR Bearer ${CRON_SECRET}. Belt-and-suspenders Windows Task Scheduler covers Vercel outage.
7. **Telemetry shipped.** Uses `recordCronRun()` on success + error paths. Ridge can see if the watchdog itself is silent.

---

## Gaps Ridge identified

### Gap 1: Watchdog only covers the **social-publish** domain.

The current `PLATFORMS = ['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube']` walks only the social-posting funnel.

**What it does NOT cover:**
- **Customer-file health** — overdue action_items, near-deadline transactions, stuck DocuSeal submissions, unprovisioned Stripe subscriptions (the recurring webhook-gap bug).
- **Email watchdog** — when `cron-followup` / `cron-deadline-reminders` / `cron-email-digest` silently fail, no one notices until a customer complains.
- **Voice/audio pipeline** — when ElevenLabs is over-quota, Morning Brief silently degrades.
- **MCP server / external API health** — Smithery endpoint, MCP HTTP endpoint, Stripe webhook receiver.
- **Agent message bus** — `agent_messages` rows that get stuck `pending` past their TTL.

**Permanent fix:** Extend Watchdog into a **domain-based system** instead of platform-based:
- `domain: social-publishing` (current)
- `domain: customer-file` (overdue items, deadline alerts, esign-stuck)
- `domain: subscription-provisioning` (Stripe webhook reconciliation — the Terry/Jennifer/Lisa pattern)
- `domain: voice-and-render` (ElevenLabs quota, Submagic queue, Creatomate render queue)
- `domain: agent-bus` (stuck messages, dead-letter routing)

Each domain has its own pace function and route-around path. Today there's only one. Ridge proposes a `watchdog-registry` table where each domain registers its check + remedy callback.

---

### Gap 2: Route-around fires `cron-publish-approved` blindly when behind pace.

`fireCron('/api/cron-publish-approved')` happens even when the issue isn't a missing fire — it might be that Zernio is returning 4xx, or that the content_hash dedup is killing everything, or that posting_schedule.max_per_day is genuinely 0 for that platform today.

**What happens today:** The watchdog re-fires every hour. If the root cause is a structural break, we burn cycles re-firing a doomed cron.

**Permanent fix:** Add a `consecutive_failures` counter per (platform, date) tracked in a new `watchdog_state` table. After 3 consecutive route-arounds with no improvement, escalate (Telegram → Heath) and stop re-firing the same lane for that platform that day. Re-fire is healing; persistent re-fire without improvement is noise.

---

### Gap 3: TikTok swap is "log only, no action".

The code says:
```js
// For now we just log + mark intent. Heath approved silent substitution;
// we let cron-publish-approved naturally publish whatever the other lanes
// have.
```

That means TikTok behind pace + after 4 PM CDT + no video → **literally nothing happens** other than a log line. The "fallback lanes" comment is aspirational; cron-publish-approved doesn't actually know it should publish "extras" — it respects max_per_day strictly.

**What happens today:** TikTok ends the day at 0/1. Total daily ship drops by 1.

**Permanent fix:** Either:
- (a) Build the **video library fallback** — when TikTok has no fresh video by 4 PM, walk `video_library` for a Hormozi-style evergreen tutorial bite and queue it. Per mem `feedback_mission_completion_mandatory.md` this is the spec'd behavior.
- (b) Bump that day's IG or Twitter cap by 1 explicitly when TikTok defers. This requires a controlled `posting_schedule.bonus_caps[date][platform] = +1` slot.

Ridge recommends (a) — pulls from existing inventory, no cap-bump policy needed.

---

### Gap 4: No watchdog-of-the-watchdog.

If Vercel's cron lane for `/api/cron-mission-watchdog` itself stops firing, the Windows Task Scheduler backup is the only safety net. If Heath's desktop is asleep/off, both fail silently.

**Permanent fix:** Add an `alert-health`-style external probe — Ridge's new `/api/ventures/reliability` dashboard already does this (looks at last_run on cron_runs). A new low-frequency cron (`cron-watchdog-of-watchdog`, every 90 min) should hit `cron_runs.last_run` for `cron-mission-watchdog` itself; if >90 min stale during business hours, page Heath. (Belt + suspenders + a second pair of suspenders.)

---

### Gap 5: Watchdog routes around content failures but never **explains the root cause**.

End-of-day digest shows actuals vs expected, but never says **why**. Heath gets "TT 0/1" with no context. Was Zernio rate-limited? Did Sage reject everything? Was there no video?

**Permanent fix:** Emit `root_cause` per under-pace platform in the digest. Compute it inside the watchdog by querying the recent failure modes:
- recent posts with `status='failed'` → "Zernio errors"
- recent rejections from `sage_inbox` → "Sage rejecting content"
- no approved-and-due rows → "content pipeline empty"
- tiktok with no `media_url` → "no video attached"

The watchdog already has all this data — it just doesn't surface it in the digest.

---

### Gap 6: No retroactive heal for missed slots.

If `cron-publish-approved` is silent from 9 AM to 10 AM (one slot missed entirely), the watchdog catches up at the 10 AM fire. Good. But if **all** of 9, 10, and 11 AM slots get missed (full Vercel outage), the watchdog publishes a maximum of 1 post per fire — the `posting_schedule.max_per_slot` rate-limits the publisher. We end the day short by 2 because we lost the time-shift opportunity.

**Permanent fix:** Add a `make-up-mode` flag the watchdog sets on `posting_schedule` for the rest of today when behind by ≥2 slots and recovery window allows. The publisher reads this flag and temporarily bumps `max_per_slot` to clear the backlog within today's `max_per_day` cap. Cap is never violated; only the per-slot rate-limit gets relaxed.

---

### Gap 7: Daily digest doesn't quote the run id of the watchdog telemetry row.

If Heath asks "what did the watchdog do at 3 PM?" — there's no link. Ridge can find it via `cron_runs.last_meta`, but Heath can't.

**Permanent fix:** Add a `/ventures/reliability/cron-mission-watchdog` deep-link in the digest that pre-filters Ridge's new reliability dashboard to that row.

---

## Recommended next-level enforcement gates (Ridge's ship-list)

In priority order, smallest-impact-largest-reward first:

1. **Root-cause annotation in end-of-day digest** (Gap 5). Pure data-surfacing, no behavior change. Ridge or Carter, ~1h.

2. **Watchdog-of-watchdog `cron_runs` heartbeat check** (Gap 4). Ridge's new `/api/ventures/reliability` already exposes the data; add a separate hourly cron that just pages Heath if mission-watchdog last_run is >90 min stale during business hours. Ridge, ~1h.

3. **TikTok video-library fallback** (Gap 3). Pulls evergreen reels from `video_library` when no fresh video by 4 PM CDT. Hits the existing "failure is not an option" memory rule directly. Sage + Carter, ~3h.

4. **`watchdog_state` consecutive_failures table + escalation** (Gap 2). Stops the "keep re-firing forever" pattern. Ridge owns table + counter logic; reuses existing route-around code. ~2h.

5. **Domain expansion** (Gap 1). The largest scope item — break Watchdog into pluggable domains. Ship social-publishing as domain 1 (no behavior change), then add customer-file as domain 2 (catches overdue action_items the way social-publishing catches behind-pace platforms). Ridge architects + spawns Carter to refactor. ~6h.

6. **Make-up mode + per-slot rate-limit override** (Gap 6). Lower priority — only matters during multi-slot outages. ~3h.

---

## Things I am NOT proposing to change

- The current pace math (correct).
- The `zernio_post_id NOT NULL` verification (load-bearing — keep).
- The Windows Task Scheduler backup (keep — proven redundancy).
- The end-of-day-only Telegram summary (matches `feedback_summary_only_no_play_by_play.md`).
- The Bearer-OR-Vercel-cron auth pattern (correct).
- LinkedIn rejection replacement (already working — leave alone).

---

## Ridge sign-off

Watchdog v1 (Atlas, 2026-06-11) is a solid foundation — it caught the right class of failures Heath has been bleeding from for weeks. The gaps above are evolution, not rebuild. Recommendation: ship Gap 5 + Gap 4 + Gap 2 fixes this week (~4h total), then plan Gap 1 (domain expansion) for week 2 of Ridge scope.

— Ridge
2026-06-12 ~3 PM CDT
