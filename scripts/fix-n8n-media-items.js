// Fix n8n workflow - revert mediaItems to empty array instead of undefined

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = 'a6RrdAJwVSghHBss';

async function updateWorkflow() {
  // Fetch the workflow
  const getResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
    headers: {
      'X-N8N-API-KEY': API_KEY,
    },
  });

  const workflow = await getResponse.json();
  console.log('✅ Fetched workflow');

  // Find the "Publish to Zernio" node
  const zernioNode = workflow.nodes.find(n => n.name === 'Publish to Zernio');

  if (!zernioNode) {
    console.error('❌ Publish to Zernio node not found!');
    process.exit(1);
  }

  // Find the mediaItems parameter
  const params = zernioNode.parameters.bodyParameters.parameters;
  const mediaItemsParam = params.find(p => p.name === 'mediaItems');

  if (mediaItemsParam) {
    console.log('Current value:', mediaItemsParam.value);

    // Fix: use empty array instead of undefined
    mediaItemsParam.value = '={{ $json.media_url ? [{ url: $json.media_url, type: \'image\' }] : [] }}';

    console.log('New value:', mediaItemsParam.value);
  } else {
    console.error('❌ mediaItems parameter not found!');
    process.exit(1);
  }

  // PUT the updated workflow
  const updatePayload = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: {
      executionOrder: workflow.settings.executionOrder,
    },
  };

  const response = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updatePayload),
  });

  console.log('PUT response status:', response.status, response.statusText);

  if (response.ok) {
    console.log('✅ Workflow updated successfully - mediaItems now uses [] instead of undefined');
  } else {
    const error = await response.text();
    console.error('❌ Error updating workflow:', error);
    process.exit(1);
  }
}

updateWorkflow();
