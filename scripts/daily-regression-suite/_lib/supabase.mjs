// scripts/daily-regression-suite/_lib/supabase.mjs
//
// Minimal Supabase REST wrapper. No @supabase/supabase-js dependency —
// the runner MUST work when npm caches are cold or Anthropic is down.

export async function sb(cfg, urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: cfg.supabaseServiceKey,
    Authorization: `Bearer ${cfg.supabaseServiceKey}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${cfg.supabaseUrl}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data, text };
}

export async function sbCount(cfg, table, filter = '') {
  // exact count via Prefer: count=exact
  const url = `/rest/v1/${table}?select=id${filter ? '&' + filter : ''}&limit=1`;
  const res = await fetch(`${cfg.supabaseUrl}${url}`, {
    headers: {
      apikey: cfg.supabaseServiceKey,
      Authorization: `Bearer ${cfg.supabaseServiceKey}`,
      Prefer: 'count=exact',
    },
  });
  const range = res.headers.get('content-range') || '';
  const total = parseInt(range.split('/')[1] || '0', 10);
  return { ok: res.ok, status: res.status, count: Number.isFinite(total) ? total : 0 };
}

export async function insertRegressionRun(cfg, run) {
  return sb(cfg, '/rest/v1/regression_runs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(run),
  });
}

export async function fetchPreviousRun(cfg, source) {
  const { data } = await sb(cfg,
    `/rest/v1/regression_runs?source=eq.${encodeURIComponent(source)}&order=run_at.desc&limit=2&select=id,run_at,results`);
  return Array.isArray(data) ? data : [];
}
