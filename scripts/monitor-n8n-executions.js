// Monitor n8n executions for 5 minutes and report results

const N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2YjA1YzhlYS1iMGU0LTRmNzMtYjZlYy0zYjYyZjI2NWRlODAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMDk5NTQzMDktMzdmOC00YjhkLTk1NDctODBkZjk0MTQ4YTU0IiwiaWF0IjoxNzc4Nzg4ODQxfQ.J3BzOO2nXZw3xq2vOlSeB88um35Amkka4O05sVTBk8o';
const WORKFLOW_ID = 'a6RrdAJwVSghHBss';

let lastExecutionId = null;

async function checkExecutions() {
  const res = await fetch(
    `https://meetdossie.app.n8n.cloud/api/v1/executions?workflowId=${WORKFLOW_ID}&limit=5`,
    {
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
      },
    }
  );

  const data = await res.json();
  const executions = data.data || [];

  for (const exec of executions) {
    if (exec.id === lastExecutionId) break;

    const timestamp = new Date(exec.startedAt).toLocaleTimeString();
    console.log(`\n[${timestamp}] Execution ${exec.id}:`);
    console.log(`  Status: ${exec.status}`);
    console.log(`  Mode: ${exec.mode}`);
    console.log(`  Started: ${exec.startedAt}`);
    console.log(`  Stopped: ${exec.stoppedAt || 'running'}`);
  }

  if (executions.length > 0 && !lastExecutionId) {
    lastExecutionId = executions[0].id;
    console.log(`Tracking from execution ${lastExecutionId}`);
  }
}

async function checkPostStatus() {
  const res = await fetch('https://meetdossie.com/api/social-diagnostic');
  const data = await res.json();

  console.log('\n=== Post Status ===');
  console.log('Daily caps:');
  Object.entries(data.daily_caps.caps).forEach(([platform, cap]) => {
    console.log(`  ${platform}: ${cap.count}/${cap.limit} posted (${cap.remaining} remaining)`);
  });

  console.log('\nPosts by status:');
  Object.entries(data.todays_posts.by_status).forEach(([status, count]) => {
    if (count > 0) {
      console.log(`  ${status}: ${count}`);
    }
  });
}

async function monitor() {
  console.log('Starting 5-minute monitoring...\n');

  const startTime = Date.now();
  const duration = 5 * 60 * 1000; // 5 minutes
  const interval = 30 * 1000; // 30 seconds

  while (Date.now() - startTime < duration) {
    await checkExecutions();
    await checkPostStatus();

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.round((duration - (Date.now() - startTime)) / 1000);
    console.log(`\n--- ${elapsed}s elapsed, ${remaining}s remaining ---`);

    if (Date.now() - startTime < duration) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  console.log('\n=== Final Status ===');
  await checkPostStatus();
}

monitor();
