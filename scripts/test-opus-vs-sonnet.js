#!/usr/bin/env node
// Opus vs Sonnet Talk-to-Dossie brain test
// Run: node scripts/test-opus-vs-sonnet.js

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SAMPLE_TESTS = [
  {
    id: 'fe-001',
    category: 'field_extraction',
    severity: 'C',
    description: 'Simple date field update',
    prompt: 'Update the closing date to June 25th',
    expectedKeyword: 'closing_date'
  },
  {
    id: 'rc-001',
    category: 'role_confusion',
    severity: 'C',
    description: 'Buyer/seller assignment',
    prompt: 'The buyer is Michael Chen, seller is Lisa Wong',
    expectedKeyword: 'buyer_name'
  },
  {
    id: 'cr-002',
    category: 'contract_reasoning',
    severity: 'H',
    description: 'Amendment type selection',
    prompt: 'We need to draft an amendment to extend the option period by 3 days',
    expectedKeyword: 'amendment'
  },
  {
    id: 'id-002',
    category: 'intent_disambiguation',
    severity: 'H',
    description: 'Seller-side offer tracking',
    prompt: 'We got a new offer for $425,000 from Robert Johnson',
    expectedKeyword: 'offer'
  },
  {
    id: 'ed-001',
    category: 'email_drafting',
    severity: 'M',
    description: 'Email template selection',
    prompt: 'Draft a welcome email to the buyer',
    expectedKeyword: 'email'
  }
];

async function testModel(model, prompt) {
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 400,
      system: `You are testing action intent extraction. Respond with the action and key fields.`,
      messages: [{ role: 'user', content: prompt }]
    });
    return { success: true, text: response.content[0]?.text || '', model };
  } catch (error) {
    return { success: false, error: error.message, model };
  }
}

async function main() {
  console.log('Starting Opus vs Sonnet test...\n');
  const results = {
    timestamp: new Date().toISOString(),
    tests: [],
    summary: { sonnetPass: 0, opusPass: 0, improvements: 0 }
  };

  for (const test of SAMPLE_TESTS) {
    console.log(`${test.id}: ${test.description}...`);

    const sonnet = await testModel('claude-sonnet-4-6', test.prompt);
    await new Promise(r => setTimeout(r, 200));

    const opus = await testModel('claude-opus-4-7-20250219', test.prompt);
    await new Promise(r => setTimeout(r, 200));

    const sonnetPass = sonnet.success && sonnet.text.toLowerCase().includes(test.expectedKeyword);
    const opusPass = opus.success && opus.text.toLowerCase().includes(test.expectedKeyword);

    if (sonnetPass) results.summary.sonnetPass++;
    if (opusPass) results.summary.opusPass++;
    if (!sonnetPass && opusPass) results.summary.improvements++;

    results.tests.push({
      id: test.id,
      category: test.category,
      description: test.description,
      sonnetPass,
      opusPass,
      improved: !sonnetPass && opusPass
    });

    const icon = !sonnetPass && opusPass ? '✅' : sonnetPass && opusPass ? '✓' : '✗';
    console.log(`  ${icon} S:${sonnetPass ? 'Y' : 'N'} O:${opusPass ? 'Y' : 'N'}\n`);
  }

  // Compute metrics
  const total = SAMPLE_TESTS.length;
  const sonnetRate = (results.summary.sonnetPass / total * 100).toFixed(1);
  const opusRate = (results.summary.opusPass / total * 100).toFixed(1);
  const improvementPct = (results.summary.improvements / total * 100).toFixed(1);

  console.log('=== RESULTS ===');
  console.log(`Sonnet: ${results.summary.sonnetPass}/${total} (${sonnetRate}%)`);
  console.log(`Opus:   ${results.summary.opusPass}/${total} (${opusRate}%)`);
  console.log(`Opus fixes: ${results.summary.improvements} bugs (${improvementPct}%)`);

  const recommendation = improvementPct >= 60 ? 'SHIP_OPUS' : improvementPct >= 40 ? 'MIXED' : 'STAY_SONNET';
  console.log(`Recommendation: ${recommendation}\n`);

  // Stringify results for logging
  console.log(JSON.stringify({
    sonnetPassRate: sonnetRate,
    opusPassRate: opusRate,
    improvementRate: improvementPct,
    recommendation
  }, null, 2));
}

main().catch(console.error);
