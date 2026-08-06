// TEMPORARY debug endpoint — Carter, 2026-08-06.
// Runs the real scan-contract pipeline (identifyDocument + auditCompliance +
// scanContract) against an arbitrary PDF, server-side, using the real
// ANTHROPIC_API_KEY already configured in Vercel. Exists only to reproduce
// the false-positive compliance-audit bug against a real executed contract
// without needing end-user auth. Gated behind CRON_SECRET. Remove after the
// scan-contract accuracy fix ships.
//
// POST { pdfBase64 }
// Authorization: Bearer ${CRON_SECRET}

const { runFullScan } = require('./scan-contract.js');

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ ok: false, error: 'pdfBase64 (string) is required.' });
    }
    const result = await runFullScan(pdfBase64);
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('[debug-scan-audit] error:', error && error.message);
    return res.status(500).json({ ok: false, error: error && error.message });
  }
};
