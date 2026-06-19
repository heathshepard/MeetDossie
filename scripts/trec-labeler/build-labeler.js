#!/usr/bin/env node
/**
 * build-labeler.js
 *
 * Generates the single-file offline TREC widget labeler HTML by embedding
 * the unmatched-widget JSON inline. Run after every regeneration of the
 * unmatched report.
 *
 * Usage: node scripts/trec-labeler/build-labeler.js
 *
 * Inputs:
 *   - scripts/.trec-20-18-unmatched-report.json  (full report; we extract .unmatched)
 *   - scripts/trec-labeler/labeler-template.html (HTML/CSS/JS shell w/ placeholder)
 *
 * Outputs:
 *   - scripts/trec-labeler/trec-labeler.html     (versioned copy)
 *   - C:\Users\Heath Shepard\Desktop\trec-labeler.html (Heath's working copy)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT_PATH = path.join(ROOT, 'scripts', '.trec-20-18-unmatched-report.json');
const TEMPLATE_PATH = path.join(__dirname, 'labeler-template.html');
const REPO_OUT = path.join(__dirname, 'trec-labeler.html');
const DESKTOP_OUT = path.join('C:\\Users\\Heath Shepard\\Desktop', 'trec-labeler.html');

function main() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`ERROR: report not found at ${REPORT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`ERROR: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const unmatched = report.unmatched || [];
  console.log(`Loaded ${unmatched.length} unmatched widgets from ${REPORT_PATH}`);

  // Multi-form dataset structure per DoD item 3.
  // v1: only trec-20-18 is populated. Other six keys are empty arrays so
  // the form-selector dropdown exercises the loader.
  const dataset = {
    'trec-20-18': unmatched,
    'trec-40': [],
    'trec-36-11': [],
    'op-l': [],
    'trec-39-10': [],
    'trec-38-7': [],
    'op-h': [],
  };

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const buildTime = new Date().toISOString();

  // JSON.stringify is safe inside a <script> block as long as we escape </script>.
  // Embedding as a JSON string literal that gets parsed at runtime keeps the
  // raw data type-safe and avoids any JS expression injection risk from the
  // upstream report.
  const json = JSON.stringify(dataset).replace(/<\/script>/gi, '<\\/script>');
  const literal = JSON.stringify(json);
  // Use the function-form of replace so dollar signs in the replacement
  // are NOT interpreted as backref/special tokens ($&, $', $`, $1).
  // Without this, '$' in the embedded JSON re-injects the entire
  // post-match HTML, producing a duplicated <script> tail.
  const html = template
    .replace('/* __EMBEDDED_DATASET__ */"__PLACEHOLDER__"', function () { return literal; })
    .replace('__BUILD_TIME__', function () { return buildTime; });

  fs.writeFileSync(REPO_OUT, html, 'utf8');
  console.log(`Wrote ${REPO_OUT} (${(html.length / 1024).toFixed(1)} KB)`);

  try {
    fs.writeFileSync(DESKTOP_OUT, html, 'utf8');
    console.log(`Wrote ${DESKTOP_OUT} (${(html.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.warn(`WARN: could not write Desktop copy: ${err.message}`);
  }

  console.log(`Build OK at ${buildTime}`);
  console.log(`  - trec-20-18 widgets: ${dataset['trec-20-18'].length}`);
  console.log(`  - other forms (placeholder, empty): 6`);
}

main();
