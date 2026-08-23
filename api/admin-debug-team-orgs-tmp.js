// TEMPORARY verification-only endpoint — lists Team/Brokerage orgs + their
// admin members, for finding a real org to seed a test risk condition on
// (SV-ENG-TEAM-RISK-PUSH verification, 2026-08-23). Deleted before this
// feature's staging work is considered done — not a permanent addition.
// Fixed query only, not a general SQL-exec endpoint.
const { Client } = require('pg');
const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

module.exports = async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!CONNECTION_STRING) return res.status(503).json({ ok: false, error: 'no_pg_conn' });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();

    // POST ?seed_overdue_action_item=1&org_id=... -- inserts one new overdue
    // action_item on the FIRST non-closed transaction found in that org, so
    // the hourly runner has a genuinely new condition to detect. Demo-org
    // only, reversible (returns the inserted id for cleanup).
    if (req.method === 'POST' && req.query && req.query.seed_overdue_action_item === '1') {
      const orgId = req.query.org_id;
      const txRes = await client.query(
        `SELECT id FROM public.transactions WHERE org_id = $1 AND status != 'closed' LIMIT 1`,
        [orgId]
      );
      if (txRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'no non-closed transaction found for org' });
      }
      const txId = txRes.rows[0].id;
      const insRes = await client.query(
        `INSERT INTO public.action_items (transaction_id, description, action_type, status, due_date)
         VALUES ($1, $2, 'other', 'pending', (CURRENT_DATE - INTERVAL '1 day'))
         RETURNING id, transaction_id, due_date`,
        [txId, 'CARTER-VERIFY-TEMP: seeded overdue action item for hourly risk-push test']
      );
      return res.status(200).json({ ok: true, inserted: insRes.rows[0] });
    }

    // DELETE ?cleanup_action_item_id=... -- removes the seeded row above.
    if (req.method === 'DELETE' && req.query && req.query.cleanup_action_item_id) {
      await client.query(`DELETE FROM public.action_items WHERE id = $1`, [req.query.cleanup_action_item_id]);
      return res.status(200).json({ ok: true, deleted: req.query.cleanup_action_item_id });
    }
    const orgs = await client.query(`
      SELECT o.id, o.name, o.tier, o.created_by_user_id, o.archived_at
      FROM public.organizations o
      WHERE o.tier IN ('team','brokerage')
      ORDER BY o.created_at DESC
      LIMIT 30
    `);
    const members = await client.query(`
      SELECT m.org_id, m.user_id, u.email, array_agg(r.role) as roles
      FROM public.organization_members m
      JOIN auth.users u ON u.id = m.user_id
      LEFT JOIN public.organization_member_roles r ON r.member_id = m.id AND r.revoked_at IS NULL
      WHERE m.removed_at IS NULL
      GROUP BY m.org_id, m.user_id, u.email
      ORDER BY m.org_id
    `);
    const subs = await client.query(`
      SELECT id, org_id, user_id, endpoint, created_at FROM public.team_risk_push_subscriptions ORDER BY created_at DESC LIMIT 20
    `);
    const alerts = await client.query(`
      SELECT org_id, risk_key, category, first_alerted_at, last_alerted_at FROM public.team_risk_alerts_sent ORDER BY last_alerted_at DESC LIMIT 50
    `);
    const state = await client.query(`
      SELECT org_id, baseline_seeded_at FROM public.team_risk_alert_state
    `);
    return res.status(200).json({ ok: true, orgs: orgs.rows, members: members.rows, subs: subs.rows, alerts: alerts.rows, state: state.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  }
};
