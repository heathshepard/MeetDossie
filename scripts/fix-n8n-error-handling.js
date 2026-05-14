// Fix n8n workflow error handling
// 1. Update IF node to handle both response shapes
// 2. Update Mark Failed node to capture full error

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2YjA1YzhlYS1iMGU0LTRmNzMtYjZlYy0zYjYyZjI2NWRlODAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMDk5NTQzMDktMzdmOC00YjhkLTk1NDctODBkZjk0MTQ4YTU0IiwiaWF0IjoxNzc4Nzg4ODQxfQ.J3BzOO2nXZw3xq2vOlSeB88um35Amkka4O05sVTBk8o';
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

  // 1. Fix "Check Success" IF node
  const ifNode = workflow.nodes.find(n => n.name === 'Check Success');
  if (ifNode) {
    console.log('\n=== Fixing Check Success IF node ===');
    console.log('Old condition:', ifNode.parameters.conditions.conditions[0].leftValue);

    // Update to handle both response shapes
    ifNode.parameters.conditions.conditions[0].leftValue = '={{ $json.message === "Post published successfully" || $json.status === "published" }}';
    ifNode.parameters.conditions.conditions[0].rightValue = 'true';
    ifNode.parameters.conditions.conditions[0].operator.operation = 'equals';

    console.log('New condition:', ifNode.parameters.conditions.conditions[0].leftValue);
  } else {
    console.error('❌ Check Success node not found!');
  }

  // 2. Fix "Mark Failed" node error_message parameter
  const markFailedNode = workflow.nodes.find(n => n.name === 'Mark Failed');
  if (markFailedNode) {
    console.log('\n=== Fixing Mark Failed error_message ===');
    const errorParam = markFailedNode.parameters.bodyParameters.parameters.find(p => p.name === 'error_message');
    if (errorParam) {
      console.log('Old value:', errorParam.value);

      // Update to capture full error regardless of shape
      errorParam.value = '={{ $json.error?.message || $json.message || $json.error || \'Unknown error\' }}';

      console.log('New value:', errorParam.value);
    }
  } else {
    console.error('❌ Mark Failed node not found!');
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

  console.log('\nPUT response status:', response.status, response.statusText);

  if (response.ok) {
    console.log('✅ Workflow updated successfully');
    console.log('\nChanges:');
    console.log('1. IF node now checks: message === "Post published successfully" || status === "published"');
    console.log('2. Mark Failed now captures: error?.message || message || error || "Unknown error"');
  } else {
    const error = await response.text();
    console.error('❌ Error updating workflow:', error);
    process.exit(1);
  }
}

updateWorkflow();
