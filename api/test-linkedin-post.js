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

  // Victor's content adapted for LinkedIn
  const content = `Victor runs a small team. They do north of 50 deals a year.

He is not anti-TC. He has used transaction coordinators for years. Good ones have been worth every dollar.

But here is the thing he keeps coming back to.

At 50-plus deals a year, the math on TC cost per file is not small. And more than the money, the thing that actually kills productivity is the unpredictability.

Two months ago, a Friday afternoon. Option period ending Monday at 5pm. His TC was unreachable from noon Friday onward. No answer. No out-of-office. Just silence.

He caught it himself at 9pm Friday when he happened to glance at the file. If he had not, Monday morning would have been a problem.

He does not blame the TC for having a life. He blames the system for having a single point of failure.

At his volume, one fumbled option period is not just stress. It is a liability exposure, a client relationship damaged, and potentially a deal gone sideways on a technicality.

He started looking at Dossie recently as a backstop - not to replace his team, but to add a layer that does not go home at noon on Fridays.

Over the last few weeks he has been running files through it alongside his existing setup.

The founding price is $29 a month. For a team doing 50-plus deals a year, that is not even a rounding error. But the operational peace of mind on a Friday afternoon before a Monday TREC deadline is not nothing.

meetdossie.com/founding

For agents running small teams - how are you handling coverage when your TC is unavailable and a deadline is sitting on the table? What does your backup plan actually look like?

#txrealestate #realtorlife #trec`;

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
