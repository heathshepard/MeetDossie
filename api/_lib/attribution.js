'use strict';

// api/_lib/attribution.js
//
// Answers "which post produced a paying customer" end-to-end:
//   published link (social_posts.content_tag, set at publish time by
//     cron-publish-approved.js via api/_lib/content-tag.js)
//   -> click (PostHog pageview, utm_content = the same tag)
//   -> signup (founding_applications.first_touch/last_touch, captured
//     client-side by assets/dossie-acquisition.js)
//   -> paid (subscriptions.first_touch/last_touch, forwarded through Stripe
//     Checkout metadata by api/create-checkout-session.js + read back by
//     api/stripe-webhook.js)
//
// DELIBERATE DESIGN: attribution is NOT computed by filtering founding_
// applications/subscriptions by a "brand" table column — neither table has
// one, and adding a fake one would just be a second place for that fact to
// go stale. Instead every row's effective content_tag (last_touch wins,
// first_touch is the fallback) is decoded with parseContentTag(), which
// carries brand/platform/format/date INSIDE the tag itself. A row whose tag
// doesn't parse (or has none) is always counted in the "total" bucket and
// ALSO in "unattributed" — never silently dropped.
//
// BRAND COVERAGE — read before trusting a number:
//   - dossie / heath-realtor: both live in THIS Supabase project
//     (pgwoitbdiyubjugwufhk) and both are covered below.
//   - rust: runs on its OWN, separate Supabase project. This file has no
//     cross-project credentials and cannot see Rust's waitlist/profiles/
//     subscriptions tables. getRustAttributionStatus() below returns
//     supported:false rather than a fabricated zero — Rust needs its own
//     reporter (or RUST_SUPABASE_URL/RUST_SUPABASE_SERVICE_ROLE_KEY added to
//     this Vercel project) to appear here for real.
//
// PLATFORM CAVEAT: Instagram and TikTok captions are never clickable (see
// api/_lib/content-tag.js) — their "clicks" will structurally read 0/no-data
// forever unless a link-in-bio tool is added. Surfaced in every summary so
// it's never mistaken for "no interest."
//
// Owner: Carter, 2026-09-17

