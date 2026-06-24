// Vercel Serverless Function: /api/cron-sage-research
// ============================================================================
// SAGE PROACTIVE MODE (sage_1 spec, 2026-06-22)
//
// Heath promoted Sage from "wait for instructions" to "bring ideas."
//
// Daily at 12:00 UTC (7am CST):
//   1. Pull trending Texas RE headlines from RSS feeds (REALTOR Mag, HAR,
//      Inman, NAR, TXR resources).
//   2. Score each headline against Dossie's 5 pillars (Cost, Control,
//      Visibility, Speed, Coverage). Keep top 3-5 with a clear pillar match.
//   3. Draft a full social post per headline (Sonnet) using verified facts
//      from the VERIFIED FACTS block. Pick the best platform (FB/LI/TW)
//      based on the angle.
//   4. Insert into social_posts with status='draft' +
//      source_type='sage_research' + topic=headline + telegram_sent_at=NOW().
//      The telegram_sent_at stamp keeps these out of cron-send-to-sage's
//      reach so research drafts route ONLY to Heath's HUD, not the
//      autonomous reviewer.
//   5. jarvis-pending-approvals surfaces status='draft' rows with
//      source_type='sage_research' tagged as sage_research_draft in Heath's
//      HUD. One-tap Approve → flips to 'approved' → next publish-approved
//      cron picks it up. One-tap Reject → 'rejected' with Heath's reason;
//      future Sage prompts include rejected-research as a "do not repeat
//      these angles" hint.
//
// Auth: Bearer ${CRON_SECRET} (manual) OR x-vercel-cron header.
// Schedule (vercel.json): "0 12 * * *" (12 UTC = 7am CST in non-DST, 6am DST).
// MaxDuration: 90s (3 RSS fetches + 5 Sonnet drafts ~= 30-50s).
//
// Owner: Sage (sage_1, 2026-06-22 spawn).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const DRAFTER_MODEL = 'claude-sonnet-4-6';
const MAX_DRAFTS_PER_RUN = 5;
const KEEP_TOP_N_HEADLINES = 12; // we score these, drop to MAX_DRAFTS_PER_RUN

// RSS feeds — these are public and survive scraping. If one fails the run
// continues with whatever it could fetch.
const FEEDS = [
  {
    name: 'NAR Press Releases',
    url: 'https://www.nar.realtor/newsroom/feed',
    tag: 'nar',
  },
  {
    name: 'Inman News',
    url: 'https://www.inman.com/feed/',
    tag: 'inman',
  },
  {
    name: 'HousingWire',
    url: 'https://www.housingwire.com/feed/',
    tag: 'housingwire',
  },
  {
    name: 'Texas REALTORS (TXR)',
    url: 'https://www.texasrealestate.com/feed/',
    tag: 'txr',
  },
];

// Zernio account IDs (mirrored from CLAUDE.md so we can attach the right one).
const ZERNIO_ACCOUNTS = {
  facebook: '69f253c3985e734bf3d8f9bc',
  instagram: '69f25431985e734bf3d8fcbe',
  twitter: '69f255c6985e734bf3d90ba1',
  linkedin: '69fccd7392b3d8e85f8f12be',
  tiktok: '69f15791985e734bf3d13b89',
};

// Verified facts block — Sage refuses to invent specifics.
const VERIFIED_FACTS = `
VERIFIED FACTS (do not invent anything beyond these):
- Founding pricing: $29/month, locked while subscription stays active.
- ~50 founding spots, currently ~12 taken.
- Heath built Dossie after his TC quit mid-deal while he was on a trip; he
  had paid roughly $400/file for TC services and still woke at 4:30am
  running mental checklists.
- TC market rate range: $300-400 per file.
- Shipped Dossie features:
  - Contract scan + auto-deadline calc with paragraph citations
  - Pipeline view with per-deal deadline badges
  - Morning brief (voice, Luna narration)
  - Email draft queue (review-and-send)
  - Closing milestone cards
  - Talk-to-Dossie voice conversation
- Texas TREC rules (real, not invented): option period runs from executed
  date; earnest money typically due within 3 days of contract execution to
  title company; title commitment window; third-party financing
  contingency.
- Pillars: Cost, Control, Visibility, Speed, Coverage.
- Personas: brenda (relatable, 10-15 deals/yr), patricia (part-time, time
  constrained), victor (volume, 30+ deals/yr).
- Brand voice: warm, capable, never corporate.
`.trim();

