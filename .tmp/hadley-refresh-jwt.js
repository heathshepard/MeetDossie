#!/usr/bin/env node
// Hadley: mint a fresh JWT for demo user via Supabase admin API.
// Uses SUPABASE_SERVICE_ROLE_KEY to generate a magic-link-style JWT (no password needed).
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3'; // demo@meetdossie.com

if (!SUPABASE_URL || !SVC) { console.error('missing env'); process.exit(1); }

(async () => {
  // Generate a signed-in session using GoTrue admin API: generate_link + verify magiclink
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'magiclink',
      email: 'demo@meetdossie.com',
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('generate_link failed', r.status, JSON.stringify(j)); process.exit(1); }
  // Extract hashed_token
  const token = j.properties?.hashed_token || j.hashed_token;
  if (!token) { console.error('no hashed_token in response', JSON.stringify(j).slice(0,300)); process.exit(1); }
  // Try token_hash form (newer GoTrue)
  const r2 = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: SVC,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', token_hash: token }),
  });
  const j2 = await r2.json();
  if (!r2.ok) { console.error('verify failed', r2.status, JSON.stringify(j2).slice(0,300)); process.exit(1); }
  const jwt = j2.access_token;
  if (!jwt) { console.error('no access_token', JSON.stringify(j2).slice(0,300)); process.exit(1); }
  const outPath = path.join(__dirname, 'dossie-sign-e2e-loop', 'jwt.txt');
  fs.writeFileSync(outPath, jwt);
  console.log('wrote', outPath, 'len=', jwt.length);
})().catch(e => { console.error(e.stack||e.message); process.exit(1); });
