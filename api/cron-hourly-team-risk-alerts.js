// Vercel Serverless Function: /api/cron-hourly-team-risk-alerts
//
// Real-time push companion to api/cron-weekly-team-risk-digest.js — additive,
// not a replacement. The weekly digest is the full summary; this is the
// "don't make a team lead wait for Monday, or think to ask Dossie" path:
// every hour, re-run the same team-wide risk rollup
// (api/_lib/team-risk-rollup.js — identical aggregation the Team Dashboard
// UI and the weekly digest already use, so this can never disagree with
// either) and push an instant OS notification for any risk condition that
// is GENUINELY NEW since the last check — a deadline that just passed, a
// disclosure that just went missing, an action item that just went overdue.
//
// Dedup: public.team_risk_alerts_sent holds one row per (org_id, risk_key)
// still-outstanding condition. A condition already in that table does NOT
// re-push. Once a condition resolves (doc uploaded / item completed /
// deadline no longer in the past on an open file) its row is deleted, so if
// the SAME condition recurs later it alerts again rather than being
// permanently silenced.
//
// Baseline seeding: public.team_risk_alert_state holds one row per org,
// written on that org's first-ever pass through this cron. Without it, the
// very first run for an org with pre-existing outstanding risk (or one that
// only just subscribed) would treat every already-known condition as "new"
// and fire a burst of pushes for stuff the team lead already knows about.
// First pass seeds team_risk_alerts_sent silently (no push); every pass
// after that alerts on genuinely new conditions only.
//
// risk_key format (must stay in sync with the shapes buildTeamRiskRollup
// returns):
//   'disclosure:{transaction_id}:{doc_type}'
//   'action_item:{action_item_id}'
//   'deadline:{transaction_id}:{flag}'
//
// Recipients: every row in team_risk_push_subscriptions for the org (one row
// per org-admin browser/device — could be more than one admin, could be one
// admin on multiple devices).
//
// Auth: Bearer ${CRON_SECRET}
// Schedule: 5 * * * *  (5 minutes past every hour — offset from the top-of-
// hour cron-mission-watchdog slot to avoid piling every hourly cron onto the
// same minute).
//
// Owner: Carter, 2026-08-23 (SV-ENG-TEAM-RISK-PUSH)

const webpush = require('web-push');
const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { getServiceClient } = require('./_lib/team-auth.js');
const { buildTeamRiskRollup, REQUIRED_DOC_TYPES } = require('./_lib/team-risk-rollup.js');

const CRON_SECRET = process.env.CRON_SECRET;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:heath@meetdossie.com';

// Cap individual per-item notifications per org per run so a first-time
// backlog spike (e.g. right after re-baselining) can't flood a device with
// dozens of pushes in one burst — remainder collapses into one summary push.
const MAX_INDIVIDUAL_PUSHES_PER_ORG = 5;

const DOC_TYPE_LABELS = Object.fromEntries(REQUIRED_DOC_TYPES.map((r) => [r.type, r.label]));

const DEADLINE_FLAG_LABELS = {
  past_option_expiration: 'option expiration',
  past_loan_approval_deadline: 'loan approval deadline',
  past_appraisal_deadline: 'appraisal deadline',
  past_survey_deadline: 'survey deadline',
  past_closing_date: 'closing date',
};

function agentLabel(item) {
  return item.agent_name || item.agent_email || 'Unassigned';
}

// Builds the flat list of currently-outstanding risk items from one org's
// rollup, each with a stable risk_key + a specific, actionable notification
// body — never a generic "you have new alerts."
function flattenRiskItems(rollup) {
  const items = [];

  rollup.missing_disclosures.forEach((m) => {
    m.missing_doc_types.forEach((docType) => {
      const label = DOC_TYPE_LABELS[docType] || docType;
      items.push({
        risk_key: `disclosure:${m.transaction_id}:${docType}`,
        category: 'disclosure',
        transaction_id: m.transaction_id,
        title: 'Missing disclosure',
        body: `${agentLabel(m)}'s ${label} on ${m.property_address || 'a dossier'} is missing.`,
      });
    });
  });

  rollup.overdue_action_items.forEach((a) => {
    items.push({
      risk_key: `action_item:${a.action_item_id}`,
      category: 'action_item',
      transaction_id: a.transaction_id,
      title: 'Overdue action item',
      body: `${agentLabel(a)}'s "${a.description}" on ${a.property_address || 'a dossier'} just went overdue — ${a.days_overdue} day${a.days_overdue === 1 ? '' : 's'} overdue (due ${String(a.due_date).slice(0, 10)}).`,
    });
  });

  rollup.deadline_flags.forEach((d) => {
    d.flags.forEach((flag) => {
      const label = DEADLINE_FLAG_LABELS[flag] || flag.replace(/_/g, ' ');
      items.push({
        risk_key: `deadline:${d.transaction_id}:${flag}`,
        category: 'deadline',
        transaction_id: d.transaction_id,
        title: 'Deadline passed',
        body: `${agentLabel(d)}'s ${d.property_address || 'dossier'} just passed its ${label}.`,
      });
    });
  });

  return items;
}

async function sendPush(subscriptions, title, body, tag) {
  const payload = JSON.stringify({
    title: title.slice(0, 100),
    body: body.slice(0, 500),
    data: { url: '/app', tag },
  });

  let sent = 0;
  let failed = 0;
  const removeIds = [];

  await Promise.all(subscriptions.map(async (row) => {
    const pushSub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth_key } };
    try {
      await webpush.sendNotification(pushSub, payload);
      sent += 1;
    } catch (err) {
      failed += 1;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        removeIds.push(row.id);
      }
    }
  }));

  return { sent, failed, removeIds };
}