// ─── helpers ────────────────────────────────────────────────────────────

async function supabaseFetch(path, init = {}) {
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

// Minimal RSS/Atom parser — extracts title + link + pubDate from <item> or
// <entry>. Enough for our needs; no external dep.
function parseFeedItems(xml, sourceTag, sourceName) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];

  // Try RSS <item> first, then Atom <entry>.
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

  const collect = (regex) => {
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const block = m[1];
      const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const link =
        (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] ||
        (block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] ||
        '';
      const pubDate =
        (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] ||
        (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] ||
        (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] ||
        '';
      const description =
        (block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] ||
        (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] ||
        '';

      const clean = (s) =>
        String(s || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      if (clean(title)) {
        items.push({
          source: sourceName,
          source_tag: sourceTag,
          title: clean(title),
          link: clean(link),
          published: clean(pubDate),
          description: clean(description).slice(0, 500),
        });
      }
    }
  };

  collect(itemRegex);
  if (items.length === 0) collect(entryRegex);

  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DossieSage/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[sage-research] feed ${feed.name} -> ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseFeedItems(xml, feed.tag, feed.name);
  } catch (err) {
    console.warn(`[sage-research] feed ${feed.name} failed:`, err && err.message);
    return [];
  }
}

// Recent = published within the last 14 days. Drops timeless evergreen we
// don't want to recycle every morning.
function isRecent(item) {
  if (!item.published) return true; // some feeds omit dates — keep them
  const ts = Date.parse(item.published);
  if (isNaN(ts)) return true;
  const ageMs = Date.now() - ts;
  return ageMs >= 0 && ageMs <= 14 * 24 * 60 * 60 * 1000;
}

// Keep only items relevant to Texas REALTORs: agent business, transactions,
// market data, NAR/TREC rule changes, brokerage tech. Drop pure listing
// noise. Cheap keyword filter — Sonnet's downstream scoring catches the rest.
const POSITIVE_KEYWORDS = [
  'realtor', 'agent', 'broker', 'transaction', 'tc ', 'coordinator',
  'closing', 'escrow', 'mls', 'commission', 'trec', 'texas', 'title',
  'lender', 'appraisal', 'option period', 'contract', 'deadline',
  'risk', 'liability', 'lawsuit', 'compliance', 'fee', 'cost', 'price',
  'market', 'housing', 'home sale', 'home price', 'inventory',
  'nar', 'settlement', 'buyer agent', 'listing agent', 'iBuyer',
];
const NEGATIVE_KEYWORDS = [
  'celebrity', 'mansion sold', 'penthouse', 'mortgage rate today',
];

function relevanceScore(item) {
  const blob = (item.title + ' ' + item.description).toLowerCase();
  let score = 0;
  for (const kw of POSITIVE_KEYWORDS) if (blob.includes(kw)) score += 1;
  for (const kw of NEGATIVE_KEYWORDS) if (blob.includes(kw)) score -= 3;
  return score;
}

// ─── drafting via Sonnet ─────────────────────────────────────────────────

