// Vercel Serverless Function: /api/admin-migrate-outbound-account-comments
//
// One-shot, idempotent DDL for
// supabase/migrations/20260928_outbound_account_comments.sql.
//
// Same reason this pattern exists as api/admin-migrate-zernio-comment-engine.js:
// PostgREST cannot run DDL, and the POSTGRES_* credentials are Vercel
// *Sensitive* vars, so DDL cannot be applied from a developer machine at
// all -- only from inside a deployment, where the real POSTGRES_URL is
// injected at runtime.
//
// Deliberately NOT a generic "run any SQL" endpoint: every statement is
// hardcoded below, so a leaked CRON_SECRET cannot turn this into arbitrary
// DDL execution. Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING,
// so re-running is a no-op.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}
// Method: POST

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS comment_target_accounts (
     id                  uuid primary key default gen_random_uuid(),
     platform            text not null check (platform in ('facebook', 'instagram')),
     account_name        text not null,
     handle              text,
     page_url            text not null,
     notes               text not null,
     active              boolean not null default true,
     existence_verified  boolean not null default false,
     verified_at         timestamptz,
     verified_by         text,
     verification_note   text,
     last_scanned_at     timestamptz,
     last_scan_ok        boolean,
     last_scan_error     text,
     added_by            text not null default 'atlas',
     created_at          timestamptz not null default now(),
     updated_at          timestamptz not null default now()
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS comment_target_accounts_url_uniq
     ON comment_target_accounts (lower(page_url))`,

  `CREATE INDEX IF NOT EXISTS comment_target_accounts_active_idx
     ON comment_target_accounts (active, existence_verified)`,

  `COMMENT ON TABLE comment_target_accounts IS
     'Curated larger Texas real-estate accounts/pages eligible for scripts/outbound-account-commenter.js. A row is only ever scanned/commented on when existence_verified=true.'`,

  `CREATE TABLE IF NOT EXISTS outbound_account_comments (
     id                  uuid primary key default gen_random_uuid(),
     target_account_id   uuid not null references comment_target_accounts(id) on delete cascade,
     platform            text not null,
     post_url            text not null,
     post_external_id    text,
     post_excerpt        text,
     post_author_name    text,
     draft_text          text,
     gate_failures       jsonb,
     status              text not null default 'pending'
       check (status in ('pending', 'drafted', 'posted', 'held', 'skipped', 'post_failed')),
     posted_at           timestamptz,
     posted_comment_id   text,
     error_message       text,
     created_at          timestamptz not null default now()
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS outbound_account_comments_post_uniq
     ON outbound_account_comments (target_account_id, post_url)`,

  `CREATE INDEX IF NOT EXISTS outbound_account_comments_account_day_idx
     ON outbound_account_comments (target_account_id, posted_at)`,

  `COMMENT ON TABLE outbound_account_comments IS
     'One row per drafted/posted comment from scripts/outbound-account-commenter.js. Report-mode default: rows land at status=drafted and nothing is posted until ops_flags.outbound_account_comments_live is on AND the daily cap/dedupe checks pass.'`,

  `INSERT INTO ops_flags (key, enabled, reason, updated_by) VALUES
     ('outbound_account_comments_live',
      false,
      'Posting drafted comments to larger Texas RE accounts/pages via scripts/outbound-account-commenter.js. OFF = report-mode (drafts only, nothing posts). Hard cap 3/day regardless once turned on.',
      'atlas')
   ON CONFLICT (key) DO NOTHING`,

  `INSERT INTO comment_target_accounts (platform, account_name, handle, page_url, notes) VALUES
     ('facebook', 'Texas REALTORS (state trade association)', 'texasrealtors', 'https://www.facebook.com/texasrealtors', 'Statewide REALTOR trade association -- largest single audience of working TX agents of anything on this list.'),
     ('facebook', 'HAR.com / Houston Association of REALTORS', 'HARdotcom', 'https://www.facebook.com/HARdotcom', 'Houston MLS/association -- one of the largest metro REALTOR bodies in the state.'),
     ('facebook', 'Ebby Halliday Realtors', 'EbbyHalliday', 'https://www.facebook.com/EbbyHalliday', 'Large, long-established DFW-area brokerage with a big agent roster and active page.'),
     ('facebook', 'Allie Beth Allman & Associates', 'alliebethallman', 'https://www.facebook.com/alliebethallman', 'Prominent Dallas luxury brokerage, high-visibility page.'),
     ('facebook', 'Kuper Sotheby''s International Realty', 'KuperSIR', 'https://www.facebook.com/KuperSIR', 'Large San Antonio-area luxury brokerage -- same metro Heath works in.'),
     ('facebook', 'Phyllis Browning Company', 'PhyllisBrowningCompany', 'https://www.facebook.com/PhyllisBrowningCompany', 'Large independent San Antonio brokerage, well-known locally.'),
     ('facebook', 'JPAR Real Estate', 'JPARRealEstate', 'https://www.facebook.com/JPARRealEstate', 'Texas-founded (Southlake) national franchise brokerage with heavy TX agent density.'),
     ('facebook', 'Coldwell Banker Apex, REALTORS', 'CBApexRealtors', 'https://www.facebook.com/CBApexRealtors', 'Large DFW-area Coldwell Banker affiliate, active agent-facing page.')
   ON CONFLICT (lower(page_url)) DO NOTHING`,
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const conn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!conn || conn === '[SENSITIVE]') {
    return res.status(500).json({
      ok: false,
      error: 'No usable POSTGRES_URL_NON_POOLING/POSTGRES_URL in this environment',
    });
  }

  let cleanConn = conn;
  try {
    const u = new URL(conn);
    u.searchParams.delete('sslmode');
    cleanConn = u.toString();
  } catch { /* not URL-parseable: fall back to the raw string */ }

  const client = new Client({ connectionString: cleanConn, ssl: { rejectUnauthorized: false } });
  const applied = [];
  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
      applied.push(sql.trim().split('\n')[0].trim().slice(0, 90));
    }

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('comment_target_accounts','outbound_account_comments')
        ORDER BY table_name`,
    );
    const seeded = await client.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE existence_verified) ::int AS verified
         FROM comment_target_accounts`,
    );
    const flag = await client.query(
      `SELECT key, enabled FROM public.ops_flags WHERE key = 'outbound_account_comments_live'`,
    );

    return res.status(200).json({
      ok: true,
      statements_applied: applied.length,
      tables_present: tables.rows.map((r) => r.table_name),
      seeded_accounts: seeded.rows[0],
      flag: flag.rows[0] || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message, applied });
  } finally {
    await client.end().catch(() => {});
  }
};