async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'vapid_env_missing' });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const supabase = getServiceClient();

  const result = {
    orgs_checked: 0,
    orgs_baselined: 0,
    orgs_alerted: 0,
    items_alerted: 0,
    pushes_sent: 0,
    pushes_failed: 0,
    subscriptions_removed: 0,
    errors: [],
  };

  try {
    const { data: orgs, error: orgsErr } = await supabase
      .from('organizations')
      .select('id, name, tier')
      .in('tier', ['team', 'brokerage'])
      .is('archived_at', null);
    if (orgsErr) throw orgsErr;

    for (const org of orgs || []) {
      result.orgs_checked++;
      try {
        const rollup = await buildTeamRiskRollup(supabase, org.id);
        if (!rollup.ok) {
          result.errors.push({ org_id: org.id, error: rollup.error });
          continue;
        }

        const currentItems = flattenRiskItems(rollup);
        const currentKeys = new Set(currentItems.map((i) => i.risk_key));

        // Baseline check — has this org ever been through this cron before?
        const { data: stateRow, error: stateErr } = await supabase
          .from('team_risk_alert_state')
          .select('org_id')
          .eq('org_id', org.id)
          .maybeSingle();
        if (stateErr) throw stateErr;

        if (!stateRow) {
          // First-ever pass for this org: seed the ledger silently, no push.
          if (currentItems.length > 0) {
            const seedRows = currentItems.map((i) => ({
              org_id: org.id,
              risk_key: i.risk_key,
              category: i.category,
              transaction_id: i.transaction_id,
            }));
            const { error: seedErr } = await supabase.from('team_risk_alerts_sent').insert(seedRows);
            if (seedErr) throw seedErr;
          }
          const { error: insStateErr } = await supabase
            .from('team_risk_alert_state')
            .insert({ org_id: org.id });
          if (insStateErr) throw insStateErr;
          result.orgs_baselined++;
          continue;
        }

        // Existing org — figure out which currently-outstanding conditions
        // are NOT already in the ledger (genuinely new), and which ledger
        // rows are for conditions that have since resolved (stale, delete so
        // a future recurrence can alert again).
        const { data: existingRows, error: existingErr } = await supabase
          .from('team_risk_alerts_sent')
          .select('risk_key')
          .eq('org_id', org.id);
        if (existingErr) throw existingErr;

        const existingKeys = new Set((existingRows || []).map((r) => r.risk_key));
        const newItems = currentItems.filter((i) => !existingKeys.has(i.risk_key));
        const staleKeys = [...existingKeys].filter((k) => !currentKeys.has(k));

        if (staleKeys.length > 0) {
          const { error: delErr } = await supabase
            .from('team_risk_alerts_sent')
            .delete()
            .eq('org_id', org.id)
            .in('risk_key', staleKeys);
          if (delErr) throw delErr;
        }

        if (newItems.length === 0) continue;

        // Record the new conditions in the ledger regardless of whether a
        // push actually goes out (org may have zero subscribers yet) — once
        // recorded, they won't re-fire once someone does subscribe.
        const newRows = newItems.map((i) => ({
          org_id: org.id,
          risk_key: i.risk_key,
          category: i.category,
          transaction_id: i.transaction_id,
        }));
        const { error: insErr } = await supabase.from('team_risk_alerts_sent').insert(newRows);
        if (insErr) throw insErr;

        result.items_alerted += newItems.length;

        const { data: subs, error: subsErr } = await supabase
          .from('team_risk_push_subscriptions')
          .select('id, endpoint, p256dh, auth_key')
          .eq('org_id', org.id);
        if (subsErr) throw subsErr;

        if (!subs || subs.length === 0) continue;

        result.orgs_alerted++;

        const individual = newItems.slice(0, MAX_INDIVIDUAL_PUSHES_PER_ORG);
        const overflowCount = newItems.length - individual.length;

        const removeIdSet = new Set();

        for (const item of individual) {
          const { sent, failed, removeIds } = await sendPush(subs, item.title, item.body, item.risk_key);
          result.pushes_sent += sent;
          result.pushes_failed += failed;
          removeIds.forEach((id) => removeIdSet.add(id));
        }

        if (overflowCount > 0) {
          const { sent, failed, removeIds } = await sendPush(
            subs,
            'More team risk alerts',
            `${overflowCount} more new risk item${overflowCount === 1 ? '' : 's'} on ${org.name} — open the Team Dashboard for the full list.`,
            'team-risk-overflow',
          );
          result.pushes_sent += sent;
          result.pushes_failed += failed;
          removeIds.forEach((id) => removeIdSet.add(id));
        }

        if (removeIdSet.size > 0) {
          const ids = [...removeIdSet];
          result.subscriptions_removed += ids.length;
          await supabase.from('team_risk_push_subscriptions').delete().in('id', ids).catch(() => {});
        }

        // Touch last_used_at for subscriptions that received at least one
        // successful push this run — best-effort.
        await supabase
          .from('team_risk_push_subscriptions')
          .update({ last_used_at: new Date().toISOString() })
          .eq('org_id', org.id)
          .catch(() => {});
      } catch (err) {
        result.errors.push({ org_id: org.id, error: err && err.message });
        console.error('[cron-hourly-team-risk-alerts] failed for org', org.id, err && err.message);
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-hourly-team-risk-alerts] fatal:', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message, ...result });
  }
}

module.exports = withTelemetry('cron-hourly-team-risk-alerts', handler);