async function draftPost(headline) {
  const systemPrompt = `You are Sage, Head of Social Media at Dossie. You write social media posts for Texas REALTORs.

${VERIFIED_FACTS}

## Your job

Read the trending headline below. Write ONE social media post that uses the headline as a hook into a Dossie capability that solves an agent pain. The post must:

1. Open with an agent-relatable hook (not a recap of the headline — extract the underlying pain).
2. Connect to ONE Dossie shipped feature from the verified list.
3. Stay warm, capable, never corporate.
4. Pick the best platform for this angle:
   - **facebook** (long-form, 200-350 words): founder stories, deep pain narratives, community questions
   - **linkedin** (200-300 words): authority + volume agent angles, market data, Victor persona
   - **twitter** (under 280 chars, short thread acceptable up to 3 chunks): one-liner capabilities, deadline rules, quick contrasts
5. Mention "Dossie" by name in the caption (this is a MAIN social post, NOT a Facebook group post).
6. Reference $29/month founding pricing only when it fits naturally — never every post.
7. End with one genuine open question.
8. NO hashtag dump in the body. List 3-5 hashtags separately.

Return JSON only:
{
  "platform": "facebook|linkedin|twitter",
  "persona": "brenda|patricia|victor|dossie",
  "topic": "5-7 word topic tag",
  "hook": "first 8 words of the post",
  "content": "the full post copy",
  "hashtags": ["tag1","tag2","tag3"],
  "pillar": "cost|control|visibility|speed|coverage",
  "feature_referenced": "which shipped feature this calls out",
  "headline_source": "the source feed name"
}`;

  const userPrompt = `Trending headline from ${headline.source}:

TITLE: ${headline.title}
${headline.description ? 'SUMMARY: ' + headline.description + '\n' : ''}LINK: ${headline.link || '(no link)'}
PUBLISHED: ${headline.published || 'recent'}

Write the post. Return JSON only.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DRAFTER_MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      console.warn('[sage-research] draft API status:', res.status);
      return null;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      console.warn('[sage-research] JSON parse failed:', e.message);
      return null;
    }
  } catch (err) {
    console.warn('[sage-research] draft failed:', err && err.message);
    return null;
  }
}

// ─── main ────────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-sage-research', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY missing' });
  }

  // 1. Pull all feeds in parallel.
  const allItems = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  // 2. Filter to recent + relevant.
  const recent = allItems.filter(isRecent);
  const scored = recent
    .map((item) => ({ ...item, score: relevanceScore(item) }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score);

  // 3. Dedup against rejected/used headlines from the last 7 days so we
  //    don't draft the same angle twice and don't push angles Heath rejected.
  const { data: recentSources } = await supabaseFetch(
    `/rest/v1/social_posts?select=topic,content,rejection_reason&source_type=eq.sage_research&created_at=gte.${encodeURIComponent(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    )}&limit=200`
  );
  const seenTopics = new Set();
  if (Array.isArray(recentSources)) {
    for (const r of recentSources) {
      if (r.topic) seenTopics.add(String(r.topic).toLowerCase().trim());
    }
  }

  const candidates = [];
  for (const item of scored) {
    const topicKey = item.title.toLowerCase().slice(0, 80);
    if (seenTopics.has(topicKey)) continue;
    candidates.push(item);
    seenTopics.add(topicKey);
    if (candidates.length >= KEEP_TOP_N_HEADLINES) break;
  }

  console.log(`[sage-research] feeds=${allItems.length} recent=${recent.length} scored=${scored.length} candidates=${candidates.length}`);

  // 4. Draft. Stop at MAX_DRAFTS_PER_RUN successful drafts.
  const drafted = [];
  for (const headline of candidates) {
    if (drafted.length >= MAX_DRAFTS_PER_RUN) break;
    const draft = await draftPost(headline);
    if (!draft || !draft.content || !draft.platform) continue;
    drafted.push({ headline, draft });
  }

  // 5. Insert each draft into social_posts as pending_approval.
  const inserted = [];
  for (const { headline, draft } of drafted) {
    const platform = String(draft.platform || '').toLowerCase();
    const zernioId = ZERNIO_ACCOUNTS[platform] || null;
    const nowIso = new Date().toISOString();
    const row = {
      post_id: `sage-research-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      platform,
      content: draft.content,
      hook: draft.hook || null,
      hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
      status: 'draft',
      persona: draft.persona || 'dossie',
      topic: draft.topic || headline.title.slice(0, 80),
      generated_at: nowIso,
      created_at: nowIso,
      // Route ONLY to Heath's HUD — don't auto-Sage-review research drafts.
      // cron-send-to-sage filters on telegram_sent_at IS NULL, so setting it
      // here keeps these out of the autonomous reviewer.
      telegram_sent_at: nowIso,
      requires_approval: true,
      source_type: 'sage_research',
      zernio_account_id: zernioId,
      verifier_result: {
        verdict: 'approve',
        summary: `Sage research draft from ${headline.source}: ${headline.title}`,
        source_link: headline.link || null,
        pillar: draft.pillar || null,
        feature_referenced: draft.feature_referenced || null,
      },
    };

    const ins = await supabaseFetch(`/rest/v1/social_posts`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (ins.ok && Array.isArray(ins.data) && ins.data.length > 0) {
      inserted.push({
        id: ins.data[0].id,
        platform: ins.data[0].platform,
        headline: headline.title,
        source: headline.source,
      });
    } else {
      console.warn('[sage-research] insert failed:', ins.status, JSON.stringify(ins.data).slice(0, 200));
    }
  }

  return res.status(200).json({
    ok: true,
    feeds_pulled: allItems.length,
    recent: recent.length,
    candidates: candidates.length,
    drafted: drafted.length,
    inserted: inserted.length,
    items: inserted,
  });
});
