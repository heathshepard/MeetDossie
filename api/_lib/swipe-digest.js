// api/_lib/swipe-digest.js
//
// The weekly swipe-file section of the existing morning brief
// (api/cron-morning-brief.js). One section in one message Heath already
// reads — deliberately not a new bot, a new cron, or a new Telegram channel.
//
// Renders on Mondays only. Every other day it returns '' and the brief is
// byte-for-byte what it was before.
//
// Three questions, in this order:
//   1. What's newly working    — first seen in the last 7 days.
//   2. What's been running longest — the strongest evidence we have on Meta,
//      because a commercial ad carries no public spend or impression data and
//      nobody keeps paying to run a loser.
//   3. 2-3 patterns worth stealing — highest evidence_score, plus any hook
//      candidates sitting unreviewed.
//
// Doc: docs/SWIPE-FILE-PIPELINE.md

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MARKET_LABEL = {
  tx_real_estate: 'TX real estate',
  tc_saas: 'TC / RE SaaS',
  fitness_ai: 'fitness / AI coaching',
  unknown: 'unclassified',
};

async function q(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function trim(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isMondayChicago(now = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short',
  }).format(now);
  return wd === 'Mon';
}

// Returns a string. '' means "render nothing" — the caller appends it blindly.
async function buildSwipeDigest(now = new Date(), opts = {}) {
  if (!opts.force && !isMondayChicago(now)) return '';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return '';

  const [newest, longest, patterns, candidates, pendingCapture] = await Promise.all([
    q('swipe_digest_v?is_new_this_week=is.true&order=evidence_score.desc.nullslast&limit=4'
      + '&select=advertiser,market,hook_text,days_running,link,evidence_kind,evidence,source'),
    q('swipe_digest_v?days_running=not.is.null&order=days_running.desc&limit=3'
      + '&select=advertiser,market,hook_text,days_running,link,cta_text'),
    q('swipe_digest_v?hook_pattern=not.is.null&order=evidence_score.desc.nullslast&limit=3'
      + '&select=advertiser,market,hook_pattern,structure,cta_shape,evidence_score,evidence_basis'),
    q('swipe_hook_candidates?status=eq.pending&order=evidence_score.desc.nullslast&limit=3'
      + '&select=id,candidate_hook,market,target_brand,evidence_score'),
    q('swipe_inbox?status=eq.needs_capture&select=id&limit=20'),
  ]);

  // Nothing collected yet: say so once rather than printing an empty heading
  // every Monday forever.
  const haveAnything = (newest && newest.length)
    || (longest && longest.length)
    || (patterns && patterns.length);
  if (!haveAnything && !(candidates && candidates.length) && !(pendingCapture && pendingCapture.length)) {
    return '';
  }

  const L = [];
  L.push('🗂 SWIPE FILE (weekly)');

  if (newest && newest.length) {
    L.push(`New this week (${newest.length}):`);
    for (const a of newest) {
      const age = a.days_running != null ? `${a.days_running}d running` : 'run length unknown';
      const views = a.evidence_kind === 'youtube_engagement' && a.evidence
        ? `${Number(a.evidence.views || 0).toLocaleString()} views`
        : age;
      L.push(`  • [${MARKET_LABEL[a.market] || a.market}] ${trim(a.advertiser, 28)} — ${views}`);
      if (a.hook_text) L.push(`    "${trim(a.hook_text, 90)}"`);
    }
  } else {
    L.push('New this week: none collected.');
  }

  if (longest && longest.length) {
    L.push('Running longest (nobody keeps paying for a loser):');
    for (const a of longest) {
      L.push(`  • ${a.days_running}d — ${trim(a.advertiser, 28)} [${MARKET_LABEL[a.market] || a.market}]`
        + `${a.cta_text ? ` · CTA "${a.cta_text}"` : ''}`);
    }
  }

  if (patterns && patterns.length) {
    L.push('Worth stealing this week:');
    for (const p of patterns) {
      L.push(`  • ${trim(p.hook_pattern, 120)}`);
      if (p.structure) L.push(`    shape: ${trim(p.structure, 90)}`);
      L.push(`    evidence ${p.evidence_score ?? '?'}/100 — ${trim(p.evidence_basis, 100)}`);
    }
    L.push('  (structure only — never their copy, claims or offers)');
  }

  if (candidates && candidates.length) {
    L.push(`Hook-bank candidates awaiting you (${candidates.length}):`);
    for (const c of candidates) {
      L.push(`  • [${c.target_brand || MARKET_LABEL[c.market] || c.market}] "${trim(c.candidate_hook, 80)}"`);
    }
    L.push('  Accept: set status=accepted, then node scripts/swipe-merge-hook-candidates.js');
  }

  if (pendingCapture && pendingCapture.length) {
    L.push(`⏳ ${pendingCapture.length} pasted link(s) waiting on a browser capture (Instagram/LinkedIn).`);
  }

  return L.join('\n');
}

module.exports = { buildSwipeDigest, isMondayChicago };
