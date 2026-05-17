// Test different n8n API paths
const token = process.env.N8N_API_KEY;

const paths = [
  'https://meetdossie.app.n8n.cloud/api/v1/workflows',
  'https://meetdossie.app.n8n.cloud/rest/workflows',
  'https://meetdossie.app.n8n.cloud/api/workflows',
  'https://meetdossie.app.n8n.cloud/workflows',
];

async function testPaths() {
  for (const path of paths) {
    try {
      const res = await fetch(path, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });
      console.log(`${path}: ${res.status} ${res.statusText}`);
      if (res.ok) {
        const data = await res.json();
        console.log('Success! Data:', JSON.stringify(data, null, 2).slice(0, 500));
        break;
      }
    } catch (error) {
      console.log(`${path}: ERROR - ${error.message}`);
    }
  }
}

testPaths();
