// POST /api/n8n-trigger-workflow
// Triggers an n8n workflow by ID
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { workflow_id: "string" }

const N8N_MCP_TOKEN = process.env.N8N_MCP_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { workflow_id } = req.body || {};

  if (!workflow_id) {
    return res.status(400).json({ ok: false, error: 'Missing required field: workflow_id' });
  }

  if (!N8N_MCP_TOKEN) {
    return res.status(500).json({ ok: false, error: 'n8n MCP token not configured' });
  }

  try {
    // Trigger workflow via n8n API
    const n8nApiUrl = `https://meetdossie.app.n8n.cloud/api/v1/workflows/${workflow_id}/execute`;

    const response = await fetch(n8nApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${N8N_MCP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const responseData = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: 'n8n API error',
        status: response.status,
        details: responseData,
      });
    }

    return res.status(200).json({
      ok: true,
      execution_id: responseData.data?.id || responseData.id || null,
      status: responseData.data?.status || responseData.status || 'triggered',
      workflow_id,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
