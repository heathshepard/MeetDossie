import { execSync } from 'child_process';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check: Bearer token required
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get commits on staging that aren't on main
    // Format: sha|author|date|message
    const output = execSync(
      `git log main..staging --pretty=format:"%h|%an|%ai|%s" --reverse`,
      { encoding: 'utf-8', cwd: process.cwd() }
    ).trim();

    const commits = output
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const [hash, author, date, message] = line.split('|');
        return {
          hash: hash.trim(),
          author: author.trim(),
          date: new Date(date.trim()).toISOString(),
          message: message.trim(),
        };
      });

    return res.status(200).json(commits);
  } catch (err) {
    console.error('Merge queue error:', err);
    return res.status(200).json([]);
  }
}
