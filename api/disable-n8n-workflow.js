// POST /api/disable-n8n-workflow
// Disables the n8n workflow that's marking posts failed
// Auth: Authorization: Bearer ${CRON_SECRET}

const N8N_API_KEY = process.env.N8N_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const WORKFLOW_ID = 'a6RrdAJwVSghHBss';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!N8N_API_KEY) {
    return res.status(500).json({ ok: false, error: 'N8N_API_KEY not configured' });
  }

  try {
    // Step 1: Get current workflow details
    const getResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!getResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to fetch workflow',
        status: getResponse.status,
        statusText: getResponse.statusText,
      });
    }

    const workflow = await getResponse.json();
    const workflowData = workflow.data || workflow;
    const wasActive = workflowData.active;

    // Step 2: Update workflow to set active: false
    workflowData.active = false;

    const updateResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
      method: 'PATCH',
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(workflowData),
    });

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      return res.status(502).json({
        ok: false,
        error: 'Failed to update workflow',
        status: updateResponse.status,
        details: errorText,
      });
    }

    const updated = await updateResponse.json();
    const nowActive = updated.data?.active || updated.active;

    return res.status(200).json({
      ok: true,
      workflowId: WORKFLOW_ID,
      workflowName: workflowData.name || 'unknown',
      wasActive,
      nowActive,
      message: wasActive ? 'Workflow disabled successfully' : 'Workflow was already disabled',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
