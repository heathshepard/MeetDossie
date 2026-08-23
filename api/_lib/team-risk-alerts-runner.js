// api/_lib/team-risk-alerts-runner.js
//
// Core logic for real-time push alerts on team risk-triage — split out of
// api/cron-hourly-team-risk-alerts.js so it can be called two ways:
//   1. Directly, as an HTTP endpoint (api/cron-hourly-team-risk-alerts.js —
//      CRON_SECRET-gated, used for manual verification/testing).
//   2. In-process from api/cron-unsubscribe-spike-monitor.js's existing
//      hourly schedule slot (see that file's header comment for why: Vercel
//      hard-caps vercel.json's `crons` array at 100 items and this project
//      was already AT that cap before this feature — adding a 101st
//      top-level cron entry fails deployment outright
//      ("`crons` should NOT have more than 100 items", confirmed live via
//      the Vercel deployment API on the first attempt to ship this,
//      2026-08-23). No existing cron was dead/removable to free a slot
//      (checked: zero vercel.json cron paths point at a missing file). This
//      is the standard way to add a genuinely-new hourly job on a
//      cron-slot-maxed Vercel project: piggyback the call inside an
//      unrelated but already-hourly cron via a direct in-process function
//      call (not a second HTTP round trip), fully isolated in its own
//      try/catch so a failure here can NEVER affect the host cron's own
//      response or behavior.
//
// Additive to api/cron-weekly-team-risk-digest.js's Monday email digest —
// not a replacement. Re-runs the same team-wide risk rollup
// (api/_lib/team-risk-rollup.js) every hour and pushes an instant OS
// notification for any risk condition that is GENUINELY NEW since the last
// check — a deadline that just passed, a disclosure that just went missing,
// an action item that just went overdue.
//
// Dedup: public.team_risk_alerts_sent holds one row per (org_id, risk_key)
// still-outstanding condition; a condition already in that table does not
// re-push. Once resolved, its row is deleted so a future recurrence of the
// SAME condition alerts again rather than being permanently silenced.
//
// Baseline seeding: public.team_risk_alert_state holds one row per org,
// written on that org's first-ever pass. Without it, the very first run for
// an org with pre-existing outstanding risk would treat every already-known
// condition as "new" and flood a burst of pushes for stuff the team lead
// already knows about.
//
// risk_key format (must stay in sync with the shapes buildTeamRiskRollup
// returns):
//   'disclosure:{transaction_id}:{doc_type}'
//   'action_item:{action_item_id}'
//   'deadline:{transaction_id}:{flag}'
//
// Owner: Carter, 2026-08-23 (SV-ENG-TEAM-RISK-PUSH)

const webpush = require('web-push');
const { getServiceClient } = require('./team-auth.js');
const { buildTeamRiskRollup, REQUIRED_DOC_TYPES } = require('./team-risk-rollup.js');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:heath@meetdossie.com';

// Cap individual per-item notifications per org per run so a first-time
// backlog spike can't flood a device with dozens of pushes in one burst —
// remainder collapses into one summary push.
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

async function sendPush(supabase, subscriptions, title, body, tag) {
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

/**
 * Runs one full pass: check every Team/Brokerage org for newly-crossed risk
 * conditions and push instant notifications to subscribed team leads.
 * Never throws for a single org's failure (recorded in result.errors) —
 * only throws for something that would invalidate the whole run (missing
 * VAPID env, the top-level organizations query failing).
 * @returns {Promise<object>} summary counts, same shape whether called via
 *   HTTP or in-process.
 */
async function runHourlyTeamRiskAlerts() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    const err = new Error('vapid_env_missing');
    err.status = 503;
    throw err;
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

      // Baseline check — has this org ever been through this pass before?
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
        const { sent, failed, removeIds } = await sendPush(supabase, subs, item.title, item.body, item.risk_key);
        result.pushes_sent += sent;
        result.pushes_failed += failed;
        removeIds.forEach((id) => removeIdSet.add(id));
      }

      if (overflowCount > 0) {
        const { sent, failed, removeIds } = await sendPush(
          supabase,
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
        await supabase.from('team_risk_push_subscriptions').delete().in('id', ids).then(() => {}, () => {});
      }

      // Touch last_used_at for this org's subscriptions — best-effort.
      await supabase
        .from('team_risk_push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('org_id', org.id)
        .then(() => {}, () => {});
    } catch (err) {
      result.errors.push({ org_id: org.id, error: err && err.message });
      console.error('[team-risk-alerts-runner] failed for org', org.id, err && err.message);
    }
  }

  return result;
}

module.exports = { runHourlyTeamRiskAlerts, flattenRiskItems };
