// Initialize Shepard Studio database tables
// Run with: node scripts/init-studio-db.js

require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  console.error('\nYou can also run the SQL manually:');
  console.error('1. Go to Supabase Dashboard > SQL Editor');
  console.error('2. Open scripts/create-studio-tables.sql');
  console.error('3. Copy and paste the entire file');
  console.error('4. Click "Run"\n');
  process.exit(1);
}

async function main() {
  console.log('Shepard Studio Database Setup');
  console.log('==============================\n');
  console.log('To initialize the database, please:');
  console.log('1. Go to https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/editor');
  console.log('2. Click "SQL Editor" in the left sidebar');
  console.log('3. Click "New query"');
  console.log('4. Copy the contents of scripts/create-studio-tables.sql');
  console.log('5. Paste into the SQL Editor');
  console.log('6. Click "Run" or press Cmd/Ctrl+Enter\n');
  console.log('The SQL file is located at:');
  console.log(path.join(__dirname, 'create-studio-tables.sql'));
  console.log('\nThis will create:');
  console.log('- organization_tasks table (task pipeline)');
  console.log('- studio_messages table (chat history)');
  console.log('- studio_agents table (agent workforce)');
  console.log('- studio_products table (product portfolio)');
  console.log('- RLS policies (restrict to heath.shepard@kw.com)');
  console.log('- Seed data (4 agents + Dossie product)\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
