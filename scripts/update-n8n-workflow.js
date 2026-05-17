// Update n8n workflow to fix mediaItems parameter
import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = 'a6RrdAJwVSghHBss';

async function updateWorkflow() {
  // Fetch the workflow from n8n API
  const getResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
    headers: {
      'X-N8N-API-KEY': API_KEY,
    },
  });

  const workflow = await getResponse.json();

  // Find the "Publish to Zernio" node
  const zernioNode = workflow.nodes.find(n => n.name === 'Publish to Zernio');

  if (!zernioNode) {
    console.error('Publish to Zernio node not found!');
    process.exit(1);
  }

  console.log('Found node:', zernioNode.name);
  console.log('Current bodyParameters:', JSON.stringify(zernioNode.parameters.bodyParameters.parameters, null, 2));

  // Fix the mediaItems parameter name
  const params = zernioNode.parameters.bodyParameters.parameters;
  const mediaItemsParam = params.find(p => p.name.includes('mediaItems'));

  if (mediaItemsParam) {
    console.log('Found mediaItems param with name:', mediaItemsParam.name);
    mediaItemsParam.name = 'mediaItems'; // Remove the = prefix
    console.log('Fixed to:', mediaItemsParam.name);
  }

  console.log('Updated bodyParameters:', JSON.stringify(zernioNode.parameters.bodyParameters.parameters, null, 2));

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
    const result = await response.json();
    console.log('Workflow updated successfully!');
    console.log('Response:', JSON.stringify(result, null, 2).slice(0, 500));
  } else {
    const error = await response.text();
    console.error('Error updating workflow:', error);
  }
}

updateWorkflow();
