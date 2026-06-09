'use strict';

// Sage query marker parser + Supabase reader.
//
// Sage can include markers in her replies to read approved tables. Example:
//
//   [QUERY: table=social_posts, last=10, status=posted]
//   [QUERY: table=reddit_engagements, status=approved]
//
// The webhook parses these markers, runs read-only SELECTs against an
// allowlisted set of tables/columns, and sends the formatted results back
// to Sage as a follow-up message — they also land in sage_conversations so
// Sage's next turn has the data in context.

const ALLOWED_TABLES = {
  social_posts: {
    select: 'id,platform,persona,topic,hook,status,scheduled_for,posted_at,likes,comments,shares,clicks,views,top_performer,variant',
    defaultOrder: 'created_at.desc',
    filterableColumns: new Set(['platform', 'status', 'persona', 'topic', 'variant', 'top_performer']),
  },
  reddit_engagements: {
    select: '*',
    defaultOrder: 'created_at.desc',
    filterableColumns: new Set(['status', 'subreddit', 'platform']),
  },
  content_calendar: {
    select: '*',
    defaultOrder: 'week_number.asc,day_number.asc',
    filterableColumns: new Set(['persona', 'week_number', 'day_number']),
  },
  video_library: {
    select: '*',
    defaultOrder: 'created_at.desc',
    filterableColumns: new Set(['status', 'platform', 'video_type']),
  },
  posting_schedule: {
    select: '*',
    defaultOrder: 'platform.asc',
    filterableColumns: new Set(['platform']),
  },
  post_analytics: {
    select: '*',
    defaultOrder: 'synced_at.desc',
    filterableColumns: new Set(['platform', 'persona', 'topic']),
  },
};

const QUERY_MARKER_REGEX = /\[\s*QUERY\s*:\s*([^\]\n]{3,500})\s*\]/gi;

function parseQueryMarker(body) {
  const params = {};
  const pairs = body.split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim();
    params[key] = val;
  }
  return params;
}

function extractQueryMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const m of text.matchAll(QUERY_MARKER_REGEX)) {
    const body = String(m[1] || '').trim();
    const params = parseQueryMarker(body);
    if (!params.table) continue;
    out.push({ raw: m[0], params });
  }
  return out;
}

function stripQueryMarkers(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(QUERY_MARKER_REGEX, (_match, body) => {
    const params = parseQueryMarker(String(body || ''));
    const tbl = params.table || 'unknown';
    return `[reading ${tbl}...]`;
  });
}

async function runQuery(params, { supabaseUrl, supabaseKey }) {
  const tableName = String(params.table || '').toLowerCase();
  const spec = ALLOWED_TABLES[tableName];
  if (!spec) {
    return { ok: false, error: `table '${tableName}' is not in the read allowlist. Allowed: ${Object.keys(ALLOWED_TABLES).join(', ')}` };
  }

  const limit = Math.min(parseInt(params.last || params.limit || '20', 10) || 20, 100);
  const order = params.order || spec.defaultOrder;

  const qs = new URLSearchParams();
  qs.set('select', spec.select);
  qs.set('order', order);
  qs.set('limit', String(limit));

  for (const [k, v] of Object.entries(params)) {
    if (['table', 'last', 'limit', 'order'].includes(k)) continue;
    if (!spec.filterableColumns.has(k)) continue;
    qs.set(k, `eq.${v}`);
  }

  const url = `${supabaseUrl}/rest/v1/${tableName}?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Supabase ${res.status}: ${text.slice(0, 200)}`, table: tableName };
    }
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    return { ok: true, table: tableName, rows: Array.isArray(data) ? data : [], limit, filters: params };
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err && err.message}`, table: tableName };
  }
}

function formatQueryResult(result) {
  if (!result.ok) {
    return `Query failed for ${result.table || 'unknown'}: ${result.error}`;
  }
  const { table, rows, limit, filters } = result;
  const filterParts = Object.entries(filters)
    .filter(([k]) => !['table', 'last', 'limit', 'order'].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  const filterStr = filterParts.length ? ` (${filterParts.join(', ')})` : '';

  if (!rows || rows.length === 0) {
    return `${table}${filterStr}: no rows (limit ${limit}).`;
  }

  const lines = [`${table}${filterStr}: ${rows.length} row(s), limit ${limit}`];
  const sample = rows.slice(0, Math.min(rows.length, 25));
  for (const row of sample) {
    lines.push(JSON.stringify(row));
  }
  if (rows.length > sample.length) {
    lines.push(`...and ${rows.length - sample.length} more`);
  }
  return lines.join('\n');
}

module.exports = {
  ALLOWED_TABLES,
  extractQueryMarkers,
  stripQueryMarkers,
  runQuery,
  formatQueryResult,
};
