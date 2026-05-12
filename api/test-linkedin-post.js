// Temporary test endpoint to publish to LinkedIn via Zernio
// DELETE THIS FILE after testing

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured' });
  }

  // Test post - Patricia's content adapted for LinkedIn
  const content = `Here is a question Patricia started asking herself a few months ago.

If her TC misses a deadline on one deal - just one - what does that actually cost her?

She does around 10 to 12 deals a year. She also works a day job. Real estate is not her only income but it is real income, and she treats it like a business even if it is not her full-time one.

The deal she almost lost last spring came down to a TREC deadline that slipped through the cracks on a Friday afternoon. Her TC was unreachable. Patricia found out Monday morning when the other agent called her directly.

She spent that whole weekend stressed about a file she thought was covered. She checked her email obsessively at family dinner. She woke up at 2am Saturday to send a follow-up message she knew would not get answered until Monday.

The math for someone doing 10 to 12 deals a year is pretty simple. One lost deal because of a missed deadline costs more than a year of almost any tool she could buy.

She does not need anything fancy. She needs something that does not go quiet on a Friday afternoon when there is a TREC deadline on Monday.

She started using Dossie recently and has been running her active files through it over the last few weeks. It is not magic. It is just consistent - which turns out to be the thing her TC was not.

Founding member pricing is $29 a month. Locked as long as the subscription stays active. For someone doing 10 deals a year, that pays for itself fast.

meetdossie.com/founding

For the part-time agents in here - how do you handle transaction coverage when you are also juggling a full-time job? Curious what people are actually doing.

#txrealestate #realtorlife #trec #transactioncoordinator #realestateagent`;

  const linkedinAccountId = '69fccd7392b3d8e85f8f12be';

  try {
    const postRes = await fetch('https://zernio.com/api/v1/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platforms: [
          {
            platform: 'linkedin',
            accountId: linkedinAccountId,
          }
        ],
        content,
        scheduledFor: new Date().toISOString(),
      }),
    });

    const text = await postRes.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }

    return res.status(postRes.status).json({
      ok: postRes.ok,
      status: postRes.status,
      data,
      rawText: text.slice(0, 1000),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
