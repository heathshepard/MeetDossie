#!/usr/bin/env node
'use strict';

// Regression: the brand guardrails in scripts/build-shortform-video.py are
// REFUSALS, not documentation.
//
// A guardrail nobody has watched fail is a guardrail you are trusting on
// faith. Each case below builds a minimal spec that violates exactly one rule
// and asserts the compositor ABORTS with a non-zero exit before rendering.
// The last case asserts the honest-exemption does NOT swallow a real download
// claim — an exemption that makes the rule unenforceable is worse than no
// exemption.
//
// These are cheap: every case fails during spec validation, before any ffmpeg
// work, so the suite runs in seconds and needs no captured frames, no
// voiceover and no network.
//
// Run: node scripts/regression-shortform-brand-guardrails.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BUILDER = path.join(REPO, 'scripts', 'build-shortform-video.py');
const BRANDS = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', '_lib', 'shortform-brands.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfguard-'));

// A spec skeleton that would be structurally valid. Every case below trips a
// refusal that fires BEFORE frames/voice are ever touched, so these paths are
// never read.
function spec(brand, over) {
  return Object.assign({
    brand,
    frames_json: path.join(tmp, 'frames.json'),
    fontsdir: tmp,
    cards: {},
    segments: [],
    voice: [],
    music: null,
    music_null_reason: 'regression fixture — no render performed',
  }, over);
}

function runBuilder(s) {
  const p = path.join(tmp, `spec-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(s));
  try {
    execFileSync('python3', [BUILDER, '--spec', p, '--out', path.join(tmp, 'o.mp4'), '--work', path.join(tmp, 'w')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, err: `${e.stderr || ''}${e.stdout || ''}` };
  }
}

const cases = [];
function refuses(name, s, mustSay) {
  cases.push({ name, s, mustSay, expect: 'refuse' });
}

// --- Rust: a download CTA for an app that is in neither store ---------------
refuses('rust refuses a "download now" CTA',
  spec('rust', { cards: { cta: { html_inline: '<body><h1>Download now on the App Store</h1></body>' } } }),
  'forbidden copy');

refuses('rust refuses a download claim in the SPOKEN copy too, not just cards',
  spec('rust', { voice: [{ speaker: 'Heath', at: 0, mp3: 'x.mp3', timing: 't.json', text: 'Go download it now.' }] }),
  'forbidden copy');

// The honest line the playbook prescribes must survive...
cases.push({
  name: 'rust ALLOWS the prescribed honest line "Not in the app stores yet"',
  s: spec('rust', { cards: { cta: { html_inline: '<body><div>rustfitness.app</div><div>Not in the app stores yet</div></body>' } } }),
  expect: 'pass-copy-check',
});
// ...but must NOT become a loophole that launders a real download claim.
refuses('rust honest-exemption does NOT swallow a real download claim on the same card',
  spec('rust', { cards: { cta: { html_inline: '<body><div>Not in the app stores yet</div><div>Download now</div></body>' } } }),
  'forbidden copy');

// --- Dossie: /founding closed 2026-08-04 -----------------------------------
refuses('dossie refuses a /founding CTA',
  spec('dossie', { cards: { cta: { html_inline: '<body><div>meetdossie.com/founding</div></body>' } } }),
  'forbidden copy');

refuses('dossie refuses a $29 founding-price claim',
  spec('dossie', { cards: { cta: { html_inline: '<body><div>Just $29/mo</div></body>' } } }),
  'forbidden copy');

// --- Realtor: weakness signals + fair housing ------------------------------
for (const [label, copy] of [
  ['motivated seller', 'Motivated seller — bring me all offers'],
  ['price reduced', 'Price reduced this week'],
  ['DOM emphasis', 'Only 120 days on market'],
  ['fair-housing steering', 'Great home in a family neighborhood with good schools'],
]) {
  refuses(`heath-realtor refuses "${label}"`,
    spec('heath-realtor', { cards: { hook: { html_inline: `<body><h1>${copy}</h1></body>` } } }),
    'forbidden copy');
}

refuses('heath-realtor refuses a weakness signal in the post caption, not just on screen',
  spec('heath-realtor', { post_caption: 'Seller is motivated, priced to sell!' }),
  'forbidden copy');

// --- Caption typeface: a serif is an automatic §5a check-12 FAIL -----------
refuses('refuses Cormorant Garamond as a CAPTION face',
  spec('dossie', { captions: { font: 'Cormorant Garamond' } }),
  'caption font');

// --- Music: silent ships only with a written reason ------------------------
refuses('refuses a silent build with no written music_null_reason',
  (() => { const s = spec('dossie'); s.music = null; delete s.music_null_reason; return s; })(),
  'music_null_reason');

// --- Unknown brand --------------------------------------------------------
refuses('refuses an unknown brand rather than silently using defaults',
  spec('acme-corp', {}),
  'unknown brand');

// --- Voice: a persona may not speak in a voice that is not theirs ---------
refuses("dossie refuses Heath's clone speaking AS DOSSIE",
  spec('dossie', {
    voice: [{ speaker: 'Dossie', at: 0, mp3: 'x.mp3', timing: 't.json', text: 'hi', voice_id: 'i41TA0Q36AUrp4axERi3' }],
  }),
  'may not use voice');

let pass = 0; const fails = [];
for (const c of cases) {
  const r = runBuilder(c.s);
  if (c.expect === 'refuse') {
    const refused = r.code !== 0 && new RegExp(c.mustSay, 'i').test(r.err);
    if (refused) { pass++; console.log(`  PASS  ${c.name}`); }
    else { fails.push(`${c.name}\n        exit=${r.code} stderr=${(r.err || '').slice(0, 300)}`); console.log(`  FAIL  ${c.name}`); }
  } else {
    // Must get PAST the copy/font refusals. It will still fail later on the
    // missing frames.json — that's fine and expected; what must NOT appear is
    // a forbidden-copy refusal.
    const wronglyRefused = /forbidden copy/i.test(r.err);
    if (!wronglyRefused) { pass++; console.log(`  PASS  ${c.name}`); }
    else { fails.push(`${c.name}\n        wrongly refused: ${(r.err || '').slice(0, 300)}`); console.log(`  FAIL  ${c.name}`); }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass}/${cases.length} guardrail cases passed`);
if (fails.length) {
  console.error('\nFAILURES:\n' + fails.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
// Sanity: the config must actually carry the rules these cases probe, so a
// future edit that empties the pattern lists fails here rather than silently
// disarming every refusal above.
for (const b of ['dossie', 'rust', 'heath-realtor']) {
  const pats = ((BRANDS.brands[b] || {}).cta || {}).forbidden || [];
  if (!pats.length) { console.error(`brand ${b} has NO forbidden patterns — refusals are disarmed`); process.exit(1); }
}
console.log('brand config carries forbidden patterns for all 3 brands');