const { parseContentTag, PLATFORMS_WITHOUT_CAPTION_LINKS } = require('./content-tag.js');
const { runHogQL } = require('./posthog-query.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const KNOWN_BRANDS = ['dossie', 'heath-realtor', 'rust'];

async function defaultSupabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
function daysAgoIso(days) {
  return hoursAgoIso(days * 24);
}

// Picks the tag that actually decided the outcome: last-touch (what made
// THIS conversion happen) beats first-touch (what first created awareness).
// Falls back to whichever is present; null if neither carries one.
function effectiveTag(row) {
  const last = row && row.last_touch && row.last_touch.content_tag;
  const first = row && row.first_touch && row.first_touch.content_tag;
  return last || first || null;
}

function bucketByTag(rows, { paidPredicate } = {}) {
  const byTag = new Map(); // tag -> { total, paid }
  let totalAttributed = 0;
  let totalUnattributed = 0;
  let paidAttributed = 0;
  let paidUnattributed = 0;

  for (const row of rows) {
    const tag = effectiveTag(row);
    const parsed = tag ? parseContentTag(tag) : null;
    const isPaid = paidPredicate ? !!paidPredicate(row) : false;

    if (!parsed) {
      totalUnattributed++;
      if (isPaid) paidUnattributed++;
      continue;
    }
    totalAttributed++;
    if (isPaid) paidAttributed++;

    const entry = byTag.get(tag) || { tag, brand: parsed.brand, platform: parsed.platform, format: parsed.format, total: 0, paid: 0 };
    entry.total++;
    if (isPaid) entry.paid++;
    byTag.set(tag, entry);
  }

  return {
    total: rows.length,
    total_attributed: totalAttributed,
    total_unattributed: totalUnattributed,
    paid_attributed: paidAttributed,
    paid_unattributed: paidUnattributed,
    by_tag: [...byTag.values()],
  };
}

// PostHog click counts, grouped by the content_tag riding in utm_content.
// Returns { ok, byTag: Map<tag, clicks>, error } — a query failure or an
// unconfigured PostHog key returns ok:false with an EXPLICIT error, never a
// silent 0 that would be mistaken for "no clicks happened."
async function getClicksByTag(days, hogqlRunner) {
  const query = `
    SELECT properties.utm_content AS content_tag, count() AS clicks
    FROM events
    WHERE event = '$pageview'
      AND properties.utm_content IS NOT NULL
      AND timestamp >= now() - interval ${Number(days) || 30} day
    GROUP BY content_tag
    ORDER BY clicks DESC
  `;
  const result = await hogqlRunner(query);
  if (!result.ok) {
    return { ok: false, error: result.error, byTag: new Map() };
  }
  const byTag = new Map();
  for (const row of result.results || []) {
    const [tag, clicks] = row;
    if (tag) byTag.set(String(tag), Number(clicks) || 0);
  }
  return { ok: true, byTag };
}

// Pull hook_type/cta_type/hook_variant for a content_tag's row — the
// "backfill" step: hook performance and conversion sit in the same view
// without fabricating history for anything that was never tagged. Matches
// on content_tag directly (stored verbatim on the row at publish time),
// never by decoding shortContentId back into a full uuid.
async function enrichWithPostContext(tags, supabaseFetch) {
  const context = new Map();
  if (!tags.length) return context;
  const { data, ok } = await supabaseFetch(
    `/rest/v1/social_posts?content_tag=in.(${tags.map(encodeURIComponent).join(',')})` +
    `&select=id,content_tag,hook,hook_type,cta_type,hook_variant`,
  );
  if (ok && Array.isArray(data)) {
    for (const row of data) context.set(row.content_tag, row);
  }
  return context;
}

// Main entry point — dossie + heath-realtor only (see BRAND COVERAGE above).
// Dependency-injectable (supabaseFetch/hogqlRunner) so this is unit-testable
// against a mock server without touching production data — see
// scripts/regression-attribution.js.
async function getAttributionSummary({ days = 30, supabaseFetch = defaultSupabaseFetch, hogqlRunner = runHogQL } = {}) {
  const cutoff = daysAgoIso(days);

  const [postsRes, applicationsRes, subscriptionsRes, clicksRes] = await Promise.all([
    supabaseFetch(`/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(cutoff)}` +
      `&content_tag=not.is.null&select=id,platform,target_owner,content_tag,posted_at`),
    supabaseFetch(`/rest/v1/founding_applications?created_at=gte.${encodeURIComponent(cutoff)}` +
      `&select=id,status,first_touch,last_touch,created_at`),
    supabaseFetch(`/rest/v1/subscriptions?created_at=gte.${encodeURIComponent(cutoff)}` +
      `&select=id,plan,status,first_touch,last_touch,created_at`),
    getClicksByTag(days, hogqlRunner),
  ]);

  const published = (postsRes.ok && Array.isArray(postsRes.data)) ? postsRes.data : [];
  const applications = (applicationsRes.ok && Array.isArray(applicationsRes.data)) ? applicationsRes.data : [];
  const subscriptions = (subscriptionsRes.ok && Array.isArray(subscriptionsRes.data)) ? subscriptionsRes.data : [];

  const signupBucket = bucketByTag(applications, {});
  const paidBucket = bucketByTag(subscriptions, { paidPredicate: (row) => row.plan !== 'design_partner' });

  // Merge clicks/signups/paid onto one row per content_tag so "top/bottom
  // performing content" is a single sortable list, not three.
  const allTags = new Set([
    ...published.map((p) => p.content_tag).filter(Boolean),
    ...signupBucket.by_tag.map((t) => t.tag),
    ...paidBucket.by_tag.map((t) => t.tag),
    ...(clicksRes.ok ? [...clicksRes.byTag.keys()] : []),
  ]);

  const postContext = await enrichWithPostContext([...allTags], supabaseFetch);
  const signupByTag = new Map(signupBucket.by_tag.map((t) => [t.tag, t.total]));
  const paidByTag = new Map(paidBucket.by_tag.map((t) => [t.tag, t.paid]));

  const perContent = [...allTags].map((tag) => {
    const parsed = parseContentTag(tag);
    const ctx = postContext.get(tag) || {};
    return {
      content_tag: tag,
      brand: parsed ? parsed.brand : null,
      platform: parsed ? parsed.platform : null,
      format: parsed ? parsed.format : null,
      posted_date: parsed ? parsed.postedDate : null,
      clicks: clicksRes.ok ? (clicksRes.byTag.get(tag) || 0) : null,
      signups: signupByTag.get(tag) || 0,
      paid: paidByTag.get(tag) || 0,
      hook_type: ctx.hook_type || null,
      cta_type: ctx.cta_type || null,
      hook_variant: ctx.hook_variant || null,
      no_clickable_link: parsed ? PLATFORMS_WITHOUT_CAPTION_LINKS.includes(parsed.platform) : false,
    };
  });

  // Rank by paid > signups > clicks, so a real dollar always outranks a
  // click. Content with zero of everything still appears (never dropped),
  // just at the bottom.
  const rank = (c) => c.paid * 1000000 + c.signups * 1000 + (c.clicks || 0);
  perContent.sort((a, b) => rank(b) - rank(a));

  const perBrand = {};
  for (const brand of ['dossie', 'heath-realtor']) {
    const brandPublished = published.filter((p) => (p.target_owner || 'dossie') === brand);
    const brandTagged = new Set(brandPublished.map((p) => p.content_tag).filter(Boolean));
    perBrand[brand] = {
      published_count: brandPublished.length,
      distinct_content_tags: brandTagged.size,
      clicks: clicksRes.ok
        ? [...brandTagged].reduce((sum, tag) => sum + (clicksRes.byTag.get(tag) || 0), 0)
        : null,
      clicks_tracking_error: clicksRes.ok ? null : clicksRes.error,
      // signups/paid have NO brand column of their own — every row's tag is
      // decoded and only counted here if it actually decodes to this brand.
      // heath-realtor realistically stays at 0 for these (his listing
      // content doesn't link to Dossie signup) — a real, honest 0, not a
      // capability gap, and distinguished below from the tables not
      // existing at all for a brand like rust.
      signups: signupBucket.by_tag.filter((t) => t.brand === brand).reduce((s, t) => s + t.total, 0),
      paid: paidBucket.by_tag.filter((t) => t.brand === brand).reduce((s, t) => s + t.paid, 0),
      outcome_tables: 'founding_applications (signup), subscriptions (paid) — shared with dossie, decoded by tag',
    };
  }

  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    totals: {
      published_tagged: published.length,
      signups_total: signupBucket.total,
      signups_unattributed: signupBucket.total_unattributed,
      paid_total: subscriptions.length,
      paid_attributed: paidBucket.paid_attributed,
      paid_unattributed: paidBucket.paid_unattributed,
    },
    clicks_tracking: clicksRes.ok ? 'ok' : `FAILED: ${clicksRes.error}`,
    per_brand: perBrand,
    top_content: perContent.slice(0, 5),
    bottom_content: perContent.slice(-5).reverse(),
    platform_caveat: `Instagram and TikTok captions are never clickable — clicks for those platforms ` +
      `will always read 0 or untracked regardless of engagement. That is the platform, not the content. ` +
      `See api/_lib/content-tag.js PLATFORMS_WITHOUT_CAPTION_LINKS.`,
    rust: getRustAttributionStatus(),
  };
}

// Rust runs on its own Supabase project — see BRAND COVERAGE at the top of
// this file. Always explicit, never a fabricated zero.
function getRustAttributionStatus() {
  return {
    supported: false,
    reason: 'Rust runs on a separate Supabase project (not pgwoitbdiyubjugwufhk). ' +
      'This repo has no cross-project credentials to query it — waitlist/profiles ' +
      'already carry first-touch utm_* + utm_content (see Rust migrations 020, 029), ' +
      'but nothing here can read them. Needs its own reporter in the Rust repo, or ' +
      'RUST_SUPABASE_URL/RUST_SUPABASE_SERVICE_ROLE_KEY added to this Vercel project.',
  };
}

module.exports = {
  KNOWN_BRANDS,
  effectiveTag,
  bucketByTag,
  getClicksByTag,
  getAttributionSummary,
  getRustAttributionStatus,
};
