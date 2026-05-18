// Vercel Serverless Function: /api/generate-demo-milestones
// Generate milestone cards for demo2 deals using HCTI
// Authorization: Bearer <CRON_SECRET>

const fetch = require('node-fetch');

const HCTI_USER_ID = process.env.HCTI_USER_ID;
const HCTI_API_KEY = process.env.HCTI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const stageData = {
    'under-contract': {
      eyebrow: 'MILESTONE',
      headline: 'Under Contract.',
      subhead: 'Another one in motion.',
    },
    'clear-to-close': {
      eyebrow: 'MILESTONE',
      headline: 'Clear to Close.',
      subhead: 'Stack of paperwork: handled.',
    },
    'closed': {
      eyebrow: 'CLOSED DEAL',
      headline: 'Closed.',
      subhead: 'Keys delivered.',
    },
  };

  const text = stageData[stage];

  // Full 1080x1080 card with inline styles only - no <head>, <style>, or external resources
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
  return data.url;
}

async function downloadImage(url) {
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
}

module.exports = async function handler(req, res) {
  // Auth check
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expectedAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!HCTI_USER_ID || !HCTI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'HCTI credentials not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const milestones = [
    // UNDER-CONTRACT
    { transactionId: '749c9d27-454d-4b2b-ab4c-526623ac4ae8', type: 'under-contract', cityState: 'San Antonio, TX' }, // DEMO-001
    { transactionId: 'ee2a7513-4fb9-479a-9d3e-e320e5d2806a', type: 'under-contract', cityState: 'Boerne, TX' },        // DEMO-002
    { transactionId: '925ce85d-4f26-4e74-80f7-ddaa5ec4863f', type: 'under-contract', cityState: 'San Antonio, TX' }, // DEMO-003
    { transactionId: 'dbb0c7a5-0322-4f5a-a462-a76ed86bf4af', type: 'under-contract', cityState: 'San Antonio, TX' }, // DEMO-004
    { transactionId: '9591944f-3e84-49c8-aa69-764b7eb0d320', type: 'under-contract', cityState: 'Boerne, TX' },        // DEMO-005
    { transactionId: 'a6ebe1af-9ef7-4873-90cb-46675638fdff', type: 'under-contract', cityState: 'San Antonio, TX' }, // DEMO-006
  ];

  const results = [];

  try {
    for (const milestone of milestones) {
      console.log(`[generate-demo-milestones] Generating ${milestone.type} for ${milestone.transactionId.slice(0, 8)}...`);

      // Generate card image via HCTI
      const imageUrl = await generateCardWithHCTI(milestone.type, milestone.cityState);

      // Download and convert to base64 data URL
      const dataUrl = await downloadImage(imageUrl);

      // Insert into database
      await insertMilestone(milestone.transactionId, milestone.type, milestone.cityState, dataUrl);

      results.push({
        transactionId: milestone.transactionId,
        type: milestone.type,
        cityState: milestone.cityState,
        status: 'inserted',
      });

      console.log(`[generate-demo-milestones] ✅ ${milestone.type} for ${milestone.transactionId.slice(0, 8)} inserted`);
    }

    return res.status(200).json({
      ok: true,
      message: 'All milestone cards generated successfully',
      count: results.length,
      results,
    });
  } catch (error) {
    console.error('[generate-demo-milestones] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to generate milestone cards',
      results,
    });
  }
};
