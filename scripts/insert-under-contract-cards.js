// Local script: Insert under-contract milestone cards for demo2 deals
// Run: node scripts/insert-under-contract-cards.js

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Read .env.local file manually
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)="?([^"]+)"?$/);
  if (match) {
    envVars[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
});

const HCTI_USER_ID = envVars.HCTI_USER_ID;
const HCTI_API_KEY = envVars.HCTI_API_KEY;
const SUPABASE_URL = envVars.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;

const USER_ID = 'e8108121-d8d8-41af-b662-b99549792b29'; // demo2@meetdossie.com

const BRAND = {
  blushLight: '#F5EDE4',
  blush: '#F5EDE4',
  blushDeep: '#D4A0A0',
  navy: '#1A1A2E',
  gold: '#C9A96E',
  goldDeep: '#A48531',
  textSoft: '#7A7468',
};

function buildMilestoneCardHTML(stage, cityState) {
  const text = {
    eyebrow: 'MILESTONE',
    headline: 'Under Contract.',
    subhead: 'Another one in motion.',
  };

  // Full 1080x1080 card with inline styles only
  return `<div style="background:linear-gradient(135deg,#F5EDE4 0%,#FFFFFF 60%,#FFFFFF 100%);width:1080px;height:1080px;position:relative;border:4px solid #C9A96E;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;padding:32px;font-family:Georgia,serif;">
  <div style="margin-top:160px;font-size:28px;font-weight:bold;color:#A48531;letter-spacing:2px;text-align:center;">${text.eyebrow}</div>
  <div style="margin-top:30px;font-size:180px;font-weight:bold;color:#1A1A2E;line-height:0.9;text-align:center;">${text.headline}</div>
  <div style="margin-top:40px;font-size:52px;font-style:italic;color:#D4A0A0;text-align:center;">${text.subhead}</div>
  <div style="margin-top:100px;font-size:72px;font-weight:600;color:#1A1A2E;text-align:center;">${cityState}</div>
  <div style="position:absolute;bottom:80px;left:80px;right:80px;display:flex;justify-content:space-between;align-items:center;">
    <div>
      <div style="font-size:20px;color:#7A7468;margin-bottom:8px;">Handled by Dossie</div>
      <div style="font-size:18px;font-weight:bold;color:#A48531;">meetdossie.com/founding</div>
    </div>
    <div style="width:110px;height:110px;border-radius:50%;background:#C9A96E;display:flex;align-items:center;justify-content:center;border:3px solid white;">
      <div style="font-size:70px;font-weight:bold;color:white;">D</div>
    </div>
  </div>
</div>`.trim();
}

async function generateCardWithHCTI(stage, cityState) {
  const html = buildMilestoneCardHTML(stage, cityState);
  const auth = Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64');

  console.log(`  Generating card via HCTI...`);
  const response = await fetch('https://hcti.io/v1/image', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ html }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HCTI failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  console.log(`  Card generated: ${data.url}`);
  return data.url;
}

async function downloadImage(url) {
  console.log(`  Downloading image...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString('base64');
  return `data:image/png;base64,${base64}`;
}

async function insertMilestone(transactionId, milestoneType, cityState, canvasDataUrl) {
  console.log(`  Inserting into database...`);
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/dossier_milestones`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        user_id: USER_ID,
        transaction_id: transactionId,
        milestone_type: milestoneType,
        city_state: cityState,
        canvas_data_url: canvasDataUrl,
        created_at: new Date().toISOString(),
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Insert failed: ${response.status} ${text}`);
  }
  console.log(`  ✓ Inserted successfully`);
}

async function main() {
  if (!HCTI_USER_ID || !HCTI_API_KEY) {
    throw new Error('HCTI credentials not configured in .env.local');
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured in .env.local');
  }

  const milestones = [
    { transactionId: '749c9d27-454d-4b2b-ab4c-526623ac4ae8', cityState: 'San Antonio, TX' }, // DEMO-001
    { transactionId: 'ee2a7513-4fb9-479a-9d3e-e320e5d2806a', cityState: 'Boerne, TX' },        // DEMO-002
    { transactionId: '925ce85d-4f26-4e74-80f7-ddaa5ec4863f', cityState: 'San Antonio, TX' }, // DEMO-003
    { transactionId: 'dbb0c7a5-0322-4f5a-a462-a76ed86bf4af', cityState: 'San Antonio, TX' }, // DEMO-004
    { transactionId: '9591944f-3e84-49c8-aa69-764b7eb0d320', cityState: 'Boerne, TX' },        // DEMO-005
    { transactionId: 'a6ebe1af-9ef7-4873-90cb-46675638fdff', cityState: 'San Antonio, TX' }, // DEMO-006
  ];

  console.log(`\nInserting under-contract milestone cards for ${milestones.length} deals...\n`);

  let successCount = 0;
  let failCount = 0;

  for (const milestone of milestones) {
    const shortId = milestone.transactionId.slice(0, 8);
    console.log(`[${shortId}] ${milestone.cityState}`);

    try {
      // Generate card image via HCTI
      const imageUrl = await generateCardWithHCTI('under-contract', milestone.cityState);

      // Download and convert to base64 data URL
      const dataUrl = await downloadImage(imageUrl);

      // Insert into database
      await insertMilestone(milestone.transactionId, 'under-contract', milestone.cityState, dataUrl);

      successCount++;
      console.log('');
    } catch (error) {
      failCount++;
      console.error(`  ✗ Failed: ${error.message}\n`);
    }
  }

  console.log(`\nComplete: ${successCount} succeeded, ${failCount} failed\n`);
}

main().catch(console.error);
