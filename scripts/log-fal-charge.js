#!/usr/bin/env node

/**
 * Log fal.ai $20 charge to ledger
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local or environment
 * Usage: node scripts/log-fal-charge.js [--date YYYY-MM-DD] [--amount 20.00] [--description "..."]
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env vars
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) process.env[key.trim()] = value.trim();
  });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

// Parse arguments
const args = process.argv.slice(2);
let date = new Date().toISOString().split('T')[0];
let amount = 20.00;
let description = 'Top-up for Kling/Runway/Flux video generation (orbital orb + future Cole UI prototyping)';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date') date = args[++i];
  if (args[i] === '--amount') amount = parseFloat(args[++i]);
  if (args[i] === '--description') description = args[++i];
}

const supabase = createClient(supabaseUrl, supabaseKey);

(async () => {
  try {
    console.log(`Logging expense: $${amount} on ${date}`);

    const { data, error } = await supabase
      .from('ledger_entries')
      .insert({
        date,
        type: 'expense',
        amount: -Math.abs(amount),
        currency: 'USD',
        category: 'AI infrastructure',
        vendor: 'fal.ai',
        description,
        entity: 'shepard_ventures',
        source: 'manual',
      })
      .select();

    if (error) {
      console.error('ERROR:', error.message);
      process.exit(1);
    }

    console.log('SUCCESS: Expense logged');
    console.log(JSON.stringify(data[0], null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
