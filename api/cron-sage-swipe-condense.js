'use strict';

// Vercel Serverless: /api/cron-sage-swipe-condense
// Monthly (1st of month, 06:00 UTC) — Sage reviews the full swipe file,
// merges duplicates, drops untested/unused entries, and demotes declining rules.
//
// Implements the "no silent overwrites" policy: old versions are kept as
// superseded, not deleted. Decisions driven by recency + real performance data.

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'POST only' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'missing SUPABASE env' });
  }

  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
  let demoted = 0;
  let expired = 0;

  // 1. Flag declining rules: active rules with 3+ uses and below-threshold performance
  const activeRules = await sb('/rest/v1/sage_swipe_rules?status=eq.active&order=date_added.asc');
  if (activeRules.ok && Array.isArray(activeRules.data)) {
    for (const rule of activeRules.data) {
      if (rule.times_used >= 3 && rule.avg_performance !== null && rule.avg_performance < 10) {
        await sb(`/rest/v1/sage_swipe_rules?id=eq.${rule.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'declining', updated_at: new Date().toISOString() }),
        });
        demoted++;
      }
    }
  }

  // 2. Expire untested rules older than 60 days
  const staleRules = await sb(
    `/rest/v1/sage_swipe_rules?status=eq.active&times_used=eq.0&date_added=lt.${sixtyDaysAgo}`
  );
  if (staleRules.ok && Array.isArray(staleRules.data)) {
    for (const rule of staleRules.data) {
      await sb(`/rest/v1/sage_swipe_rules?id=eq.${rule.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'expired', updated_at: new Date().toISOString() }),
      });
      expired++;
    }
  }

  // 3. Same treatment for hooks: retire stale untested hooks
  let hooksRetired = 0;
  const staleHooks = await sb(
    `/rest/v1/sage_hook_bank?status=eq.untested&created_at=lt.${sixtyDaysAgo}`
  );
  if (staleHooks.ok && Array.isArray(staleHooks.data)) {
    for (const hook of staleHooks.data) {
      await sb(`/rest/v1/sage_hook_bank?id=eq.${hook.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'retired', updated_at: new Date().toISOString() }),
      });
      hooksRetired++;
    }
  }

  // 4. Summary
  const summary = `MONTHLY SWIPE CONDENSE\n\nRules demoted (declining): ${demoted}\nRules expired (unused 60d+): ${expired}\nHooks retired (untested 60d+): ${hooksRetired}`;
  if (demoted + expired + hooksRetired > 0) {
    await tgSend(summary);
  }

  return res.status(200).json({
    ok: true,
    rules_demoted: demoted,
    rules_expired: expired,
    hooks_retired: hooksRetired,
  });
};
