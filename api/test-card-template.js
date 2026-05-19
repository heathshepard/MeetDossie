/**
 * Test the fixed card template
 *
 * Run: node api/test-card-template.js
 *
 * Then manually check the output URL to verify:
 * - Large stat in coral #E8836B
 * - Stat label below in navy
 * - Vertical CORAL accent line on left side (not gold, not sage)
 * - Body copy with good hierarchy
 * - "Founding · N spots left" badge at bottom in gold
 * - meetdossie.com/founding URL in sage
 * - Blush background #F5E6E0
 */

const fetch = require('node-fetch');

async function testCardTemplate() {
  const CRON_SECRET = process.env.CRON_SECRET;

  if (!CRON_SECRET) {
    console.error('ERROR: CRON_SECRET not set. Load from .env.local');
    process.exit(1);
  }

  const testPost = {
    platform: 'instagram',
    post_id: 'test-card-template-' + Date.now(),
    stat: '$400/file',
    stat_label: 'More than my car payment',
    content: 'Every follow-up. Every deadline. Every lender intro. She handles it.',
    persona: 'brenda',
  };

  console.log('Testing card template with sample post...');
  console.log('Expected template:');
  console.log('- Large stat in CORAL #E8836B');
  console.log('- Stat label in NAVY');
  console.log('- Vertical CORAL accent line on left side (4px)');
  console.log('- Body text in NAVY with line-height 1.65');
  console.log('- GOLD founding badge at bottom');
  console.log('- SAGE URL (meetdossie.com/founding)');
  console.log('- BLUSH background #F5E6E0');
  console.log('');

  try {
    const response = await fetch('https://meetdossie.com/api/generate-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify(testPost),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('ERROR:', data.error || 'Unknown error');
      process.exit(1);
    }

    console.log('SUCCESS!');
    console.log('Card URL:', data.publicUrl);
    console.log('Size:', data.size_bytes, 'bytes');
    console.log('Storage path:', data.storage_path);
    console.log('');
    console.log('Manual verification checklist:');
    console.log('[ ] Stat is large, in coral color');
    console.log('[ ] Stat label is smaller, navy color');
    console.log('[ ] Vertical accent line on left is CORAL (not gold/sage)');
    console.log('[ ] Body text is readable, good spacing');
    console.log('[ ] Founding badge is gold with white text');
    console.log('[ ] URL is sage green');
    console.log('[ ] Background is blush');
    console.log('[ ] Overall matches the "$400/file" good template');
  } catch (error) {
    console.error('FETCH ERROR:', error.message);
    process.exit(1);
  }
}

testCardTemplate();
