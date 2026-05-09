/**
 * /api/generate-card
 *
 * Node.js serverless function that spawns scripts/render-card.py as a child
 * process to generate social cards. Replaces the broken Python serverless
 * approach (/api/render-card).
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Method: POST
 * Body: {
 *   platform: "instagram" | "facebook",
 *   post_id: string,
 *   hook?: string,
 *   content?: string,
 *   persona?: "brenda" | "patricia" | "victor",
 *   stat?: string,
 *   stat_label?: string
 * }
 * Response: { ok: true, publicUrl: string, ... } or { ok: false, error: string }
 */

const { spawn } = require('child_process');
const path = require('path');

module.exports = async (req, res) => {
  // Auth check
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expectedAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { platform, post_id, hook, content, persona, stat, stat_label } = req.body || {};

  // Basic validation
  if (!platform || !['instagram', 'facebook'].includes(platform)) {
    return res.status(400).json({ ok: false, error: 'platform must be instagram or facebook' });
  }
  if (!post_id) {
    return res.status(400).json({ ok: false, error: 'post_id required' });
  }
  if (!content && !hook && !stat) {
    return res.status(400).json({ ok: false, error: 'content, hook, or stat required' });
  }

  // Build input JSON for Python script
  const input = JSON.stringify({
    platform,
    post_id,
    hook: hook || '',
    content: content || '',
    persona: persona || null,
    stat: stat || '',
    stat_label: stat_label || '',
  });

  // Spawn Python script
  // Note: Vercel serverless functions run in /var/task on AWS Lambda
  // The working directory is the project root
  // Use 'python' not 'python3' - Vercel runtime provides python symlink
  const scriptPath = path.join(process.cwd(), 'scripts', 'render-card.py');
  const python = spawn('python', [scriptPath, input], {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1', // Ensure stdout is not buffered
    },
  });

  let stdout = '';
  let stderr = '';

  python.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  python.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  python.on('close', (code) => {
    if (code !== 0) {
      // Python script failed
      let error = 'render-card.py failed';
      try {
        const parsed = JSON.parse(stderr);
        error = parsed.error || error;
      } catch {
        error = stderr.slice(0, 500) || error;
      }
      return res.status(500).json({ ok: false, error, exit_code: code });
    }

    // Success — parse stdout JSON
    try {
      const result = JSON.parse(stdout.trim());
      if (!result.ok) {
        return res.status(500).json(result);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: `Failed to parse Python output: ${e.message}`,
        stdout: stdout.slice(0, 500),
      });
    }
  });

  python.on('error', (err) => {
    return res.status(500).json({
      ok: false,
      error: `Failed to spawn Python: ${err.message}`,
    });
  });
};
