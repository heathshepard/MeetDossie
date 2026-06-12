# Sage spec for Carter — FB scanner permalink extraction (Bug 6, 2026-06-12)

**Owner:** Sage (Social) | **Implementer:** Carter | **Branch:** staging
**Date:** 2026-06-12 | **Severity:** CRITICAL — entire FB engagement-comment flow has never worked

---

## Root cause

`scripts/sage-fb-comment-scanner.js` lines 263-273. When a post chunk doesn't yield a regex match for `/groups/<slug>/(permalink|posts)/<digits>` or `story.php?...`, the scanner synthesizes `post_url = groupURL + '#post-' + hash`. The hash is a dedup key only — FB does NOT render the specific post at that URL fragment.

Evidence: 50 of 52 FB engagement_candidates rows have synthetic URLs. ZERO have real permalinks.

Consequence: 2 candidates approved by Sage (id=29 from 2026-06-11 21:34 UTC, id=44 from 2026-06-12 10:02 UTC) cannot be posted — `scripts/sage-engagement-poster.js` (built 2026-06-12) navigates fine but lands on the GROUP FEED instead of the target post, risking the comment being typed into the group composer (= new post, wrong context).

The FB scanner has been running hourly for days. Every candidate it produced is unshippable.

---

## Required changes — `scripts/sage-fb-comment-scanner.js`

### Phase 1 — capture real permalink during scrape

m.facebook.com renders each story-card in the group feed with at minimum:
- a timestamp `<abbr>` element wrapped in `<a href="/groups/.../permalink/...">`
- or a "View full post" link with the same canonical URL
- the `data-ft` attribute often contains `top_level_post_id`, `story_fbid`, `tl_objid` which can build `https://m.facebook.com/groups/{group_id}/permalink/{story_fbid}/`

Update the scanner extraction loop:

1. Replace pure text-chunk grep with per-story DOM iteration. Each story-card on m.facebook.com is typically rendered inside `<article>` or `<div role="article">`.
2. For each card:
   - Read inner text → score via existing PAIN_KEYWORDS / TEXAS_SIGNALS / HOT_PHRASES heuristics
   - If score >= MIN_SCORE, extract the canonical permalink via:
     - Try `card.querySelector('a[href*="/permalink/"], a[href*="/posts/"], a[href^="/story.php?"]').href`
     - If none, try the `data-ft` JSON: parse and synthesize `https://m.facebook.com/groups/{group_id}/permalink/{top_level_post_id}/`
     - If both fail, SKIP (do not write a synthetic URL). The point is to never produce unshippable rows.
3. Write `post_url` = the canonical permalink. Drop the `#post-<hash>` fallback entirely.

### Phase 2 — backfill the 50 stranded synthetic-URL candidates

Add a one-shot cleanup script `scripts/sage-fb-candidate-backfill.js`:

1. Pull all engagement_candidates where post_url LIKE '%#post-%' AND status IN ('pending', 'approved', 'sent_for_approval')
2. For each, navigate to the parent group URL
3. Scroll and search for a story-card whose text matches the candidate's stored `post_text` (use first 80 chars as fingerprint)
4. If found, extract canonical permalink, UPDATE engagement_candidates SET post_url = <real URL>
5. If not found within N scrolls, mark status='expired' (post fell off the feed)

### Phase 3 — validate the engagement poster

After Phase 1+2 land, re-run `scripts/sage-engagement-poster.js --id 44 --dry-run` and confirm:
- Browser navigates to the SPECIFIC POST (not group feed)
- Comment composer locator targets the post's own comment box, not the group's "Write something" composer
- DRY-RUN log shows "found post-specific comment box" not "found generic textbox"

If the poster's selector logic doesn't differentiate per-post vs group composer, add that check too — landing on the wrong composer creates a new post instead of a comment, which is the failure mode Sage is preventing today.

---

## Acceptance criteria

1. New FB engagement_candidates from sage-fb-comment-scanner.js have post_url matching `^https://m\.facebook\.com/groups/.*/(permalink|posts|story\.php)/`
2. Zero new rows have synthetic `#post-` URLs
3. Backfill script successfully resolves >=20 of the 50 stranded candidates (the rest may have aged out)
4. sage-engagement-poster.js dry-run on a backfilled candidate confirms it lands on the right comment composer
5. One live ship: post id=44 (oldest approved) via sage-engagement-poster.js (no --dry-run) and verify the comment appears on the target post on m.facebook.com

## Effort estimate

- Phase 1 (scanner): ~2 hours (Carter — DOM extraction + permalink builder)
- Phase 2 (backfill): ~1 hour (Carter — one-shot script + scroll loop)
- Phase 3 (validation): ~30 min (Sage live verification)

## Memory rules Carter should respect

- Read CLAUDE.md Section 3 (deploy workflow: staging → main, never push direct to main)
- Read `Engineering/wall-log.md` Bug 6 for full context
- Use `~/AppData/Local/DossieBot-Sage` user-data-dir + `Default` profile-directory (the new standard for ALL FB automation per the 2026-06-12 reddit-fetch-new migration)
- Follow the `_lib/chrome-profile-unlock.js` pre-flight pattern from fb-group-poster.js
