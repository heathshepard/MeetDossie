const fs = require('fs');
const path = require('path');

// Load AcroForm fields
const acroFieldsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '.trec-20-18-acroform-raw.json'), 'utf8'));
const acroFieldNames = new Set(acroFieldsRaw.fields.map(f => f.name));

// Extract resale KEY_MAP from docuseal-prefill.js
const docusealContent = fs.readFileSync(path.join(__dirname, '../api/_assets/docuseal-prefill.js'), 'utf8');
const keyMapMatch = docusealContent.match(/KEY_MAP\s*=\s*\{[\s\S]*?\n\};/);
if (!keyMapMatch) {
  console.error('Could not find KEY_MAP in docuseal-prefill.js');
  process.exit(1);
}

// Extract resale-contract mapping from KEY_MAP
const keyMapText = keyMapMatch[0];
const resaleMatch = keyMapText.match(/'resale-contract':\s*\{([\s\S]*?)\n  \},/);
if (!resaleMatch) {
  console.error('Could not find resale-contract in KEY_MAP');
  process.exit(1);
}

const resaleFields = {};
const fieldLines = resaleMatch[1].split('\n');
for (const line of fieldLines) {
  const match = line.match(/\s*(\w+):\s*'([^']+)'/);
  if (match) {
    const ourKey = match[1];
    const docusealLabel = match[2];
    resaleFields[ourKey] = docusealLabel;
  }
}

console.log(`Total AcroForm fields: ${ acroFieldsRaw.total }`);
console.log(`Total KEY_MAP entries: ${ Object.keys(resaleFields).length }\n`);

// Categorize each KEY_MAP entry
const categories = {
  MATCH_VERBATIM: [],
  MACHINE_NAME: [],
  NO_ACROFORM_FIELD: [],
};

for (const [ourKey, docusealLabel] of Object.entries(resaleFields)) {
  if (acroFieldNames.has(docusealLabel)) {
    categories.MATCH_VERBATIM.push({ ourKey, docusealLabel });
  } else if (/^undefined(_\d+)?$|^Text\d+$|^Zip_\d+$|^Phone/.test(docusealLabel)) {
    categories.MACHINE_NAME.push({ ourKey, docusealLabel });
  } else {
    categories.NO_ACROFORM_FIELD.push({ ourKey, docusealLabel });
  }
}

console.log(`MATCH_VERBATIM: ${ categories.MATCH_VERBATIM.length }`);
console.log(`MACHINE_NAME: ${ categories.MACHINE_NAME.length }`);
console.log(`NO_ACROFORM_FIELD: ${ categories.NO_ACROFORM_FIELD.length }\n`);

// Print examples (10 per category)
for (const [catName, items] of Object.entries(categories)) {
  console.log(`\n--- ${ catName } (showing first 10 of ${ items.length }) ---`);
  items.slice(0, 10).forEach(item => {
    console.log(`  ${ item.ourKey } => "${ item.docusealLabel }"`);
    if (item.docusealLabel && acroFieldNames.has(item.docusealLabel)) {
      console.log(`    ✓ Found in AcroForm`);
    } else {
      console.log(`    ✗ NOT found in AcroForm`);
    }
  });
}

// Write summary to file
const summary = {
  totalAcroFormFields: acroFieldsRaw.total,
  totalKeyMapEntries: Object.keys(resaleFields).length,
  categories: {
    MATCH_VERBATIM: categories.MATCH_VERBATIM.length,
    MACHINE_NAME: categories.MACHINE_NAME.length,
    NO_ACROFORM_FIELD: categories.NO_ACROFORM_FIELD.length,
  },
  examples: {
    MATCH_VERBATIM: categories.MATCH_VERBATIM.slice(0, 10),
    MACHINE_NAME: categories.MACHINE_NAME.slice(0, 10),
    NO_ACROFORM_FIELD: categories.NO_ACROFORM_FIELD.slice(0, 10),
  },
};

fs.writeFileSync(path.join(__dirname, '.step4-findings.json'), JSON.stringify(summary, null, 2));
console.log('\n\nResults written to .step4-findings.json');
