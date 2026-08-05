#!/usr/bin/env node
// scripts/verify-docuseal-templates.js
//
// Checks every fallbackId in api/esign-templates.js's TEMPLATE_REGISTRY
// against the real, live DocuSeal API — confirms each one still exists, has
// a real name, and reports its field count and submitter roles. Built
// 2026-08-05 after discovering a whole night's worth of assumptions about
// "which templates are actually configured" were wrong because the fallback
// mechanism (registry entries work via env var OR a hardcoded fallbackId)
// wasn't being checked — only Vercel env vars were. Run this instead of
// re-deriving availability from env vars again.
//
// Usage:
//   DOCUSEAL_API_KEY=... node scripts/verify-docuseal-templates.js
//
// Reads DOCUSEAL_API_KEY from the environment, or falls back to parsing it
// out of .env.local if present (same pattern as other local-dev scripts in
// this repo — never commit a real key, this is read-only).

'use strict';

const fs = require('fs');
const path = require('path');

function loadKey() {
  if (process.env.DOCUSEAL_API_KEY) return process.env.DOCUSEAL_API_KEY;
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DOCUSEAL_API_KEY='));
    if (line) return line.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');
  }
  return null;
}

function extractRegistry() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'esign-templates.js'), 'utf8');
  const entries = [];
  const re = /type:\s*'([^']+)'[\s\S]*?label:\s*'([^']+)'[\s\S]*?fallbackId:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    entries.push({ type: m[1], label: m[2], fallbackId: m[3] });
  }
  return entries;
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.error('No DOCUSEAL_API_KEY found in env or .env.local');
    process.exit(1);
  }

  const entries = extractRegistry();
  console.log(`Checking ${entries.length} registry entries against the live DocuSeal API...\n`);

  let ok = 0;
  let bad = 0;

  for (const entry of entries) {
    try {
      const res = await fetch(`https://api.docuseal.com/templates/${entry.fallbackId}`, {
        headers: { 'X-Auth-Token': key },
      });
      if (!res.ok) {
        console.log(`✗ ${entry.type} (${entry.fallbackId}) — HTTP ${res.status}, DEAD`);
        bad += 1;
        continue;
      }
      const data = await res.json();
      const fieldCount = (data.fields || []).length;
      const roles = (data.submitters || []).map((s) => s.name).join(', ');
      console.log(`✓ ${entry.type} (${entry.fallbackId}) — "${data.name}", ${fieldCount} fields, roles: ${roles}`);
      ok += 1;
    } catch (err) {
      console.log(`✗ ${entry.type} (${entry.fallbackId}) — ${err.message}`);
      bad += 1;
    }
  }

  console.log(`\n${ok} live, ${bad} broken, of ${entries.length} registered.`);
  if (bad > 0) process.exit(1);
}

main();
