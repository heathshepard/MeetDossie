#!/usr/bin/env node
//
// scripts/regression-twitter-length.js
//
// Locks the fix for the four Twitter rejections on 2026-09-22, 09-24 (x2) and
// 09-25 — every one of them "Tweet text is too long (306 / 310 / 312
// characters). Twitter's limit is 280."
//
// The fixtures are REAL captions read out of social_posts on 2026-09-25, not
// invented strings. Their stored raw lengths are 264-278, which is why the
// pre-existing `text.length <= 280` checks passed all four: the growth that
// broke them happens after generation, inside
// api/cron-publish-approved.js buildPostBody().
//
//   node scripts/regression-twitter-length.js

'use strict';

const {
  weightedLength, effectiveLength, clampForTwitter,
  assertTwitterFits, estimatePublisherGrowth, findUrls,
} = require('../api/_lib/twitter-length.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Real rows, social_posts, platform='twitter', 2026-09-20..09-25.
const REAL_CAPTIONS = [
  "3 days. That's all you get to deliver earnest money to title after a Texas contract executes.\n\nMiss it and you're not just late - you're handing the buyer leverage and creating default risk for your seller.\n\nMost agents miscount the start date. meetdossie.com/signup",
  "Miss it by a minute. It's gone.\n\nOption period deadlines run from the executed date. Miss the termination deadline by one minute and the right to walk away disappears - no grace period, no exceptions.\n\nDossie calculates the exact deadline. meetdossie.com/signup",
  "A missed deadline isn't bad luck. It's math nobody ran.\n\nDossie scans your TREC contract, calculates every deadline, and cites the paragraph. Option period, survey, title - mapped the second you upload.\n\nSolo pricing is $149/month. meetdossie.com/signup",
  "Who's watching the inbox at 9pm while you're still at a showing? Dossie's email draft queue keeps follow-ups ready to review and send, so you're not writing from scratch after a 12 hour day. Solo is $149/mo. meetdossie.com/signup #txrealestate #realtorlife #trec",
];

const HASHTAGS = ['txrealestate', 'realtorlife', 'trec'];

console.log('\n1. weighted counting — a URL is 23 to Twitter regardless of length');
{
  const short = 'meetdossie.com/signup';
  const long = `${short}?utm_source=twitter&utm_medium=social&utm_campaign=dossie&utm_content=dossie.twitter.video.a1b2c3d4.20260925`;
  check('short bare URL weighs 23', weightedLength(short) === 23, `got ${weightedLength(short)} (raw ${short.length})`);
  check('UTM-tagged URL also weighs 23', weightedLength(long) === 23, `got ${weightedLength(long)}`);
  check('raw .length UNDER-counts the short URL by 2', short.length === 21);
  check('bare-domain URL is detected without a scheme', findUrls(`see ${short} now`).length === 1);
  check('emoji weighs 2', weightedLength('\u{1F600}') === 2, `got ${weightedLength('\u{1F600}')}`);
}

console.log('\n2. the real captions all pass the OLD check and would still have failed');
{
  for (const cap of REAL_CAPTIONS) {
    const growth = estimatePublisherGrowth(cap, { hashtags: HASHTAGS });
    const shipped = effectiveLength(cap) + growth;
    check(
      `stored caption is under 280 raw but ships at ${shipped}`,
      cap.length <= 280 && shipped > 280,
      `raw ${cap.length}, ships ${shipped}`,
    );
  }
}

console.log('\n3. the generation-time clamp fits the SHIPPED body, not the caption');
{
  for (const cap of REAL_CAPTIONS) {
    const growth = estimatePublisherGrowth(cap, { hashtags: HASHTAGS });
    const clamped = clampForTwitter(cap, { reserve: growth });
    const shipped = clamped.after + growth;
    check(`clamped caption ships at ${shipped} <= 280`, shipped <= 280, `got ${shipped}`);
    check('the CTA link survived the clamp', /meetdossie\.com/.test(clamped.text), clamped.text.slice(-60));
  }
}

console.log('\n4. a URL is never cut in half');
{
  const cap = `${'word '.repeat(60)}meetdossie.com/signup`;
  const c = clampForTwitter(cap, { reserve: 120 });
  const urls = findUrls(c.text);
  check('exactly one whole URL remains', urls.length === 1 && urls[0].raw === 'meetdossie.com/signup', JSON.stringify(urls.map((u) => u.raw)));
}

console.log('\n5. clamp is a no-op on copy that already fits');
{
  const ok = 'Short and correct. meetdossie.com/signup';
  const c = clampForTwitter(ok);
  check('unchanged', c.changed === false && c.text === ok);
}

console.log('\n6. assertTwitterFits names WHICH counter rejected it');
{
  const tagged = `${'x'.repeat(200)} meetdossie.com/a?utm_source=twitter&utm_medium=social&utm_campaign=dossie&utm_content=dossie.twitter.video.a1b2c3d4.20260925`;
  const r = assertTwitterFits([tagged]);
  check('over-limit body is reported', r.ok === false && r.over.length === 1);
  check('the raw counter is identified as the stricter one', r.over[0].counter.startsWith('raw'), r.over[0].counter);
  check('weighted count is well under the limit', r.over[0].weighted < 280, `weighted ${r.over[0].weighted}`);
}

console.log('\n7. splitForTwitter never emits an over-limit chunk');
{
  // The exact failure shape: ONE sentence, already over the limit, no
  // paragraph breaks to split on. The old code pushed it through untouched.
  const { splitForTwitter } = loadPublisher();
  if (!splitForTwitter) {
    console.log('  SKIP  splitForTwitter not exported — checked via the clamp instead');
  } else {
    const body = `${'A long unbroken sentence about Texas contract deadlines that simply keeps going and going '.repeat(4)}meetdossie.com/signup?utm_source=twitter&utm_medium=social&utm_campaign=dossie&utm_content=dossie.twitter.video.a1b2c3d4.20260925`;
    const chunks = splitForTwitter(body);
    const bad = chunks.filter((c) => effectiveLength(c) > 280);
    check(`all ${chunks.length} chunks are <= 280`, bad.length === 0, bad.map((c) => effectiveLength(c)).join(','));
  }
}

console.log('\n8. END TO END — the real caption through the real buildPostBody + splitForTwitter');
{
  const { splitForTwitter, buildPostBody } = loadPublisher();
  if (!splitForTwitter || !buildPostBody) {
    console.log('  SKIP  publisher not loadable in this environment');
  } else {
    for (const content of REAL_CAPTIONS) {
      const post = {
        id: '11111111-2222-3333-4444-555555555555',
        platform: 'twitter',
        content,
        hashtags: HASHTAGS,
        target_owner: 'dossie',
        media_url: 'https://example.supabase.co/storage/v1/object/public/videos/x.mp4',
      };
      const { text } = buildPostBody(post);
      const chunks = splitForTwitter(text);
      const worst = Math.max(...chunks.map(effectiveLength));
      const grew = effectiveLength(text) > effectiveLength(content);
      check(
        `caption ${effectiveLength(content)} -> body ${effectiveLength(text)} -> ${chunks.length} chunk(s), worst ${worst}`,
        worst <= 280 && grew,
        `worst ${worst}`,
      );
      check('the CTA link is still in the output', chunks.join(' ').includes('meetdossie.com'));
    }
  }
}

function loadPublisher() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('../api/cron-publish-approved.js');
    return { splitForTwitter: mod.splitForTwitter || null, buildPostBody: mod.buildPostBody || null };
  } catch (_) {
    return { splitForTwitter: null, buildPostBody: null };
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
