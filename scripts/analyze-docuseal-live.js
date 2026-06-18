#!/usr/bin/env node
/**
 * Analyze the live DocuSeal template to extract field structure by submitter.
 */

const fs = require('fs');
const path = require('path');

const templateId = process.argv[2] || '4018208';
const filePath = path.join(__dirname, `.docuseal-fields-live-${templateId}.json`);

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Build a map of submitter UUID to name
const submitterMap = {};
schema.submitters.forEach(sub => {
  submitterMap[sub.uuid] = sub.name;
});

// Group fields by submitter
const fieldsBySubmitter = {};
schema.submitters.forEach(sub => {
  fieldsBySubmitter[sub.name] = [];
});

schema.fields.forEach(field => {
  const submitterName = submitterMap[field.submitter_uuid];
  if (submitterName) {
    fieldsBySubmitter[submitterName].push(field.name);
  }
});

console.log(`\n=== DocuSeal Template ${templateId} ===`);
console.log(`Name: ${schema.template_name}`);
console.log(`Total fields: ${schema.field_count}`);
console.log(`Submitters: ${schema.submitters.length}\n`);

Object.entries(fieldsBySubmitter).forEach(([name, fields]) => {
  console.log(`${name}: ${fields.length} fields`);
  fields.forEach(f => console.log(`  - ${f}`));
  console.log();
});

// Export summary as JSON
const summary = {
  template_id: templateId,
  template_name: schema.template_name,
  total_fields: schema.field_count,
  fields_by_submitter: fieldsBySubmitter,
};

const outputPath = path.join(__dirname, `.docuseal-summary-${templateId}.json`);
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(`Summary saved to: ${outputPath}`);

