// Sanity test for validateCapabilityBeat() in api/cron-generate-skit.js
//
// We re-import the validator + constants by reading the source file and
// evaluating just the validator block. Simpler than a full Vercel handler
// invocation. Three checks:
//   1. A good script with Bill capability beat + CTA PASSES
//   2. A second good script (alternate verb) PASSES
//   3. Bad script ([charlie/stuff], [bill/Meet Dossie], [bill/CTA]) FAILS
//
// Exit 0 on all-pass, 1 on any failure.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.join(__dirname, '..', 'api', 'cron-generate-skit.js');
const src = fs.readFileSync(srcPath, 'utf8');

// Find the constants block + validator function in the source and evaluate
// just those pieces in a sandbox. We grab from CAPABILITY_VERBS through the
// end of validateCapabilityBeat().
const startIdx = src.indexOf('const CAPABILITY_VERBS');
const endMarker = '\nasync function _generateSkitScriptOnce';
const endIdx = src.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('FAIL: Could not locate validator block in cron-generate-skit.js');
  process.exit(1);
}

const block = src.slice(startIdx, endIdx);
// Expose globals
const wrapped = block + '\nthis.validateCapabilityBeat = validateCapabilityBeat;\n'
              + 'this.CAPABILITY_VERBS = CAPABILITY_VERBS;\n'
              + 'this.CAPABILITY_BANNED_PHRASES = CAPABILITY_BANNED_PHRASES;\n'
              + 'this.CTA_REQUIRED_SUBSTRING = CTA_REQUIRED_SUBSTRING;\n';

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(wrapped, sandbox);

const { validateCapabilityBeat, CAPABILITY_VERBS } = sandbox;

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL: ${name} -> ${e.message}`);
    fail++;
  }
}

check('Good Paradise-style script passes', () => {
  const script = {
    lines: [
      ['bill',    'This is a real estate agent on vacation.'],
      ['charlie', 'I finally made it. No deals.'],
      ['charlie', '...the option period expires tomorrow.'],
      ['bill',    'And this is the same agent. Still working.'],
      ['charlie', 'Which title company did we use?'],
      ['bill',    'Dossie remembers every title company on every deal.'],
      ['charlie', '...oh.'],
      ['bill',    'Dossie tracks every deadline. Dossie sends the follow-up.'],
      ['bill',    'Texas agents - meetdossie.com slash founding.'],
    ],
  };
  const r = validateCapabilityBeat(script);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  if (!CAPABILITY_VERBS.includes(r.verb)) throw new Error(`unexpected verb ${r.verb}`);
  console.log(`    verb="${r.verb}" idx=${r.matchedIdx} text="${r.matchedText}"`);
});

check('Good Breakup-style script passes', () => {
  const script = {
    lines: [
      ['luna',    'I need to talk to you.'],
      ['charlie', '...about the closing?'],
      ['luna',    'About us. I can\'t do this anymore.'],
      ['bill',    'Dossie tracks every addendum and attaches it to the right client.'],
      ['bill',    'Texas agents - meetdossie.com slash founding.'],
    ],
  };
  const r = validateCapabilityBeat(script);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  if (r.verb !== 'tracks' && r.verb !== 'attaches') {
    throw new Error(`expected tracks or attaches, got ${r.verb}`);
  }
  console.log(`    verb="${r.verb}" idx=${r.matchedIdx} text="${r.matchedText}"`);
});

check('Bad script with "Meet Dossie" + no capability beat FAILS', () => {
  const script = {
    lines: [
      ['charlie', 'stuff'],
      ['bill',    'Meet Dossie.'],
      ['bill',    'Texas agents - meetdossie.com slash founding'],
    ],
  };
  const r = validateCapabilityBeat(script);
  if (r.ok) throw new Error('expected failure, validator returned ok=true');
  console.log(`    correctly rejected: ${r.reason.slice(0, 120)}...`);
});

check('Bad script with only "She\'s got it" FAILS', () => {
  const script = {
    lines: [
      ['charlie', 'I lost the addendum'],
      ['bill',    "She's got it."],
      ['bill',    'Texas agents - meetdossie.com slash founding.'],
    ],
  };
  const r = validateCapabilityBeat(script);
  if (r.ok) throw new Error('expected failure, validator returned ok=true');
  console.log(`    correctly rejected: ${r.reason.slice(0, 120)}...`);
});

check('Bad script with no CTA at all FAILS', () => {
  const script = {
    lines: [
      ['charlie', 'I lost the addendum'],
      ['bill',    'Dossie tracks every deadline.'],
    ],
  };
  const r = validateCapabilityBeat(script);
  if (r.ok) throw new Error('expected failure, no CTA line present');
  console.log(`    correctly rejected: ${r.reason.slice(0, 120)}...`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
