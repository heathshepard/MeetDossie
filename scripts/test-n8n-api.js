// Test different n8n API paths
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2YjA1YzhlYS1iMGU0LTRmNzMtYjZlYy0zYjYyZjI2NWRlODAiLCJpc3MiOiJuOG4iLCJhdWQiOiJtY3Atc2VydmVyLWFwaSIsImp0aSI6ImQ3MzY2ZjE4LTNiYjQtNDJhMC1hZDZhLWU3ZDNhNGU1MDllYiIsImlhdCI6MTc3ODc4NDM4Nn0.hPf1R7_iOE8RUnBG1AfwjCsiyywgV8zGtpHP0pKWv2k';

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
