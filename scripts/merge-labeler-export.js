#!/usr/bin/env node
/**
 * merge-labeler-export.js
 *
 * Takes the JSON Heath exports from the offline TREC widget labeler and:
 *   1. Updates api/_assets/trec-20-18-pdflib-overridemap.js by writing the
 *      labeled fixture_key for each widget's field_name, replacing the
 *      previous "notes" fallback or unmatched-entry.
 *   2. Patches scripts/.trec-20-18-unmatched-report.md by appending a
 *      "**Heath label:** `<value>`" line in each unmatched widget's section.
 *      Skipped widgets get "deferred"; not-fillable get "not_fillable".
 *   3. Writes a side-car audit log to scripts/.trec-labeler-merge-log.json
 *      so we have a permanent record of who-labeled-what-when.
 *
 * Usage:
 *   node scripts/merge-labeler-export.js <path-to-export.json> [--dry-run] [--report-md=...]
 *
 * Inputs:
 *   - export.json: { "form": "trec-20-18", "labeled_at": "<iso>",
 *                    "labels": [ { index, fixture_key, status, original_guess }, ... ] }
 *
 * Outputs (when not --dry-run):
 *   - api/_assets/trec-20-18-pdflib-overridemap.js  (patched in place)
 *   - scripts/.trec-20-18-unmatched-report.md       (patched in place)
 *   - scripts/.trec-labeler-merge-log.json          (append entry)
 *
 * Form support: v1 ships TREC 20-18 only. Other forms will be wired in
 * once their unmatched reports + overridemaps exist; this script will
 * error out cleanly on unknown forms instead of guessing paths.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FORM_TARGETS = {
  'trec-20-18': {
    overridemap: path.join(ROOT, 'api', '_assets', 'trec-20-18-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.trec-20-18-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.trec-20-18-unmatched-report.json'),
    headerLine: '// TREC 20-18 Resale Contract - PDF Widget to Internal Key Override Map',
  },
  'trec-40': {
    overridemap: path.join(ROOT, 'api', '_assets', 'trec-40-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.trec-40-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.trec-40-unmatched-report.json'),
    headerLine: '// TREC 40 Third-Party Financing Addendum - PDF Widget to Internal Key Override Map',
  },
  'trec-39-10': {
    overridemap: path.join(ROOT, 'api', '_assets', 'trec-39-10-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.trec-39-10-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.trec-39-10-unmatched-report.json'),
    headerLine: '// TREC 39-10 Amendment - PDF Widget to Internal Key Override Map',
  },
  'op-h': {
    overridemap: path.join(ROOT, 'api', '_assets', 'op-h-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.op-h-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.op-h-unmatched-report.json'),
    headerLine: "// OP-H Seller's Disclosure Notice - PDF Widget to Internal Key Override Map",
  },
  'trec-36-11': {
    overridemap: path.join(ROOT, 'api', '_assets', 'trec-36-11-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.trec-36-11-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.trec-36-11-unmatched-report.json'),
    headerLine: '// TREC 36-11 HOA Addendum - PDF Widget to Internal Key Override Map',
  },
  'trec-38-7': {
    overridemap: path.join(ROOT, 'api', '_assets', 'trec-38-7-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.trec-38-7-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.trec-38-7-unmatched-report.json'),
    headerLine: "// TREC 38-7 Notice of Buyer's Termination - PDF Widget to Internal Key Override Map",
    coordsOverlay: true, // No AcroForm widgets — labeler reads from coords map
  },
  'op-l': {
    overridemap: path.join(ROOT, 'api', '_assets', 'op-l-pdflib-overridemap.js'),
    unmatchedReportMd: path.join(ROOT, 'scripts', '.op-l-unmatched-report.md'),
    unmatchedReportJson: path.join(ROOT, 'scripts', '.op-l-unmatched-report.json'),
    headerLine: '// OP-L Lead-Based Paint Addendum - PDF Widget to Internal Key Override Map',
  },
};

const LOG_PATH = path.join(ROOT, 'scripts', '.trec-labeler-merge-log.json');

function parseArgs(argv) {
  const out = { exportPath: null, dryRun: false, overrideReportMd: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--report-md=')) { out.overrideReportMd = a.slice('--report-md='.length); continue; }
    if (a.startsWith('--')) { console.error('Unknown flag:', a); process.exit(2); }
    if (!out.exportPath) { out.exportPath = a; continue; }
    console.error('Unexpected positional arg:', a);
    process.exit(2);
  }
  if (!out.exportPath) {
    console.error('Usage: node scripts/merge-labeler-export.js <export.json> [--dry-run] [--report-md=...]');
    process.exit(2);
  }
  return out;
}

function loadExport(p) {
  if (!fs.existsSync(p)) {
    console.error('Export file not found:', p);
    process.exit(1);
  }
  const raw = fs.readFileSync(p, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { console.error('Invalid JSON in export:', e.message); process.exit(1); }
  if (!parsed || typeof parsed !== 'object') {
    console.error('Export is not an object');
    process.exit(1);
  }
  if (!parsed.form || typeof parsed.form !== 'string') {
    console.error('Export missing required "form" string');
    process.exit(1);
  }
  if (!Array.isArray(parsed.labels)) {
    console.error('Export missing "labels" array');
    process.exit(1);
  }
  parsed.labels.forEach((row, i) => {
    if (typeof row.index !== 'number') throw new Error('label ' + i + ': index not a number');
    if (typeof row.status !== 'string') throw new Error('label ' + i + ': status not a string');
  });
  return parsed;
}

function loadUnmatchedJson(targetCfg) {
  const raw = fs.readFileSync(targetCfg.unmatchedReportJson, 'utf8');
  const parsed = JSON.parse(raw);
  const byIdx = {};
  // Index BOTH buckets so the merger can patch any widget the labeler shows.
  // (v2 labeler exposes confident_matches too — Heath may override them.)
  (parsed.unmatched || []).forEach((w) => { byIdx[w.index] = w; });
  (parsed.confident_matches || []).forEach((w) => {
    if (byIdx[w.index]) return; // unmatched wins if collision (shouldn't happen)
    byIdx[w.index] = {
      index: w.index,
      field_name: w.field_name,
      page: w.page,
      field_type: w.field_type,
    };
  });
  return { parsed, byIdx };
}

function ensureOverrideMap(targetCfg, dryRun) {
  if (fs.existsSync(targetCfg.overridemap)) return;
  if (dryRun) {
    console.log('DRY RUN: would create starter overridemap at', targetCfg.overridemap);
    return;
  }
  // Bootstrap an empty starter override map so the patch step has somewhere
  // to add lines. Header line + empty module.exports = { };.
  const stub = `${targetCfg.headerLine}
// Auto-created by scripts/merge-labeler-export.js — first labeler import.
// Maps raw PDF AcroForm widget names to Dossie internal fixture keys.
// Generated: ${new Date().toISOString().slice(0, 10)}

module.exports = {
};
`;
  fs.writeFileSync(targetCfg.overridemap, stub, 'utf8');
  console.log('Created starter overridemap:', targetCfg.overridemap);
}

function patchOverrideMap(targetCfg, labels, unmatchedByIdx, dryRun) {
  if (!fs.existsSync(targetCfg.overridemap)) {
    // Dry-run path where ensureOverrideMap was skipped. Pretend an empty map.
    return {
      changes: [],
      stats: { updated: 0, added: 0, skipped: 0, not_fillable_marked: 0 },
      patchedLength: 0,
      note: 'overridemap absent — dry-run only',
    };
  }
  const src = fs.readFileSync(targetCfg.overridemap, 'utf8');

  // The overridemap is a JS file like:
  //   module.exports = { "key": "value", "key2": "value2", ... };
  // We do a key-by-key in-place replace. For each labeled widget, we look up
  // its field_name from the unmatched JSON, then replace the line
  //   "<field_name>": "<old_value>",
  // with the new value. If no line exists yet for that field_name, we
  // append it before the closing }; .
  let patched = src;
  const changes = [];
  const stats = { updated: 0, added: 0, skipped: 0, not_fillable_marked: 0 };

  labels.forEach((row) => {
    const widget = unmatchedByIdx[row.index];
    if (!widget) {
      console.warn('  WARN: label index', row.index, 'not in unmatched JSON; skipping override update');
      return;
    }
    const fieldName = widget.field_name;
    if (typeof fieldName !== 'string') return;

    let newValue;
    if (row.status === 'accepted' || row.status === 'corrected') {
      if (!row.fixture_key) {
        console.warn('  WARN: index', row.index, 'status', row.status, 'has empty fixture_key — skipping');
        stats.skipped++;
        return;
      }
      newValue = row.fixture_key;
    } else if (row.status === 'not_fillable') {
      // Mark with a sentinel that the fill pipeline can recognize as "ignore".
      newValue = '__not_fillable__';
      stats.not_fillable_marked++;
    } else if (row.status === 'skipped') {
      // Deferred. Don't touch the overridemap — Heath will revisit.
      stats.skipped++;
      return;
    } else {
      console.warn('  WARN: unknown status', row.status, 'for index', row.index, '— skipping');
      stats.skipped++;
      return;
    }

    // Escape the field_name for use in a regex.
    const escName = fieldName.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const lineRegex = new RegExp('^(\\s*)"' + escName + '":\\s*"([^"]*)",?\\s*$', 'm');
    const lineMatch = patched.match(lineRegex);

    if (lineMatch) {
      const before = lineMatch[0];
      const oldValue = lineMatch[2];
      if (oldValue === newValue) return; // already correct
      const after = lineMatch[1] + '"' + fieldName.replace(/"/g, '\\"') + '": "' + newValue + '",';
      patched = patched.replace(before, after);
      changes.push({ index: row.index, field_name: fieldName, old: oldValue, new: newValue, status: row.status, mode: 'updated' });
      stats.updated++;
    } else {
      // No existing line — append before closing brace.
      const closeRegex = /\n\};\s*$/;
      const newLine = '  "' + fieldName.replace(/"/g, '\\"') + '": "' + newValue + '",\n';
      if (closeRegex.test(patched)) {
        patched = patched.replace(closeRegex, '\n' + newLine + '};\n');
      } else {
        // Fallback: just append
        patched = patched.replace(/\};?\s*$/, '\n' + newLine + '};\n');
      }
      changes.push({ index: row.index, field_name: fieldName, old: null, new: newValue, status: row.status, mode: 'added' });
      stats.added++;
    }
  });

  if (!dryRun && changes.length > 0) {
    fs.writeFileSync(targetCfg.overridemap, patched, 'utf8');
  }

  return { changes, stats, patchedLength: patched.length };
}

function patchUnmatchedReport(targetCfg, labels, unmatchedByIdx, dryRun, overridePath) {
  const reportPath = overridePath || targetCfg.unmatchedReportMd;
  let src = fs.readFileSync(reportPath, 'utf8');
  let touched = 0;

  labels.forEach((row) => {
    const widget = unmatchedByIdx[row.index];
    if (!widget) return;
    const labelValue = row.status === 'skipped' ? 'deferred'
                     : row.status === 'not_fillable' ? 'not_fillable'
                     : (row.fixture_key || '__unlabeled__');

    // Locate the widget's section. Heading line looks like:
    //   ### #11 — page 1 — `B Sum of all ...` (checkbox)
    // We match by index marker `#<n> —`.
    const sectionStart = src.indexOf('### #' + row.index + ' —');
    if (sectionStart === -1) return;
    // Find the placeholder line: "**Heath label:** `__________________`"
    // OR an existing patched line we want to overwrite.
    const after = src.slice(sectionStart);
    const nextSection = after.indexOf('\n### #', 1);
    const sliceEnd = nextSection === -1 ? sectionStart + after.length : sectionStart + nextSection;
    const section = src.slice(sectionStart, sliceEnd);

    const placeholderRegex = /\*\*Heath label:\*\* `[^`]*`/;
    if (placeholderRegex.test(section)) {
      const newSection = section.replace(placeholderRegex, '**Heath label:** `' + labelValue + '`  _<' + row.status + ' ' + new Date().toISOString().slice(0,10) + '>_');
      src = src.slice(0, sectionStart) + newSection + src.slice(sliceEnd);
      touched++;
    }
  });

  if (!dryRun && touched > 0) {
    fs.writeFileSync(reportPath, src, 'utf8');
  }
  return { touched, reportPath };
}

function writeAuditLog(exportPayload, mergeResult, dryRun) {
  const entry = {
    merged_at: new Date().toISOString(),
    dry_run: dryRun,
    form: exportPayload.form,
    labeled_at: exportPayload.labeled_at,
    counts: mergeResult.stats,
    changes: mergeResult.changes,
  };
  let log = [];
  if (fs.existsSync(LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); }
    catch (e) { console.warn('WARN: could not parse existing merge log, starting fresh.'); log = []; }
  }
  log.push(entry);
  if (!dryRun) fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
  return entry;
}

function main() {
  const args = parseArgs(process.argv);
  const payload = loadExport(args.exportPath);
  console.log('Loaded export: form=' + payload.form + ', ' + payload.labels.length + ' labels');

  const targetCfg = FORM_TARGETS[payload.form];
  if (!targetCfg) {
    console.error('No targets configured for form "' + payload.form + '". Supported forms:', Object.keys(FORM_TARGETS).join(', '));
    process.exit(1);
  }

  ensureOverrideMap(targetCfg, args.dryRun);
  // For dry-runs against a never-yet-merged form, also skip the patch step
  // since there's no overridemap to patch. Just report what would happen.
  if (args.dryRun && !fs.existsSync(targetCfg.overridemap)) {
    console.log('DRY RUN: no overridemap exists yet — skipping patch step.');
  }
  if (!fs.existsSync(targetCfg.unmatchedReportJson)) {
    console.error('unmatched report JSON missing:', targetCfg.unmatchedReportJson);
    process.exit(1);
  }

  const { byIdx } = loadUnmatchedJson(targetCfg);
  console.log('Loaded unmatched JSON: ' + Object.keys(byIdx).length + ' widgets indexed.');

  const overrideResult = patchOverrideMap(targetCfg, payload.labels, byIdx, args.dryRun);
  console.log('Overridemap: ' + overrideResult.stats.updated + ' updated, ' +
              overrideResult.stats.added + ' added, ' +
              overrideResult.stats.not_fillable_marked + ' marked not_fillable, ' +
              overrideResult.stats.skipped + ' skipped/deferred.');
  overrideResult.changes.forEach((c) => {
    console.log('  - #' + c.index + ' "' + c.field_name + '" ' + c.mode +
                ' (was ' + JSON.stringify(c.old) + ' -> ' + JSON.stringify(c.new) + ', status=' + c.status + ')');
  });

  const reportResult = patchUnmatchedReport(targetCfg, payload.labels, byIdx, args.dryRun, args.overrideReportMd);
  console.log('Unmatched report MD: ' + reportResult.touched + ' sections patched at ' + reportResult.reportPath);

  const entry = writeAuditLog(payload, overrideResult, args.dryRun);
  console.log('Audit log entry created' + (args.dryRun ? ' (dry-run, not persisted)' : ' at ' + LOG_PATH));
  console.log('Summary:', JSON.stringify(entry.counts));

  if (args.dryRun) {
    console.log('\nDRY RUN — no files written.');
  } else {
    console.log('\nMerge OK.');
  }
}

main();
