export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check: Bearer token required
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fail-fast: GITHUB_TOKEN must be configured
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({
      error: 'github_token_missing',
      message: 'GITHUB_TOKEN env var not configured in Vercel'
    });
  }

  try {
    // Use GitHub API to get commits between main and staging
    const ghResp = await fetch(
      'https://api.github.com/repos/heathshepard/MeetDossie/compare/main...staging',
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        },
      }
    );

    // Check response status and surface errors instead of silencing
    if (!ghResp.ok) {
      const body = await ghResp.text();
      console.error('GitHub API error:', ghResp.status, body);
      return res.status(502).json({
        error: 'github_upstream_failed',
        status: ghResp.status,
        detail: body.slice(0, 200)
      });
    }

    const data = await ghResp.json();
    const commits = (data.commits || []).map(c => ({
      hash: c.sha.slice(0, 7),
      author: c.commit.author.name,
      date: c.commit.author.date,
      message: c.commit.message.split('\n')[0],
    }));

    return res.status(200).json(commits);
  } catch (err) {
    console.error('Merge queue error:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: err.message
    });
  }
}
