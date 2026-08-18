// TEMPORARY — staging-only QA aid for the image-claim-match gate
// (api/_lib/verify-image-match.js). Runs the real vision check against
// hardcoded real URLs from today's team-dashboard incident so Carter can
// prove the gate against a live ANTHROPIC_API_KEY without touching real
// social_posts rows. Delete before merging to main.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { checkImageMatchesClaim, gateBeforeApprovalSend, HOLD_STATUS } = require('./_lib/verify-image-match.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: r.ok, status: r.status, data };
}

const REAL_CAPTION = `10 founding agents are already running their transaction files through Dossie - in San Antonio, Houston, Austin, and the RGV.

Every one of them signed up before we'd built half of what's in the app today. That includes the thing that shipped this week: a team dashboard, so a broker or team lead can see every agent's active transactions, deadlines, and stuck files in one screen instead of chasing status updates one text at a time.

That's the actual problem Dossie was built to solve. Not "another checklist app" - a system that runs itself so a file doesn't slip through the cracks because everyone assumed someone else was watching it. No spreadsheet nobody opens after week one. No sticky note that just says "call title company."

We built this because a TC quitting mid-transaction shouldn't mean an agent scrambling to remember what's outstanding on three files at once. It should mean opening one dashboard and knowing exactly where everything stands.

If you're an agent juggling deals solo, or a broker trying to get real visibility into what your team is actually doing day to day, this is worth five minutes of your time.

What's the one thing about tracking transactions across a team that drives you the most crazy? Drop it in the comments - there's a decent chance we already built the fix for it.`;

const WRONG_IMAGE = 'https://meetdossie.com/assets/product/pipeline-dashboard.png';
const RIGHT_IMAGE = 'https://meetdossie.com/assets/product/team-dashboard.jpg';

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.query && req.query.full === '1') {
    // Full end-to-end test: insert a disposable social_posts row with the
    // REAL wrong image + REAL caption, run the actual gateBeforeApprovalSend
    // used by both send paths, confirm it flips status to HOLD_STATUS and
    // sends the plain Telegram alert (labeled TEST so it's unambiguous in
    // Heath's chat), then clean up the disposable row.
    const testId = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
    const insert = await supabaseFetch('/rest/v1/social_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        id: testId,
        post_id: `debug-image-gate-test-${Date.now()}`,
        platform: 'facebook',
        content: `[TEST — image gate QA, safe to ignore] ${REAL_CAPTION}`,
        hook: 'TEST row for image-gate QA',
        status: 'draft',
        persona: 'heath',
        topic: 'team_dashboard_launch',
        media_url: WRONG_IMAGE,
        source_type: 'debug_image_gate_test',
      }]),
    });
    if (!insert.ok) {
      return res.status(500).json({ ok: false, step: 'insert', status: insert.status, body: insert.data });
    }

    const gateResult = await gateBeforeApprovalSend({
      id: testId,
      platform: 'facebook',
      topic: 'team_dashboard_launch',
      content: `[TEST — image gate QA, safe to ignore] ${REAL_CAPTION}`,
      media_url: WRONG_IMAGE,
    });

    const check = await supabaseFetch(`/rest/v1/social_posts?id=eq.${testId}&select=id,status,rejection_reason`);
    const rowAfter = Array.isArray(check.data) ? check.data[0] : null;

    // Cleanup — delete the disposable row either way.
    await supabaseFetch(`/rest/v1/social_posts?id=eq.${testId}`, { method: 'DELETE' }).catch(() => {});

    return res.status(200).json({
      ok: true,
      full_gate_test: {
        gate_returned: gateResult,
        expected_gate_returned: false,
        row_status_after: rowAfter && rowAfter.status,
        expected_row_status: HOLD_STATUS,
        row_rejection_reason: rowAfter && rowAfter.rejection_reason,
        passed: gateResult === false && rowAfter && rowAfter.status === HOLD_STATUS,
      },
    });
  }

  const [mismatch, match] = await Promise.all([
    checkImageMatchesClaim({ mediaUrl: WRONG_IMAGE, caption: REAL_CAPTION }),
    checkImageMatchesClaim({ mediaUrl: RIGHT_IMAGE, caption: REAL_CAPTION }),
  ]);

  return res.status(200).json({ ok: true, mismatch_test: mismatch, match_test: match });
};
