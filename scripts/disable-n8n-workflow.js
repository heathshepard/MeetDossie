// Disable the n8n workflow that's marking posts failed
// Usage: node scripts/disable-n8n-workflow.js

const N8N_API_KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = 'a6RrdAJwVSghHBss';

if (!N8N_API_KEY) {
  console.error('N8N_API_KEY not set');
  process.exit(1);
}

async function disableWorkflow() {
  try {
    // Step 1: Get current workflow details
    console.log(`Fetching workflow ${WORKFLOW_ID}...`);
    const getResponse = await fetch(`https://meetdossie.app.n8n.cloud/api/v1/workflows/${WORKFLOW_ID}`, {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!getResponse.ok) {
      console.error(`Failed to fetch workflow: ${getResponse.status} ${getResponse.statusText}`);
      const errorText = await getResponse.text();
      console.error('Response:', errorText);
      process.exit(1);
    }

    const workflow = await getResponse.json();
    console.log(`Found workflow: ${workflow.data?.name || workflow.name || 'unknown'}`);
    console.log(`Current active status: ${workflow.data?.active || workflow.active}`);

    // Step 2: Update workflow to set active: false
    const workflowData = workflow.data || workflow;
    workflowData.active = false;

    console.log('\nDisabling workflow...');
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
      console.error(`Failed to update workflow: ${updateResponse.status} ${updateResponse.statusText}`);
      const errorText = await updateResponse.text();
      console.error('Response:', errorText);
      process.exit(1);
    }

    const updated = await updateResponse.json();
    console.log('\n✅ Workflow disabled successfully');
    console.log(`Active status: ${updated.data?.active || updated.active}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

disableWorkflow();
