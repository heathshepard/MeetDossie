#!/usr/bin/env node
/**
 * Build a comprehensive KEY_MAP for resale-contract (4018208).
 * Maps our internal snake_case field names to DocuSeal labels from the live template.
 *
 * Strategy:
 * 1. Read the live field schema from .docuseal-fields-live-4018208.json
 * 2. Group DocuSeal labels by submitter
 * 3. For each DocuSeal label, determine the corresponding internal key
 * 4. Output a KEY_MAP as JavaScript code
 */

const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '.docuseal-fields-live-4018208.json');
if (!fs.existsSync(schemaPath)) {
  console.error('Schema file not found:', schemaPath);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// Build submitter name -> uuid map
const submitterMap = {};
schema.submitters.forEach(sub => {
  submitterMap[sub.name] = sub.uuid;
});

console.log('\n=== RESALE CONTRACT (4018208) — COMPREHENSIVE KEY_MAP ===\n');
console.log('Submitters:');
Object.entries(submitterMap).forEach(([name, uuid]) => {
  console.log(`  ${name}: ${uuid}`);
});

// Group fields by submitter
const fieldsBySubmitter = {};
schema.submitters.forEach(sub => {
  fieldsBySubmitter[sub.name] = [];
});

schema.fields.forEach(field => {
  const submitterName = Object.entries(submitterMap).find(([_, uuid]) => uuid === field.submitter_uuid)?.[0];
  if (submitterName) {
    fieldsBySubmitter[submitterName].push(field);
  }
});

// Now output the mapping strategy
console.log('\n=== FIELD COUNTS BY SUBMITTER ===\n');
Object.entries(fieldsBySubmitter).forEach(([name, fields]) => {
  console.log(`${name}: ${fields.length} fields`);
});

// Generate the mapping table
console.log('\n=== MAPPING TABLE (for verification) ===\n');
console.log('internal_key | docuseal_label | submitter\n');

// For now, just list all DocuSeal labels so we can manually assign them
const allLabels = [];
schema.fields.forEach(field => {
  const submitterName = Object.entries(submitterMap).find(([_, uuid]) => uuid === field.submitter_uuid)?.[0];
  allLabels.push({
    label: field.name,
    submitter: submitterName,
    type: field.type,
  });
});

// Group by submitter for output
const labelsBySubmitter = {};
schema.submitters.forEach(sub => {
  labelsBySubmitter[sub.name] = [];
});

allLabels.forEach(item => {
  labelsBySubmitter[item.submitter].push(item);
});

Object.entries(labelsBySubmitter).forEach(([submitter, labels]) => {
  console.log(`\n=== ${submitter} (${labels.length} fields) ===\n`);
  labels.forEach(l => {
    // Try to infer the internal key from the label
    const inferredKey = l.label.toLowerCase().replace(/[_\s-]/g, '_');
    console.log(`${inferredKey} | ${l.label} | ${l.type}`);
  });
});

