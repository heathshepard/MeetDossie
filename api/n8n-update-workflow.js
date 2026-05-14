// POST /api/n8n-update-workflow
// Updates the n8n workflow to add mediaItems parameter
// Auth: Authorization: Bearer ${CRON_SECRET}

const N8N_API_KEY = process.env.N8N_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!N8N_API_KEY) {
    return res.status(500).json({ ok: false, error: 'n8n API key not configured' });
  }

  try {
    // Step 1: List workflows to find "Dossie Social Publisher - Fixed"
    const listResponse = await fetch('https://meetdossie.app.n8n.cloud/api/v1/workflows', {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!listResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to list n8n workflows',
        status: listResponse.status,
        statusText: listResponse.statusText,
      });
    }

    const workflows = await listResponse.json();
    const targetWorkflow = workflows.data?.find(w => w.name === 'Dossie Social Publisher - Fixed');

    if (!targetWorkflow) {
      return res.status(404).json({
        ok: false,
        error: 'Workflow "Dossie Social Publisher" not found',
        available: workflows.data?.map(w => w.name) || [],
      });
    }

    // Step 2: Get the workflow details
    const getResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${targetWorkflow.id}`, {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!getResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to get workflow details',
        status: getResponse.status,
      });
    }

    const workflow = await getResponse.json();

    // Step 3: Find and modify the "Publish to Zernio" node
    // The workflow response has structure: { data: { nodes: [...], ... } }
    const workflowData = workflow.data || workflow;
    const nodes = workflowData.nodes || [];
    const zernioNode = nodes.find(n => n.name === 'Publish to Zernio');

    if (!zernioNode) {
      return res.status(404).json({
        ok: false,
        error: 'Node "Publish to Zernio" not found',
        availableNodes: nodes.map(n => n.name),
        workflowKeys: Object.keys(workflow),
        dataKeys: Object.keys(workflowData),
      });
    }

    // Add mediaItems parameter
    if (!zernioNode.parameters.bodyParameters) {
      zernioNode.parameters.bodyParameters = { parameters: [] };
    }

    const existingParams = zernioNode.parameters.bodyParameters.parameters || [];

    // Remove any existing mediaItems params (including incorrectly named ones like "=mediaItems")
    const cleanedParams = existingParams.filter(p => !p.name.includes('mediaItems'));

    // Add correct mediaItems parameter
    cleanedParams.push({
      name: 'mediaItems',
      value: '={{ $json.media_url ? [{ url: $json.media_url, type: \'image\' }] : [] }}',
    });

    zernioNode.parameters.bodyParameters.parameters = cleanedParams;

    // Step 4: Update the workflow
    const updateResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${targetWorkflow.id}`, {
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

    return res.status(200).json({
      ok: true,
      workflowId: targetWorkflow.id,
      workflowName: targetWorkflow.name,
      nodeUpdated: 'Publish to Zernio',
      parameterAdded: 'mediaItems',
      updated: updated,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
