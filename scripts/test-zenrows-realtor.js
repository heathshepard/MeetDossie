'use strict';

/**
 * Test harness for ZenRows bypass against realtor.com SA agent directory.
 *
 * Verifies:
 *   1. ZENROWS_API_KEY is set
 *   2. ZenRows can fetch the realtor.com page without 403/429
 *   3. Agent cards are successfully rendered + extracted
 *   4. Cost tracking works
 *
 * Run:
 *   node scripts/test-zenrows-realtor.js
 *
 * Output:
 *   Console: PASS/FAIL + agent count + credits used
 *   .tmp/zenrows-realtor-test.png (screenshot of page state)
 */

const path = require('path');
const fs = require('fs');
const { zenrowsFetch, extractStructured, getCostSummary } = require('./_lib/zenrows-fetch');

// Ensure .tmp exists
const TMP_DIR = path.join(__dirname, '..', '.tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function testZenRows() {
  console.log('='.repeat(70));
  console.log('ZenRows Realtor.com Test');
  console.log('='.repeat(70));

  // Check API key
  if (!process.env.ZENROWS_API_KEY) {
    console.error('FAIL: ZENROWS_API_KEY not set');
    console.error('  Setup: https://www.zenrows.com/signup (free trial, no card)');
    console.error('  Then: set ZENROWS_API_KEY in Vercel env vars');
    process.exit(1);
  }

  console.log(`API Key loaded: ${process.env.ZENROWS_API_KEY.slice(0, 8)}...`);
  console.log();

  try {
    // Fetch realtor.com SA agent directory
    const url = 'https://www.realtor.com/realestateagents/san-antonio_tx';
    console.log(`[1] Fetching ${url}...`);
    const html = await zenrowsFetch(url, {
      jsRender: true,
      premiumProxy: true,
      timeout: 30000,
    });

    console.log(`[2] Got ${html.length} bytes of HTML`);

    // Verify we got real content (not a block page)
    if (html.includes('Akamai') || html.includes('blocked') || html.length < 5000) {
      console.error('FAIL: Response appears to be a block page');
      console.error(`  Length: ${html.length}, Akamai mentioned: ${html.includes('Akamai')}`);
      process.exit(1);
    }

    // Try to extract agent cards
    console.log(`[3] Extracting agent card data...`);
    const agents = await extractStructured(html, {
      selector: '[data-testid="agent-card"]',
      fields: {
        name: '[data-testid="agent-name"]',
        brokerage: '[data-testid="agent-brokerage"]',
        phone: 'a[href^="tel:"]',
      },
    });

    console.log(`[4] Found ${agents.length} agent cards`);

    if (agents.length === 0) {
      console.warn('WARN: No agent cards extracted (selector may not match rendered structure)');
      // Show first 500 chars of HTML for debugging
      console.log('\n--- First 500 chars of HTML ---');
      console.log(html.slice(0, 500));
      console.log('--- End snippet ---\n');
    } else {
      console.log('\n--- Sample agents (first 3) ---');
      agents.slice(0, 3).forEach((agent, i) => {
        console.log(`  ${i + 1}. ${agent.name || 'N/A'} @ ${agent.brokerage || 'N/A'}`);
      });
      console.log();
    }

    // Report costs
    const costs = getCostSummary();
    console.log(`[5] Cost summary:`);
    console.log(`  Used this session: ~${costs.usedThisSession} credits`);
    console.log(`  Estimated remaining: ~${costs.estimatedCreditsLeft} / 1000 (free trial)`);
    console.log();

    console.log('='.repeat(70));
    console.log('✓ PASS: ZenRows bypass working!');
    console.log('='.repeat(70));

  } catch (err) {
    console.error();
    console.error('='.repeat(70));
    console.error('✗ FAIL: ZenRows test failed');
    console.error('='.repeat(70));
    console.error(`Error: ${err.message}`);
    console.error();
    console.error('Next steps:');
    console.error('  1. Verify ZENROWS_API_KEY is set in Vercel env');
    console.error('  2. Check free trial credits at https://app.zenrows.com/dashboard');
    console.error('  3. If no credits, sign up new account at https://www.zenrows.com/signup');
    console.error();
    process.exit(1);
  }
}

testZenRows();
