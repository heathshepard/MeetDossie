// TEMPORARY — staging-only QA aid for the image-claim-match gate
// (api/_lib/verify-image-match.js). Runs the real vision check against
// hardcoded real URLs from today's team-dashboard incident so Carter can
// prove the gate against a live ANTHROPIC_API_KEY without touching real
// social_posts rows. Delete before merging to main.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { checkImageMatchesClaim } = require('./_lib/verify-image-match.js');

const CRON_SECRET = process.env.CRON_SECRET;

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

  const [mismatch, match] = await Promise.all([
    checkImageMatchesClaim({ mediaUrl: WRONG_IMAGE, caption: REAL_CAPTION }),
    checkImageMatchesClaim({ mediaUrl: RIGHT_IMAGE, caption: REAL_CAPTION }),
  ]);

  return res.status(200).json({ ok: true, mismatch_test: mismatch, match_test: match });
};
