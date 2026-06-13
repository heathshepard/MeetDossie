# Sage → Carter spec: heal `social_posts.status=pending_video` orphans

**Filed:** 2026-06-12 by Sage
**Priority:** P0 — this bug caused 22 TikTok posts to go dark for 5 weeks. Permanent fix required this week.
**Wall-log entry:** Bug 9
**Coordinated with:** Atlas (reels-first content mix flip, in parallel)

---

## The problem in one sentence

`cron-publish-approved` parks TikTok posts as `status='pending_video'` waiting for a video that never comes, because no cron consumes that status and the DONE handler writes to a different table (`video_library`, not `social_posts`).

## What Sage already did (do not redo)

- Resurrected the 7 most recent stuck posts (2026-06-04 → 2026-06-11): attached best-match tutorial video URL from `tutorial_videos` by topic→pillar mapping, flipped to `status='approved'`, set `source_type='tutorial_repurpose_resurrection'`, cleared `video_required`. They will ship via the normal `cron-publish-approved` Zernio flow.
- Marked the 15 stale rows (>14 days) as `status='failed'` with explanatory `error_message`.

## What Carter owns

### Task 1 — Inline tutorial attach in `cron-publish-approved` (PREVENT future orphans)

**File:** `api/cron-publish-approved.js` lines 708-734

**Current behavior:**
```javascript
if (post.platform === 'tiktok' && !post.media_url) {
  // park as pending_video, send Telegram, hope for DONE
}
```

**New behavior:** Before parking, try to attach a tutorial video. Only park as `pending_video` if no library match exists.

**Pseudocode:**
```javascript
if (post.platform === 'tiktok' && !post.media_url) {
  const libraryUrl = await findTutorialVideoForTopic(post.topic, post.platform);
  if (libraryUrl) {
    await supabaseFetch(`/rest/v1/social_posts?id=eq.${post.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        media_url: libraryUrl,
        video_required: false,
        source_type: 'tutorial_repurpose_auto',
        error_message: null,
      }),
    });
    // re-fetch post and continue to publish flow — do NOT park
  } else {
    // existing pending_video park logic
  }
}
```

The same pattern applies to Instagram if `video_required=true` and `media_url IS NULL` — extend the check to both platforms.

### Task 2 — Hourly heal cron `cron-heal-pending-video`

**Path:** `api/cron-heal-pending-video.js` (new)
**Schedule:** Add to `vercel.json`: `"schedule": "15 * * * *"` (every hour at :15 to avoid colliding with other crons)
**Auth:** Standard `CRON_SECRET` or `x-vercel-cron` header

**Logic:**
1. Query: `social_posts WHERE status='pending_video' AND media_url IS NULL AND created_at > NOW() - INTERVAL '48 hours'`
2. For each row:
   - Look up best-match tutorial video from `tutorial_videos WHERE status='published' AND video_url IS NOT NULL AND <platform>-distribution match`
   - Topic→tutorial mapping (use the same mapping Sage used in the resurrection sweep — see below)
   - If match found: PATCH row with `media_url=<tutorial.video_url>`, `status='approved'`, `video_required=false`, `source_type='tutorial_repurpose_auto_heal'`, clear `error_message`
   - If no match found AND `created_at < NOW() - INTERVAL '24 hours'`: PATCH `status='failed'`, `error_message='no tutorial library match within 24h'`
3. Return a summary `{ healed: [...], failed: [...] }` and send a single Telegram digest if `healed.length > 0`

### Topic → tutorial slug mapping (Sage's table — extend as more tutorials publish)

| social_posts.topic | tutorial_videos.slug |
|---|---|
| `pain_points` | `control-never-miss-a-deadline-again` |
| `cost_math` | `cost-comparison-400-per-file-vs-29-per-month` |
| `feature_reveal` | `take-the-60-second-tour` |
| `day_in_the_life` | `speed-dossie-handles-followups-while-youre-at-a-showing` |
| `control_freak_agent` | `visibility-see-every-deal-at-a-glance` |
| `community_movement` | `take-the-60-second-tour` |
| `build_in_public` | `read-your-morning-brief` |
| `capability_oneliners` | `use-talk-to-dossie-voice` |
| `morning_brief` | `read-your-morning-brief` |
| `trec_deadlines` | `control-never-miss-a-deadline-again` |
| `*` (default) | `take-the-60-second-tour` |

Store this mapping in `api/_lib/topic-tutorial-mapping.js` so Task 1 and Task 2 share it. Atlas's content-mix flip should also consume this mapping.

### Task 3 — Telemetry into `cron_runs` (collateral, Bug 4)

Both the new heal cron AND the existing `cron-publish-approved` should insert/upsert a `cron_runs` row on every invocation (cron_name, last_run, last_status, summary jsonb). We currently have zero centralized cron telemetry, which is what made this bug invisible for 5 weeks.

## Acceptance criteria

1. `social_posts.status='pending_video'` count stays at zero after deploy (or trends to zero within 24h).
2. New tutorial videos publishing into `tutorial_videos` are automatically eligible to fill stuck posts on next heal run.
3. If the tutorial library is truly empty for a topic, the row dies in 24h with a clear `error_message`, not silently 5 weeks later.
4. Heath can see heal events in a daily digest (or rolled into `cron-morning-ops-digest`).

## Coordination

- **Atlas** is flipping the content mix to reels-first in parallel. His changes will set `media_url` at generation time for IG and TikTok using the same tutorial library. Once Atlas's flip is live, Task 1 becomes a defense-in-depth measure (most posts won't need it because they'll already have media). Coordinate the mapping file so both consume it.
- **Sage** owns the topic→tutorial mapping table going forward. Add new mappings here as new tutorials publish.

## Test plan

1. Insert a synthetic `social_posts` row with `platform='tiktok'`, `topic='pain_points'`, `status='pending_video'`, `media_url=NULL`, `created_at=NOW()-INTERVAL '3 hours'`.
2. Manually trigger `cron-heal-pending-video` with `Bearer $CRON_SECRET`.
3. Confirm the row now has `media_url` populated with the control-never-miss-a-deadline tutorial URL and `status='approved'`.
4. Trigger `cron-publish-approved` and confirm Zernio gets the post.
5. Delete the synthetic row.
