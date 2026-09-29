#!/usr/bin/env node
'use strict';

/**
 * Regression test for the Facebook goal-pacing system (Carter, 2026-09-16):
 *   - api/_lib/social-goals.js (config)
 *   - api/_lib/social-goals-progress.js (pacing math + real counts)
 *   - api/cron-weekly-content-scheduler.js's planExtraFacebookSlots()
 *   - api/cron-generate-posts.js's parseExtraFacebookPosts()/getPostPlan()
 *     extra-slot support
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. PACING MATH — on-pace, a period we're FAR behind on (the real
 *      screenshot scenario: 10/23 posts, 0/5 replies, 0/7 group,
 *      0/23 photos, mid-week), and a period that already ended.
 *   2. MEDIA-OVERLAP — combinedPublicPostNeed() takes the MAX of the two
 *      remainders, never the SUM, so a media-carrying post is never
 *      double-counted against both quotas.
 *   3. CAP COLLISION — group_posts reachability against its real daily cap;
 *      an unreachable target is flagged, not silently under-delivered.
 *   4. REAL COUNTS — countPublicPosts/countGroupPosts/countCommentReplies
 *      against a mock PostgREST server, including the pipeline=null OR
 *      pipeline='daily5' brand-scoping for group posts.
 *   5. planExtraFacebookSlots() spreads the same bounded extra count across
 *      every empty day and respects the configured per-day ceiling.
 *   6. cron-generate-posts.js's extra_facebook_posts param is bounds-checked
 *      and additive-only (absent = zero behavior change; getPostPlan()
 *      never mutates its own base plan).
 *   7. Drift guard: ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY (the scheduler's
 *      belief about cron-generate-posts.js's fixed facebook slot count)
 *      matches the REAL POST_PLAN_BASE facebook count.
 *   8. PERIOD ROLLOVER — currentWeekPeriod() computes Sun-Sat fresh from
 *      `now` (2026-09-16 live-audit correction: was hardcoded Mon-Sun and
 *      would have gone stale forever), including an explicit rollover from
 *      one week into the next.
 *   9. 5TH TARGET (reels) — the target the first pass at this config missed
 *      entirely. manualTargetProgress() only trusts a manual snapshot when
 *      its as_of date actually falls inside the period being graded, so a
 *      "2/2 done" from last week doesn't silently carry into this week.
 *  10. isConfigStale() flags target numbers nobody has re-confirmed in over
 *      a cycle, independent of the (now self-rolling) period.
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access.
 *
 * Run manually:
 *   node scripts/regression-social-goals-pacing.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lte.')) return row[key] != null && String(row[key]) <= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  return true;
}

function startMockSupabase(seed) {
  const db = {
    social_posts: (seed.social_posts || []).map((r) => ({ ...r })),
    group_posts: (seed.group_posts || []).map((r) => ({ ...r })),
    social_comment_replies: (seed.social_comment_replies || []).map((r) => ({ ...r })),
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const rows = db[table];
      if (!rows) { res.writeHead(404); res.end('[]'); return; }

      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
      const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try {
      fn();
      console.log(`  PASS: ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL: ${name}\n    ${err.message}`);
      fail++;
    }
  }
  async function checkAsync(name, fn) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL: ${name}\n    ${err.message}`);
      fail++;
    }
  }

  const progressLib = require(path.join(REPO, 'api/_lib/social-goals-progress.js'));
  const { computePacing, combinedPublicPostNeed } = progressLib;

  console.log('\n1. PACING MATH');

  check('on-pace: current matches expected-by-now, status=on_pace', () => {
    // 7-day period, 4 days elapsed (now = day 4 of 7), target 21, on pace = 12/21.
    const start = new Date('2026-09-14T00:00:00.000Z');
    const end = new Date('2026-09-20T23:59:59.999Z');
    const now = new Date('2026-09-18T00:00:00.000Z'); // 4 days elapsed
    const p = computePacing({ target: 21, current: 12, start, end, now });
    assert.strictEqual(p.paceStatus, 'on_pace');
    assert.strictEqual(p.remaining, 9);
  });

  check('mid-week (Wed) snapshot: 10/23 by day 2.5 of 7 is mathematically ON PACE', () => {
    // The real screenshot's own numbers, at the screenshot's own timestamp.
    // Worth pinning down explicitly: "80% remaining" (FB's plain
    // fraction-of-target framing) is NOT the same statement as "behind
    // linear pace" — 10 posts in the first 2.5 days projects to ~28 over
    // the full 7, comfortably clearing 23. The FAR BEHIND case below uses a
    // later "now" with the same low count to exercise real lagging pace.
    const start = new Date('2026-09-14T00:00:00.000Z'); // Monday
    const end = new Date('2026-09-20T23:59:59.999Z');   // Sunday
    const now = new Date('2026-09-16T12:00:00.000Z');   // Wednesday midday — day 2.5 of 7
    const p = computePacing({ target: 23, current: 10, start, end, now });
    assert.strictEqual(p.daysTotal, 7);
    assert.strictEqual(p.remaining, 13);
    assert.strictEqual(p.paceStatus, 'on_pace');
  });

  check('FAR BEHIND scenario — same 10/23, but now Saturday (day 5.5 of 7)', () => {
    const start = new Date('2026-09-14T00:00:00.000Z'); // Monday
    const end = new Date('2026-09-20T23:59:59.999Z');   // Sunday
    const now = new Date('2026-09-19T12:00:00.000Z');   // Saturday midday
    const p = computePacing({ target: 23, current: 10, start, end, now });
    assert.strictEqual(p.daysTotal, 7);
    assert.strictEqual(p.daysLeft, 2, `expected 2 days left, got ${p.daysLeft}`);
    assert.strictEqual(p.remaining, 13);
    assert.strictEqual(p.paceStatus, 'behind', `expected behind, got ${p.paceStatus} (expectedByNow=${p.expectedByNow})`);
    assert.ok(p.perDayNeeded > 2, `perDayNeeded should be well above the organic 2/day baseline, got ${p.perDayNeeded}`);
  });

  check('period ended, target missed', () => {
    const start = new Date('2026-09-07T00:00:00.000Z');
    const end = new Date('2026-09-13T23:59:59.999Z');
    const now = new Date('2026-09-16T00:00:00.000Z'); // after period end
    const p = computePacing({ target: 23, current: 10, start, end, now });
    assert.strictEqual(p.periodEnded, true);
    assert.strictEqual(p.daysLeft, 0);
    assert.strictEqual(p.paceStatus, 'period_ended_missed');
  });

  check('period ended, target met', () => {
    const start = new Date('2026-09-07T00:00:00.000Z');
    const end = new Date('2026-09-13T23:59:59.999Z');
    const now = new Date('2026-09-16T00:00:00.000Z');
    const p = computePacing({ target: 23, current: 25, start, end, now });
    assert.strictEqual(p.paceStatus, 'period_ended_met');
  });

  console.log('\n2. CAP COLLISION — group_posts reachability');

  check('unreachable: remaining exceeds cap * daysLeft', () => {
    // 7 target, 0 current, cap 5/day, 1 day left -> max producible = 5 < 7 -> unreachable.
    const start = new Date('2026-09-14T00:00:00.000Z');
    const end = new Date('2026-09-20T23:59:59.999Z');
    const now = new Date('2026-09-20T00:00:00.000Z'); // last day of period
    const p = computePacing({ target: 7, current: 0, start, end, now, dailyCap: 5 });
    assert.strictEqual(p.reachable, false);
    assert.strictEqual(p.paceStatus, 'unreachable');
  });

  check('reachable: cap * daysLeft comfortably covers remaining', () => {
    const start = new Date('2026-09-14T00:00:00.000Z');
    const end = new Date('2026-09-20T23:59:59.999Z');
    const now = new Date('2026-09-16T00:00:00.000Z'); // 4-5 days left
    const p = computePacing({ target: 7, current: 0, start, end, now, dailyCap: 5 });
    assert.strictEqual(p.reachable, true);
  });

  console.log('\n3. MEDIA-OVERLAP — combinedPublicPostNeed never double-counts');

  check('combined need is MAX of the two remainders, never the sum', () => {
    const postsPacing = { remaining: 13 };
    const photosPacing = { remaining: 23 };
    const combined = combinedPublicPostNeed(postsPacing, photosPacing);
    assert.strictEqual(combined.totalRemaining, 23, 'must be max(13,23)=23, not 13+23=36');
    assert.strictEqual(combined.mustCarryMedia, 23);
    assert.strictEqual(combined.plainOk, 0);
  });

  check('when posts need exceeds photos need, the excess is plain-post-ok', () => {
    const postsPacing = { remaining: 20 };
    const photosPacing = { remaining: 5 };
    const combined = combinedPublicPostNeed(postsPacing, photosPacing);
    assert.strictEqual(combined.totalRemaining, 20);
    assert.strictEqual(combined.mustCarryMedia, 5);
    assert.strictEqual(combined.plainOk, 15);
  });

  console.log('\n4. REAL COUNTS against a mock PostgREST server');

  await (async () => {
    const seed = {
      social_posts: [
        { id: 'p1', platform: 'facebook', target_owner: 'dossie', status: 'posted', posted_at: '2026-09-15T12:00:00.000Z', media_url: null },
        { id: 'p2', platform: 'facebook', target_owner: 'dossie', status: 'posted', posted_at: '2026-09-16T12:00:00.000Z', media_url: 'https://x/video.mp4' },
        { id: 'p3', platform: 'facebook', target_owner: 'dossie', status: 'draft', posted_at: null, media_url: null }, // not posted — must not count
        { id: 'p4', platform: 'instagram', target_owner: 'dossie', status: 'posted', posted_at: '2026-09-15T12:00:00.000Z', media_url: 'https://x/a.png' }, // wrong platform — must not count
        { id: 'p5', platform: 'facebook', target_owner: 'dossie', status: 'posted', posted_at: '2026-08-01T12:00:00.000Z', media_url: null }, // outside period — must not count
      ],
      group_posts: [
        { id: 'g1', pipeline: 'daily5', status: 'posted', posted_at: '2026-09-15T12:00:00.000Z' },
        { id: 'g2', pipeline: null, status: 'posted', posted_at: '2026-09-16T12:00:00.000Z' }, // legacy Founding Files direct — must count
        { id: 'g3', pipeline: 'listing-groups', status: 'posted', posted_at: '2026-09-15T12:00:00.000Z' }, // different brand — must NOT count
      ],
      social_comment_replies: [
        { id: 'c1', platform: 'facebook', reply_status: 'posted', created_at: '2026-09-15T12:00:00.000Z' },
        { id: 'c2', platform: 'facebook', reply_status: 'draft', created_at: '2026-09-15T12:00:00.000Z' }, // not posted — must not count
      ],
    };
    const mock = await startMockSupabase(seed);
    process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    delete require.cache[require.resolve(path.join(REPO, 'api/_lib/social-goals-progress.js'))];
    delete require.cache[require.resolve(path.join(REPO, 'api/_lib/social-goals.js'))];
    const lib = require(path.join(REPO, 'api/_lib/social-goals-progress.js'));

    const start = new Date('2026-09-14T00:00:00.000Z');
    const end = new Date('2026-09-20T23:59:59.999Z');

    await checkAsync('countPublicPosts: 2 facebook/dossie posted in period, 1 with media', async () => {
      const c = await lib.countPublicPosts({ platform: 'facebook', target_owner: 'dossie', start, end });
      assert.strictEqual(c.total, 2, `expected 2 total, got ${c.total}`);
      assert.strictEqual(c.withMedia, 1, `expected 1 with media, got ${c.withMedia}`);
    });

    await checkAsync('countGroupPosts: daily5 + null pipeline count, listing-groups excluded', async () => {
      const c = await lib.countGroupPosts({ pipelines: ['daily5', null], start, end });
      assert.strictEqual(c, 2, `expected 2 (g1+g2, not g3), got ${c}`);
    });

    await checkAsync('countCommentReplies: only reply_status=posted counts', async () => {
      const c = await lib.countCommentReplies({ platform: 'facebook', start, end });
      assert.strictEqual(c, 1, `expected 1, got ${c}`);
    });

    await checkAsync('computeGoalProgress end-to-end: dossie_fb_page, far-behind + unreachable group flag', async () => {
      // Freeze "now" at the real screenshot's Wednesday, 2026-09-16 —
      // social-goals.js computes the Sun-Sat period fresh from this `now`
      // (Sep 13-19), so the seeded posted_at values (Sep 15-16) land inside
      // it without needing any hardcoded period in the config itself.
      const progress = await lib.computeGoalProgress('dossie_fb_page', { now: new Date('2026-09-16T18:00:00.000Z') });
      assert.ok(progress, 'progress should compute');
      assert.strictEqual(progress.targets.public_posts.current, 2);
      assert.strictEqual(progress.targets.public_posts_with_photos.current, 1);
      assert.strictEqual(progress.targets.group_posts.current, 2);
      assert.strictEqual(progress.targets.comment_replies.current, 1);
      // note is present on every target explaining these are OUR counts.
      assert.ok(progress.note.includes('OWN posted records'));
      // combined need never double counts.
      const combined = progress.combined_public_post_need;
      assert.strictEqual(combined.totalRemaining, Math.max(progress.targets.public_posts.remaining, progress.targets.public_posts_with_photos.remaining));
      // 5th target: reels. manual_progress.as_of=2026-09-16 falls inside
      // the Sep13-19 period computed for this `now`, so it counts as 2/2.
      assert.strictEqual(progress.period.start, '2026-09-13', `expected corrected Sun-Sat period, got start=${progress.period.start}`);
      assert.strictEqual(progress.period.end, '2026-09-19');
      assert.ok(progress.targets.reels, 'reels target must be present (5th target, was missing)');
      assert.strictEqual(progress.targets.reels.target, 2);
      assert.strictEqual(progress.targets.reels.current, 2);
      assert.strictEqual(progress.targets.reels.paceStatus, 'met');
      // targets_last_verified is 2026-09-16, `now` is the same day -> not stale.
      assert.strictEqual(progress.config_stale, false);
    });

    mock.server.close();
  })();

  console.log('\n4b. PERIOD ROLLOVER — currentWeekPeriod() (2026-09-16 live-audit correction)');

  {
    delete require.cache[require.resolve(path.join(REPO, 'api/_lib/social-goals.js'))];
    const sg = require(path.join(REPO, 'api/_lib/social-goals.js'));

    check('mid-week Wednesday resolves to the real Sep13-19 Sun-Sat period, not Mon-Sun', () => {
      const p = sg.currentWeekPeriod(0, new Date('2026-09-16T18:00:00.000Z'));
      assert.strictEqual(p.start, '2026-09-13');
      assert.strictEqual(p.end, '2026-09-19');
    });

    check('Sunday itself (the anchor day) resolves to the period it starts, not the prior week', () => {
      const p = sg.currentWeekPeriod(0, new Date('2026-09-13T00:00:01.000Z'));
      assert.strictEqual(p.start, '2026-09-13');
      assert.strictEqual(p.end, '2026-09-19');
    });

    check('Saturday (last day) still resolves inside the same period', () => {
      const p = sg.currentWeekPeriod(0, new Date('2026-09-19T23:00:00.000Z'));
      assert.strictEqual(p.start, '2026-09-13');
      assert.strictEqual(p.end, '2026-09-19');
    });

    check('ROLLOVER: the very next day (the new Sunday) rolls to the next 7-day period', () => {
      const p = sg.currentWeekPeriod(0, new Date('2026-09-20T00:00:01.000Z'));
      assert.strictEqual(p.start, '2026-09-20', 'must roll forward, not stay pinned on the prior week');
      assert.strictEqual(p.end, '2026-09-26');
    });

    check('getGoalSet() no longer stores a static period — it is computed per call from `now`', () => {
      const a = sg.getGoalSet('dossie_fb_page', new Date('2026-09-16T00:00:00.000Z'));
      const b = sg.getGoalSet('dossie_fb_page', new Date('2026-09-21T00:00:00.000Z'));
      assert.notDeepStrictEqual(a.period, b.period, 'two different `now`s a week apart must produce two different periods');
      assert.strictEqual(sg.SOCIAL_GOALS.dossie_fb_page.period, undefined, 'raw config object must not carry a hardcoded period field');
    });

    check('isConfigStale: false the day targets were verified, true well past one cycle', () => {
      const goalSet = sg.getGoalSet('dossie_fb_page', new Date('2026-09-16T00:00:00.000Z'));
      assert.strictEqual(sg.isConfigStale(goalSet, new Date('2026-09-16T12:00:00.000Z')), false);
      assert.strictEqual(sg.isConfigStale(goalSet, new Date('2026-09-30T00:00:00.000Z')), true, 'targets_last_verified 2026-09-16 is 2+ weeks stale by 2026-09-30');
    });
  }

  console.log('\n4c. manualTargetProgress() — the reels (5th target) manual snapshot');

  {
    const progressLib2 = require(path.join(REPO, 'api/_lib/social-goals-progress.js'));

    check('manual snapshot inside the current period counts as-is', () => {
      const r = progressLib2.manualTargetProgress(
        { manual_progress: { current: 2, as_of: '2026-09-16' } },
        { start: '2026-09-13', end: '2026-09-19' },
      );
      assert.strictEqual(r.current, 2);
      assert.strictEqual(r.stale, false);
    });

    check('ROLLOVER: a manual snapshot from LAST week does not silently carry into the new period', () => {
      const r = progressLib2.manualTargetProgress(
        { manual_progress: { current: 2, as_of: '2026-09-16' } },
        { start: '2026-09-20', end: '2026-09-26' }, // next week's period
      );
      assert.strictEqual(r.current, 0, 'stale snapshot must not be reported as this week\'s progress');
      assert.strictEqual(r.stale, true);
      assert.ok(r.reason.includes('outside the current period'));
    });

    check('missing manual_progress reports stale with current=0, never throws', () => {
      const r = progressLib2.manualTargetProgress({}, { start: '2026-09-13', end: '2026-09-19' });
      assert.strictEqual(r.current, 0);
      assert.strictEqual(r.stale, true);
    });
  }

  console.log('\n5. planExtraFacebookSlots — spread + ceiling');

  {
    delete require.cache[require.resolve(path.join(REPO, 'api/cron-weekly-content-scheduler.js'))];
    // cron-weekly-content-scheduler.js installs telegram-gate + reads env at
    // require time but makes no network calls until its exported functions
    // are invoked — safe to require directly for its pure helper.
    const scheduler = require(path.join(REPO, 'api/cron-weekly-content-scheduler.js'));

    check('spreads the same extra count evenly across every empty day, capped by ceiling', () => {
      const progress = {
        targets: { public_posts: { paceStatus: 'behind', perDayNeeded: 5.5 } }, // needs ceil(5.5)=6/day, minus organic 2 = 4 extra needed
        scheduler: { max_extra_public_posts_per_day: 2 }, // ceiling below the raw need
      };
      const { perDay, plan } = scheduler.planExtraFacebookSlots({ emptyDates: ['2026-09-17', '2026-09-18', '2026-09-19'], progress });
      assert.strictEqual(perDay, 2, 'capped at the configured ceiling, not the raw 4/day need');
      assert.deepStrictEqual(plan, { '2026-09-17': 2, '2026-09-18': 2, '2026-09-19': 2 });
    });

    check('met/period-ended targets never get extra slots', () => {
      const progress = {
        targets: { public_posts: { paceStatus: 'met', perDayNeeded: 0 } },
        scheduler: { max_extra_public_posts_per_day: 2 },
      };
      const { perDay, plan } = scheduler.planExtraFacebookSlots({ emptyDates: ['2026-09-17'], progress });
      assert.strictEqual(perDay, 0);
      assert.deepStrictEqual(plan, {});
    });

    check('zero ceiling configured -> never requests extras regardless of need', () => {
      const progress = {
        targets: { public_posts: { paceStatus: 'behind', perDayNeeded: 20 } },
        scheduler: { max_extra_public_posts_per_day: 0 },
      };
      const { perDay } = scheduler.planExtraFacebookSlots({ emptyDates: ['2026-09-17'], progress });
      assert.strictEqual(perDay, 0);
    });

    check('drift guard: ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY matches the real generator plan', () => {
      delete require.cache[require.resolve(path.join(REPO, 'api/cron-generate-posts.js'))];
      const generator = require(path.join(REPO, 'api/cron-generate-posts.js'));
      const basePlan = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), {});
      const fbCount = basePlan.filter((s) => s.platform === 'facebook').length;
      assert.strictEqual(
        fbCount,
        scheduler.ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY,
        `cron-generate-posts.js now generates ${fbCount} facebook slot(s)/day but cron-weekly-content-scheduler.js still assumes ${scheduler.ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY} — update ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY`,
      );
    });
  }

  console.log('\n6. cron-generate-posts.js extra_facebook_posts param');

  {
    delete require.cache[require.resolve(path.join(REPO, 'api/cron-generate-posts.js'))];
    const generator = require(path.join(REPO, 'api/cron-generate-posts.js'));

    check('parseExtraFacebookPosts: absent -> 0 (zero behavior change)', () => {
      assert.strictEqual(generator.parseExtraFacebookPosts({ query: {} }), 0);
    });
    check('parseExtraFacebookPosts: negative/garbage -> 0', () => {
      assert.strictEqual(generator.parseExtraFacebookPosts({ query: { extra_facebook_posts: '-3' } }), 0);
      assert.strictEqual(generator.parseExtraFacebookPosts({ query: { extra_facebook_posts: 'abc' } }), 0);
    });
    check('parseExtraFacebookPosts: clamped at the hard safety ceiling', () => {
      assert.strictEqual(generator.parseExtraFacebookPosts({ query: { extra_facebook_posts: '999' } }), 5);
    });
    check('parseExtraFacebookPosts: normal value passes through', () => {
      assert.strictEqual(generator.parseExtraFacebookPosts({ query: { extra_facebook_posts: '2' } }), 2);
    });

    check('getPostPlan: extraFacebookPosts=0 leaves plan unchanged vs no opts at all', () => {
      const withZero = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), { extraFacebookPosts: 0 });
      const withNone = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), {});
      assert.strictEqual(withZero.length, withNone.length);
    });

    check('getPostPlan: extraFacebookPosts=N appends N facebook slots, never mutates the base plan', () => {
      const base = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), {});
      const baseFbCount = base.filter((s) => s.platform === 'facebook').length;
      const withExtra = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), { extraFacebookPosts: 3 });
      const extraFbCount = withExtra.filter((s) => s.platform === 'facebook').length;
      assert.strictEqual(extraFbCount, baseFbCount + 3);
      assert.strictEqual(withExtra.length, base.length + 3);
      // Re-calling with 0 again must show the base is untouched (no mutation leaked).
      const baseAgain = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), {});
      assert.strictEqual(baseAgain.filter((s) => s.platform === 'facebook').length, baseFbCount, 'base plan must not have been mutated by the earlier extra-slot call');
    });

    check('getPostPlan: extraFacebookPosts ignored when facebook not in activePlatforms', () => {
      const withExtra = generator.getPostPlan(new Date('2026-09-16T12:00:00.000Z'), { extraFacebookPosts: 3, activePlatforms: ['twitter', 'linkedin'] });
      assert.strictEqual(withExtra.filter((s) => s.platform === 'facebook').length, 0);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
