'use strict';

// Vercel Serverless: /api/cron-sage-filming-brief
// Runs Sunday 23:00 UTC (6 PM CDT) — generates the week's filming brief.
// One ritual, one filming day, both Dossie + real estate accounts covered.
//
// Flow:
//   1. Pull proven hooks from sage_hook_bank
//   2. Pull active swipe rules from sage_swipe_rules
//   3. Pull recent performance data from sage_performance_log
//   4. Pull trend data from sage_trend_briefs (latest)
//   5. Generate brief via Claude Sonnet — a short filmable list
//   6. Store in sage_filming_briefs
//   7. Send to Sage Telegram thread

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, data: text }; }
}

async function tgSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const MAX = 4000;
  let s = String(text);
  while (s.length > 0) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: s.slice(0, MAX),
        disable_web_page_preview: true,
      }),
    });
    s = s.slice(MAX);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'POST only' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) return res.status(200).json({ ok: false, error: `missing: ${missing}` });

  // 1. Proven + tested hooks
  const hooks = await sb('/rest/v1/sage_hook_bank?status=in.(proven,tested)&order=avg_performance.desc.nullslast&limit=20');

  // 2. Active swipe rules
  const rules = await sb('/rest/v1/sage_swipe_rules?status=eq.active&order=avg_performance.desc.nullslast&limit=15');

  // 3. Recent performance (last 2 weeks)
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  const perf = await sb(`/rest/v1/sage_performance_log?recorded_at=gte.${twoWeeksAgo}&order=recorded_at.desc&limit=30`);

  // 4. Latest trend data
  const trends = await sb('/rest/v1/sage_trend_briefs?order=created_at.desc&limit=1');

  // Compute next Monday as the week_start
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
  const monday = new Date(now.getTime() + daysUntilMonday * 86400000);
  const weekStart = monday.toISOString().slice(0, 10);

  const hooksData = hooks.ok && Array.isArray(hooks.data) ? hooks.data : [];
  const rulesData = rules.ok && Array.isArray(rules.data) ? rules.data : [];
  const perfData = perf.ok && Array.isArray(perf.data) ? perf.data : [];
  const trendData = trends.ok && Array.isArray(trends.data) && trends.data[0] ? trends.data[0] : null;

  const prompt = `You are Sage, Head of Social Media & Content Distribution. Generate this week's filming brief for Heath.

WEEK: ${weekStart}
ACCOUNTS: Dossie (SaaS, primary) and Heath Shepard Real Estate (real estate business)

CROSS-PROMOTION RULE (HARD): Dossie content may cross-post to real estate channels. Real estate content must NEVER cross-post to Dossie channels. One-directional only.

CONTENT PILLARS (ranked):
1. Educational (buyer/seller tips, market explainers)
2. Hyper-local authority (neighborhood spotlights, SA market)
3. Personal brand (Heath's story, day-in-the-life)
4. Social proof (client testimonials, WITH permission only)
5. Listings (LOWEST — gated by seller permission, limited inventory)

${trendData ? `CURRENT TRENDS:\n${JSON.stringify(trendData.brief_data || trendData, null, 2).slice(0, 800)}` : 'No trend data available — use evergreen topics.'}

PROVEN HOOKS (from hook bank — recycle with variation):
${hooksData.length ? hooksData.slice(0, 10).map(h => `- [${h.pillar}/${h.account}] "${h.hook}" (perf: ${h.avg_performance || 'untested'}, used ${h.times_used}x)`).join('\n') : 'No proven hooks yet — generate fresh ones.'}

ACTIVE SWIPE RULES:
${rulesData.length ? rulesData.slice(0, 8).map(r => `- [${r.rule_type}] ${r.rule_text}`).join('\n') : 'No swipe rules yet.'}

RECENT PERFORMANCE (last 2 weeks):
${perfData.length ? perfData.slice(0, 10).map(p => `- ${p.platform}/${p.pillar}: views=${p.views || '?'}, watch_through=${p.watch_through_rate || '?'}, shares=${p.shares || '?'}`).join('\n') : 'No performance data yet — go with best practices.'}

OUTPUT FORMAT — return ONLY valid JSON array. Each item:
{
  "hook": "opening line Heath will say/show",
  "topic": "what the clip covers",
  "target_seconds": 15-45,
  "pillar": "educational|hyper-local|personal-brand|social-proof|listings",
  "account": "dossie|real-estate",
  "platforms": ["instagram", "tiktok", "facebook"],
  "trending_reference": "optional — trending audio or format to reference",
  "notes": "optional filming notes"
}

TARGET: 10-14 clips total. Split roughly 60/40 Dossie/real-estate. One filming session should cover a full week of posting for both accounts. Weight listing tours LOWEST — it's gated by seller permission. Fold in any relevant trends. Use proven hooks with variation where possible.`;

  let briefItems;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const apiText = await apiRes.text();
    if (!apiRes.ok) throw new Error(`Anthropic ${apiRes.status}: ${apiText.slice(0, 200)}`);
    const apiData = JSON.parse(apiText);
    const raw = (apiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');
    briefItems = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[filming-brief] generation failed:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }

  // Store brief
  const insert = await sb('/rest/v1/sage_filming_briefs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      week_start: weekStart,
      brief_json: briefItems,
      trend_data: trendData,
      status: 'draft',
    }),
  });

  // Format for Telegram
  const dossieItems = briefItems.filter(i => i.account === 'dossie');
  const reItems = briefItems.filter(i => i.account === 'real-estate');

  let tgText = `FILMING BRIEF — Week of ${weekStart}\n\n`;
  tgText += `DOSSIE (${dossieItems.length} clips):\n`;
  dossieItems.forEach((item, i) => {
    tgText += `${i + 1}. "${item.hook}"\n   ${item.topic} | ${item.target_seconds}s | ${item.pillar}\n   Platforms: ${(item.platforms || []).join(', ')}\n`;
    if (item.trending_reference) tgText += `   Trend: ${item.trending_reference}\n`;
    if (item.notes) tgText += `   Notes: ${item.notes}\n`;
  });

  tgText += `\nREAL ESTATE (${reItems.length} clips):\n`;
  reItems.forEach((item, i) => {
    tgText += `${i + 1}. "${item.hook}"\n   ${item.topic} | ${item.target_seconds}s | ${item.pillar}\n   Platforms: ${(item.platforms || []).join(', ')}\n`;
    if (item.trending_reference) tgText += `   Trend: ${item.trending_reference}\n`;
    if (item.notes) tgText += `   Notes: ${item.notes}\n`;
  });

  tgText += `\nTotal: ${briefItems.length} clips. One filming session.`;

  await tgSend(tgText);

  // Mark as sent
  if (insert.ok && Array.isArray(insert.data) && insert.data[0]) {
    await sb(`/rest/v1/sage_filming_briefs?id=eq.${insert.data[0].id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'sent', telegram_sent_at: new Date().toISOString() }),
    });
  }

  return res.status(200).json({
    ok: true,
    week: weekStart,
    clips: briefItems.length,
    dossie: dossieItems.length,
    real_estate: reItems.length,
  });
};
