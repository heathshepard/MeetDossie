#!/usr/bin/env node
/**
 * Fetch the live field structure from DocuSeal for a template.
 * Usage: node scripts/fetch-docuseal-template-fields.js <template_id>
 * Example: node scripts/fetch-docuseal-template-fields.js 4018208
 * Outputs: .docuseal-fields-live-[template_id].json
 */

const fs = require('fs');
const https = require('https');

const apiKey = process.env.DOCUSEAL_API_KEY;
if (!apiKey) {
  console.error('Error: DOCUSEAL_API_KEY environment variable not set');
  process.exit(1);
}

const templateId = process.argv[2];
if (!templateId) {
  console.error('Usage: node fetch-docuseal-template-fields.js <template_id>');
  process.exit(1);
}

async function fetchTemplate() {
  return new Promise((resolve, reject) => {
    const url = `https://api.docuseal.com/templates/${templateId}`;

    const options = {
      headers: {
        'X-Auth-Token': apiKey,
      },
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Status ${res.statusCode}: ${data}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    console.log(`Fetching template ${templateId}...`);
    const template = await fetchTemplate();

    // Extract the schema
    const schema = {
      template_id: templateId,
      template_name: template.name || 'Unknown',
      created_at: template.created_at,
      updated_at: template.updated_at,
      submitters: template.submitters || [],
      fields: template.fields || [],
      field_count: (template.fields || []).length,
    };

    // Build field list with submitter scoping
    const fieldsBySubmitter = {};
    if (template.fields) {
      template.fields.forEach(field => {
        const submitter = field.submitter_id;
        if (!fieldsBySubmitter[submitter]) {
          fieldsBySubmitter[submitter] = [];
        }
        fieldsBySubmitter[submitter].push({
          name: field.name,
          type: field.type,
          position: field.position,
          default_value: field.default_value,
          required: field.required,
          submitter_id: field.submitter_id,
        });
      });
    }

    schema.fields_by_submitter = fieldsBySubmitter;

    const outputPath = `scripts/.docuseal-fields-live-${templateId}.json`;
    fs.writeFileSync(outputPath, JSON.stringify(schema, null, 2));
    console.log(`\nTemplate schema saved to: ${outputPath}`);
    console.log(`Total fields: ${schema.field_count}`);
    console.log(`Submitters: ${schema.submitters.length}`);
    console.log('\nSubmitter breakdown:');
    schema.submitters.forEach(sub => {
      const count = fieldsBySubmitter[sub.uuid] ? fieldsBySubmitter[sub.uuid].length : 0;
      console.log(`  ${sub.uuid}: ${sub.role_id || 'unknown'} (${count} fields)`);
    });

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
