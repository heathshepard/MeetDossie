#!/usr/bin/env node
/**
 * generate-ask-dossie-video.js
 *
 * The CAPTURE half of the D1 "Ask Dossie" real-question demo format
 * (docs/CONTENT-FORMAT-LIBRARY.md section 3, format D1).
 *
 * WHAT IT DOES
 * ------------
 *   1. SOURCE   Pulls REAL questions/pain language out of the live Supabase
 *               project - `reddit_pain_language` (scraped r/realtors etc.) and
 *               `tc_discovery_responses` (real comments by real Facebook group
 *               members on Heath's TC discovery posts). Nothing is invented.
 *   2. MAP      Maps each real quote to ONE verified-WORKS capability from
 *               docs/DOSSIE-VERIFIED-CAPABILITIES.md. The mapper is REQUIRED to
 *               be able to return "no honest match" and skip the quote - see
 *               mapQuote() below. Never force a mapping: an unmappable quote is
 *               a skipped quote, not a stretched claim.
 *   3. CAPTURE  Delegates to the existing recorder,
 *               `scripts/record-dossie-shortform-frames.js --flow ask-dossie`,
 *               which signs in to PRODUCTION as the demo account, opens the
 *               real Talk-to-Dossie command panel, types the mapped question,
 *               sends it, and screenshot-loops the app actually answering at
 *               390x844 @ dsf3 => true 1170x2532 frames. This script does NOT
 *               re-implement capture or the sign-in gate.
 *   4. HANDOFF  Folds the question's provenance into <out>/answer.json and
 *               writes <out>/capture-notes.md for the compositor.
 *
 * IT DOES NOT RENDER A VIDEO. It hands off to the short-form compositor
 * (scripts/build-shortform-video.py) via the contract below.
 *
 * ── HANDOFF CONTRACT (what the compositor consumes) ─────────────────────────
 *
 *   <out>/frames/NNNNN.jpg   JPEG frames, 1170x2532, variable real frame rate
 *   <out>/frames.json        {"frames":[{"ts":<int ms>,"f":"<absolute path>"}]}
 *                            EXACTLY the shape build-shortform-video.py reads
 *                            as spec["frames_json"] and indexes with
 *                            pick_frame()/build_sequence() (nearest-ts lookup,
 *                            so a variable capture rate is fine).
 *   <out>/capture-notes.md   Per-beat log: ts window, what the beat is, and the
 *                            text ACTUALLY on screen at that moment, read off
 *                            the DOM (not hand-written). This is what playbook
 *                            section 5a check 13 is verified against - no claim
 *                            may contradict a value visible on screen at that
 *                            moment, and anything cited must be SHOWN first,
 *                            held ~1.5-2s, BEFORE it is said.
 *   <out>/answer.json        { question, answer_verbatim, ... }. `answer_verbatim`
 *                            is the EXACT string the app rendered. Captions and
 *                            Luna VO must use it verbatim - never a paraphrase
 *                            (playbook section 5 items 6 / 6a).
 *   <out>/verify-signed-in.png  Proof screenshot taken by the gate BEFORE any
 *                            frame was written.
 *
 *   Segment boundaries are NOT chosen here. capture-notes.md gives the
 *   compositor the ts of every beat; the compositor picks src0/src1.
 *
 * ── SAFETY (non-negotiable) ─────────────────────────────────────────────────
 *   * Demo account only (demo@meetdossie.com / Sarah Whitley). `transactions`
 *     is multi-tenant - filming any other account would publish a real
 *     customer's client data. assertDemoDataOnly() aborts on any address that
 *     is not on the demo allowlist.
 *   * assertSignedIn() runs BEFORE a single frame is written and hard-exits
 *     non-zero otherwise. A previous capture filmed the LOGIN PAGE for 35s and
 *     it shipped. This gate mirrors the one in
 *     scripts/record-dossie-shortform-frames.js - keep the two in sync (better:
 *     have that script export it).
 *   * DEMO_PASSWORD is read from .env.local at runtime only. It is never
 *     printed, logged, or written into any output file - this repo is PUBLIC.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node scripts/generate-ask-dossie-video.js --stage map
 *       Refresh scripts/ask-dossie-questions/mapped-questions.json from the
 *       live DB and print the runway number (mapped / candidates).
 *
 *   node scripts/generate-ask-dossie-video.js --stage capture \
 *       --pick <row-id|index> --out <dir>
 *       Capture one mapped question. Defaults to the highest-priority mapped
 *       row that has not been captured yet.
 *
 *   node scripts/generate-ask-dossie-video.js --out <dir>      (both stages)
 *
 *   Flags: --fps 14  --quality 88  --headed  --url https://meetdossie.com/app
 *          --dry-run (map only, print, write nothing)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = '/mnt/c/Users/Heath/Projects/MeetDossie';
const HERE = __dirname;
const QUESTIONS_DIR = path.join(HERE, 'ask-dossie-questions');
const MAPPED_JSON = path.join(QUESTIONS_DIR, 'mapped-questions.json');

// ------------------------------------------------------------------ args ---
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (n) => process.argv.includes('--' + n);

const STAGE = arg('stage', 'all');
const OUT_DIR = arg('out', path.join('/tmp', 'ask-dossie-' + new Date().toISOString().slice(0, 10)));
const FRAME_DIR = path.join(OUT_DIR, 'frames');
const APP_URL = arg('url', 'https://meetdossie.com/app');
const FPS = Number(arg('fps', 14));
const QUALITY = Number(arg('quality', 88));
const PICK = arg('pick', null);
// Which of a capability's pre-approved questions to ask (default the first).
const ASK_INDEX = Number(arg('ask-index', 0));

// Mobile capture geometry. 390x844 @ dsf 3 => 1170x2532 real pixels, which is
// what build-shortform-video.py's geometry_filter() expects as its source.
const VIEWPORT = { width: 390, height: 844 };
const DSF = 3;

const DEMO_EMAIL = 'demo@meetdossie.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error('\n=========================================');
  console.error('ABORT: ' + msg);
  console.error('=========================================\n');
  process.exit(1);
}

// =========================================================================
// 1. THE ALLOWLIST
// =========================================================================
//
// ONLY capabilities verified **WORKS** in docs/DOSSIE-VERIFIED-CAPABILITIES.md
// (items 1-14, verified 2026-09-14 by driving the real app) may be
// demonstrated. PARTIAL / UNVERIFIED / DOESN'T EXIST items are not in this
// table at all, on purpose, so they cannot be selected by accident.
//
// `ask` is a CLOSED SET of pre-approved questions per capability. The mapper
// picks one from this list - it never composes a question at runtime, because
// a generated question is an unverified claim about what the app can answer.
// Each one is phrased the way a Texas agent would actually type it.
const CAPABILITIES = [
  {
    n: 5,
    name: 'Dossier detail view (per-transaction)',
    signals: [/\bfile\b.*\b(organi[sz]|track|manage)/i, /\ball (the )?(info|details)\b/i,
      /\bone place\b/i, /\bconsolidat/i, /\bfolder/i, /\bfiling structure\b/i,
      /\btracking clients and files\b/i],
    ask: ['Give me the full picture on 789 Ranch Rd.'],
  },
  {
    n: 6,
    name: 'TREC deadline calculator (real paragraph citations, recomputed live)',
    signals: [/\bdeadline/i, /\boption period\b/i, /\bmiss(ed|ing|es)?\b[^.]{0,30}\b(date|deadline)/i,
      /\bslip(ped)? through\b/i, /\btitle commitment\b/i, /\bcontingency timeline\b/i,
      /\bclosing (date|got|has been) (moved|put off|pushed)/i, /\bnever have to worry about missing\b/i],
    // PROPERTY-SCOPED BY DESIGN. A portfolio-wide question ("which option
    // period expires first?") makes the model enumerate every dossier, which
    // is how the 29046 Pfeiffers Gate row - a copy of one of Heath's REAL,
    // live deals sitting in the demo seed - ended up named on screen in the
    // first take. A single-property question structurally cannot do that.
    // Option period first: it is the one deadline the app computes from the
    // effective date and states as real TREC math. (The title-commitment
    // variant is kept but ranked second - on this dossier the app correctly
    // answers that TREC sets no fixed title-commitment deadline, which is an
    // honest answer but a weak demo, and it reads as contradicting the
    // dossier detail view's own "Title commitment deadline - para 6A" row.)
    ask: ['When does the option period end on 789 Ranch Rd?',
      'What is the title commitment deadline on 789 Ranch Rd?'],
  },
  {
    n: 7,
    name: 'Stage checklist (Pre-Contract through Closed)',
    signals: [/\bmiss(ed|ing)?\b[^.]{0,30}\bstep/i, /\bimportant steps\b/i, /\bprocess\b/i,
      /\bexpectations\b/i, /\bchecklist/i, /\bdidn.?t miss\b/i, /\bstandards for follow ?up\b/i],
    ask: ["What's left to do on 789 Ranch Rd?"],
  },
  {
    n: 8,
    name: 'Required-documents tracking (present vs missing, TX LAW tags)',
    signals: [/\bmissing (paperwork|document|doc|disclosure)/i, /\bwhat.?s missing\b/i,
      /\bIABS\b/i, /\bbuyer rep(resentation)? agreement\b/i, /\blead paint\b/i,
      /\boverlook(ing|ed)?\b/i, /\bslip(ped)? through\b/i],
    ask: ['What am I missing on 789 Ranch Rd?'],
  },
  {
    n: 9,
    name: 'Document management (per-dossier file list, upload/view/delete)',
    signals: [/\bfolder/i, /\bfiling structure\b/i, /\bconsolidat/i, /\bdocuments? (are|is) (all )?(everywhere|scattered)/i,
      /\bcategoriz/i, /\bsubfiles?\b/i],
    ask: ['What documents are on file for 789 Ranch Rd?'],
  },
  {
    n: 10,
    name: 'Pipeline view (10-stage board with computed urgency)',
    signals: [/\bpipeline\b/i, /\bhow many (deals|files|transactions)\b/i, /\bjuggl/i,
      /\bvolume\b/i, /\bscal(e|ing)\b/i, /\bat once\b/i],
    ask: ['Where does every deal stand right now?'],
  },
  {
    n: 11,
    name: 'Talk to Dossie (typed command, real data-grounded answer)',
    signals: [/\bask\b/i, /\bfind out\b/i, /\bwhere (do|does) (I|it) (look|stand)\b/i,
      /\bhave to (go )?(dig|hunt|search)\b/i],
    ask: ["What's urgent today?"],
  },
  {
    n: 13,
    name: 'Morning Brief (data-grounded daily summary)',
    signals: [/\bevery morning\b/i, /\bstart (of |)(my |the |)day\b/i, /\bwhat needs my attention\b/i,
      /\btop of\b.*\blooking at it\b/i, /\bon top of\b/i, /\bnothing catches (you|me) late\b/i,
      /\burgent\b/i, /\bwhat.?s on fire\b/i],
    ask: ["What's urgent today?"],
  },
  {
    n: 14,
    name: 'Email drafting (real recipients, member sends)',
    signals: [/\bdraft (an? )?email\b/i, /\bfollow ?up email\b/i, /\bemail the (lender|title|agent)\b/i,
      /\bchasing\b.*\bemail\b/i],
    ask: ['Draft the follow-up email on 789 Ranch Rd.'],
  },
];

// Topics the product CANNOT honestly demonstrate. If a quote's ask is one of
// these, the mapper MUST skip it - no capability, however adjacent, may be
// substituted. Sourced from DOSSIE-VERIFIED-CAPABILITIES.md items 15-24 and
// its "For the conversation-video format specifically" section.
const FORBIDDEN = [
  { re: /\b(cma|comps?|comparable sales)\b/i, why: 'CMA generation DOES NOT EXIST (cap 20)' },
  { re: /\b(mls|sabor|matrix|idx|rets|reso)\b/i, why: 'MLS integration DOES NOT EXIST (cap 21)' },
  { re: /\b(text|sms|texting)\b.*\bclient/i, why: 'Member SMS capture DOES NOT EXIST (cap 22)' },
  { re: /\bauto[- ]?send|sends? (the )?email (for|on) (me|my behalf)/i, why: 'Email auto-send DOES NOT EXIST by design (cap 15)' },
  { re: /\b(sign(ed|ature)s? (is|are)? ?(done|complete|back)|fully executed through)\b/i, why: 'Zero e-sign envelopes have ever completed in production (cap 16, PARTIAL)' },
  { re: /\b(kw command|skyslope|dotloop|brokermint|compliance portal|broker portal)\b/i, why: 'Brokerage portal upload DOES NOT EXIST (cap 24)' },
  { re: /\bcompliance vault\b/i, why: 'Compliance Vault UNVERIFIED (cap 18)' },
  { re: /\b(gmail|inbox) (is |already )?connected\b/i, why: 'Nobody has ever completed the Gmail connect flow (cap 19, PARTIAL)' },
  { re: /\b(remember|save|default).{0,24}\b(option fee|survey days|title payor|my usual terms)\b/i, why: 'Per-agent contract-term defaults DO NOT EXIST (cap 23)' },
  { re: /\b(canva|brochure|newsletter|flyer|listing presentation)\b/i, why: 'Marketing-collateral design is not a Dossie capability at all' },
  { re: /\b(2fa|mfa|multi[- ]?factor|verification code|login code|password)\b/i, why: 'Dossie does not manage logins, MFA codes, or shared passwords' },
  { re: /\b(commission split|brokerage split|cap|desk fee|recruit)/i, why: 'Compensation/brokerage-economics is not a product capability' },
  { re: /\b(cold call|lead gen|find (listings|clients)|prospect)/i, why: 'Lead generation is not a product capability' },
];

// Obvious non-questions: social pleasantries, vendor recommendations, self-promo.
// These are real rows but they carry no product-relevant question.
const NOISE = [
  /^(thank(s| you)|congrat|happy birthday|ditto|beautiful|wow\b|ha!|love (it|you)|amazing|way to go)/i,
  /\b(highly )?recommend\b/i, /\bcleaning (service|company)\b/i,
  /\b(call me|i'?ll call you|i wrote you a text)\b/i,
  /@|\bllc\.?$|\b\d{3}[.\- ]\d{3}[.\- ]\d{4}\b/, // contact-details self-promo
];

// =========================================================================
// 2. THE MAPPER
// =========================================================================

/**
 * Map ONE real quote to at most one verified-WORKS capability.
 *
 * Returns { decision: 'mapped', capability, ask, matched }  OR
 *         { decision: 'skipped', reason }
 *
 * Returning "skipped" is a first-class, expected outcome. Most real quotes do
 * not map to anything Dossie can honestly demonstrate, and forcing one to fit
 * is exactly the failure mode dossie-demo-must-match-real-capability.md exists
 * to prevent.
 */
function mapQuote(text, meta = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();

  if (t.length < 40) return { decision: 'skipped', reason: 'too short to be a real question (<40 chars)' };
  if (/^heath shepard/i.test(meta.author || '')) {
    return { decision: 'skipped', reason: "Heath's own comment - not an outside voice" };
  }
  for (const re of NOISE) {
    if (re.test(t)) return { decision: 'skipped', reason: 'social/vendor noise, carries no product question' };
  }
  for (const f of FORBIDDEN) {
    if (f.re.test(t)) return { decision: 'skipped', reason: 'NO HONEST MATCH - ' + f.why };
  }

  let best = null;
  for (const cap of CAPABILITIES) {
    const matched = cap.signals.filter((re) => re.test(t)).map(String);
    if (!matched.length) continue;
    if (!best || matched.length > best.matched.length) best = { cap, matched };
  }
  if (!best) return { decision: 'skipped', reason: 'no verified-WORKS capability matches this quote' };

  return {
    decision: 'mapped',
    capability_number: best.cap.n,
    capability_name: best.cap.name,
    ask_question: best.cap.ask[Math.min(ASK_INDEX, best.cap.ask.length - 1)],
    ask_alternatives: best.cap.ask,
    matched_signals: best.matched,
  };
}

// =========================================================================
// 3. SOURCING (live Supabase, read-only)
// =========================================================================

function envLocal(key) {
  const p = path.join(REPO, '.env.local');
  if (!fs.existsSync(p)) die('.env.local not found at ' + p);
  // Strip a UTF-8 BOM - it silently corrupts the first variable.
  const txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

async function sbSelect(table, query) {
  const url = envLocal('SUPABASE_URL') || envLocal('NEXT_PUBLIC_SUPABASE_URL');
  const key = envLocal('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + table + '?' + query, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  if (!res.ok) die('Supabase ' + table + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}

async function sourceCandidates() {
  const [reddit, tc] = await Promise.all([
    sbSelect('reddit_pain_language', 'select=id,subreddit,title,snippet,url,pain_categories,posted_at&limit=500'),
    sbSelect('tc_discovery_responses',
      'select=id,source_group,question_id,commenter_name,comment_text,comment_permalink,commented_at,is_own_comment&limit=500'),
  ]);

  const out = [];
  for (const r of reddit) {
    out.push({
      source_table: 'reddit_pain_language',
      row_id: r.id,
      author: 'r/' + r.subreddit,
      source_ref: r.url,
      captured_at: r.posted_at,
      // The scraper stores the post title + the opening of the body. Both are
      // verbatim Reddit text; the title is usually the actual question.
      verbatim_text: [r.title, r.snippet].filter(Boolean).join(' — '),
    });
  }
  for (const c of tc) {
    if (c.is_own_comment) continue;
    out.push({
      source_table: 'tc_discovery_responses',
      row_id: c.id,
      author: c.commenter_name,
      source_ref: c.comment_permalink || c.source_group,
      captured_at: c.commented_at,
      verbatim_text: c.comment_text,
    });
  }
  return out;
}

async function stageMap() {
  const all = await sourceCandidates();
  // Both source tables carry genuine duplicates (the same Reddit post scraped
  // under two ids; the same comment re-harvested). Counting them twice would
  // inflate the runway number, so collapse on normalised text.
  const seenText = new Set();
  const candidates = all.filter((c) => {
    const k = String(c.verbatim_text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
    if (!k || seenText.has(k)) return false;
    seenText.add(k);
    return true;
  });
  const rows = candidates.map((c) => {
    const m = mapQuote(c.verbatim_text, { author: c.author });
    return { ...c, ...m };
  });
  const mapped = rows.filter((r) => r.decision === 'mapped');
  const skipped = rows.filter((r) => r.decision === 'skipped');

  const doc = {
    generated_at: new Date().toISOString(),
    allowlist_source: 'docs/DOSSIE-VERIFIED-CAPABILITIES.md (verified 2026-09-14; WORKS items only)',
    note: 'Every `verbatim_text` is a REAL row from the live database. The mapper '
      + 'is allowed - and expected - to return "skipped" with a reason; a skipped '
      + 'quote is never stretched onto an adjacent capability.',
    counts: {
      rows_fetched: all.length,
      candidates: rows.length,
      mapped: mapped.length,
      skipped: skipped.length,
      by_capability: mapped.reduce((a, r) => {
        a[r.capability_number + ' — ' + r.capability_name] = (a[r.capability_number + ' — ' + r.capability_name] || 0) + 1;
        return a;
      }, {}),
    },
    mapped,
    skipped: skipped.map((r) => ({
      source_table: r.source_table, row_id: r.row_id, author: r.author,
      verbatim_text: r.verbatim_text.slice(0, 220), reason: r.reason,
    })),
  };

  if (!flag('dry-run')) {
    fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
    fs.writeFileSync(MAPPED_JSON, JSON.stringify(doc, null, 2));
  }
  console.log('\nMAPPER: ' + mapped.length + ' mapped / ' + rows.length + ' candidates'
    + ' (' + skipped.length + ' honestly skipped)');
  console.log(JSON.stringify(doc.counts.by_capability, null, 2));
  if (!flag('dry-run')) console.log('-> ' + MAPPED_JSON);
  return doc;
}

// =========================================================================
// 4. CAPTURE — delegated to the existing recorder
// =========================================================================
//
// scripts/record-dossie-shortform-frames.js already owns: the hard sign-in
// gate (URL not an auth route, zero password inputs in the DOM, signed-in
// shell, 4+ seeded demo addresses actually rendered, proof screenshot), the
// 1170x2532 screenshot loop, the frames.json manifest in exactly the shape the
// compositor reads, and the DOM-read timeline. Its `ask-dossie` flow types the
// question and waits for the real answer. None of that is re-implemented here.

function runRecorder(question) {
  const { spawnSync } = require('child_process');
  const recorder = path.join(HERE, 'record-dossie-shortform-frames.js');
  if (!fs.existsSync(recorder)) die('recorder not found at ' + recorder);
  const args = [recorder, '--flow', 'ask-dossie', '--out', OUT_DIR,
    '--question', question, '--fps', String(FPS), '--quality', String(QUALITY),
    '--url', APP_URL];
  if (flag('headed')) args.push('--headed');
  console.log('-> node ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) die('recorder exited ' + r.status + ' — no capture. Nothing is claimed.');
}

/**
 * A DIFFERENT failure mode from the address check, and the one that actually
 * bit us: the demo seed contains a COPY of one of Heath's real, live
 * transactions (29046 Pfeiffers Gate), complete with the real buyers' and
 * sellers' names. Those rows are flagged is_demo=true, so a tenancy check
 * passes - but naming real clients of a live deal in a public marketing video
 * is exactly the harm the tenancy check exists to prevent.
 *
 * So: any party name that appears on ANY non-demo transaction is forbidden on
 * screen, even when the same name is also present on a demo row.
 */
async function assertNoRealPartyNames(answerText) {
  const realRows = await sbSelect('transactions',
    'select=buyer_name,seller_name,property_address,user_id&limit=2000');
  const demoProfiles = await sbSelect('profiles', 'select=id&is_demo=eq.true&limit=200');
  const demoSet = new Set(demoProfiles.map((p) => p.id));
  const realNames = new Set();
  for (const r of realRows) {
    if (demoSet.has(r.user_id)) continue;           // demo rows are allowed
    for (const field of [r.buyer_name, r.seller_name]) {
      String(field || '').split(/,| and /i).forEach((n) => {
        const t = n.trim();
        if (t.length < 4) return;
        realNames.add(t.toLowerCase());
        const last = t.split(/\s+/).pop();
        if (last && last.length > 3) realNames.add(last.toLowerCase());
      });
    }
  }
  // Same rule for ADDRESSES. Exactly one address (29046 Pfeiffers Gate) is
  // present on BOTH a demo row and a real one, and from inside the app there is
  // no way to tell a seeded address from a live listing - so this has to be a
  // code check, not care.
  const realAddrs = new Set();
  for (const r of realRows) {
    if (demoSet.has(r.user_id)) continue;
    const a = String(r.property_address || '').trim();
    if (a.length > 6) realAddrs.add(a.toLowerCase());
  }
  const norm = (x) => ' ' + String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const hay = norm(answerText);
  const addrHits = [...realAddrs].filter((a) => hay.includes(norm(a).trim()));
  if (addrHits.length) {
    die('REAL (NON-DEMO) PROPERTY ADDRESS on screen in the answer: ' + addrHits.join(', ')
      + '\n  That address is on a live, non-demo transaction. Publishing it would'
      + '\n  broadcast a real deal stage/deadline. Refusing to emit a handoff.');
  }

  const hits = [...realNames].filter((n) => hay.includes(norm(n).trim()));
  if (hits.length) {
    die('REAL CLIENT NAME on screen in the answer: ' + [...new Set(hits)].join(', ')
      + '\n  These names appear on a NON-DEMO transaction (a live deal). The demo seed'
      + '\n  contains a copy of a real file, so "demo account" is not sufficient cover.'
      + '\n  Refusing to emit a handoff. Fix the demo seed, or ask a question scoped to'
      + '\n  a dossier whose parties are synthetic.');
  }
  console.log('SAFETY CHECK PASSED: no non-demo address and no non-demo client name in the answer.');
}

/**
 * crop_y advice for the answer segment (playbook 5a check 14).
 *
 * The capture is 1170x2532. A 9:16 window inside it is 2080px tall, so crop_y
 * (the window's top edge, in capture pixels) can range 0..452, and the window
 * maps onto the 1080x1920 output at scale 1920/2080 = 0.9231.
 *
 * The rule is: the answer bubble must be fully inside the window AND entirely
 * above the burned caption band. The fix is always crop_y, never shrinking the
 * footage (playbook 5 item 9 forbids that).
 */
function cropAdvice(answer) {
  const g = answer.answer_bubble_geometry;
  if (!g) return '- crop_y: answer bubble geometry was not recorded for this take.';
  const S = 3;                     // deviceScaleFactor
  const WIN = 2080;                // 9:16 window height inside a 1170x2532 capture
  const MAXY = 2532 - WIN;         // 452
  const SCALE = 1920 / WIN;        // 0.9231
  const CAP_TOP_OUT = 1480;        // top of the burned caption band, output px
  const top = Math.round(g.top_css * S);
  const bottom = Math.round(g.bottom_css * S);
  const needAbove = Math.round(bottom - CAP_TOP_OUT / SCALE); // crop_y must be >= this
  const lo = Math.max(0, needAbove);
  const hi = Math.min(MAXY, top);  // keep the bubble's top inside the window
  const ok = lo <= hi;
  return [
    '### crop_y for the answer segment',
    '',
    '- Answer bubble in capture pixels: top ' + top + ', bottom ' + bottom
      + ' (height ' + Math.round(g.height_css * S) + ').',
    '- 9:16 window is ' + WIN + 'px tall inside the ' + 2532 + 'px capture, so crop_y ∈ [0, ' + MAXY + '].',
    ok
      ? '- **Use crop_y ≈ ' + Math.round((lo + hi) / 2) + '** (any value in [' + lo + ', ' + hi + '] keeps the '
        + 'whole bubble inside the window AND clear of the caption band starting at output y≈'
        + CAP_TOP_OUT + ').'
      : '- **No crop_y fully satisfies both constraints** (need ≥ ' + lo + ' to clear the caption '
        + 'band but ≤ ' + hi + ' to keep the bubble top in frame). Either shorten the caption band '
        + 'or split the answer across two segments — do NOT shrink the footage.',
    '',
    '### Framing exclusions (both are PARTIAL/UNVERIFIED capabilities)',
    '',
    '- The **"Email Integration: Not connected — ENABLE IN SETTINGS"** banner sits in this panel.',
    '  Capability #19 (Connect Gmail) is PARTIAL and nobody has ever completed the flow. Keep it',
    '  out of any punch-in; it must not read as a featured capability.',
    '- The composer reads **"tap the mic to start a voice call"** and the app briefly shows a',
    '  **"🔊 Speaking…"** pill while it attempts TTS. Voice (#12) is PARTIAL/UNVERIFIED. Do not',
    '  punch in on, frame, or narrate the mic / speaking affordance. D1 is a TYPED question and a',
    '  TEXT answer.',
    '- A greyed **"Thinking…"** stub bubble persists BELOW the answer after it renders (an app',
    '  quirk, not a second pending question). It is harmless but reads as unfinished — prefer a',
    '  crop/punch-in that ends at the bottom of the answer bubble.',
  ].join('\n');
}

async function stageCapture(pickRow) {
  const question = pickRow.ask_question;
  // --skip-record re-emits the handoff (answer.json provenance + capture-notes.md)
  // from an existing capture in --out, without re-filming. Useful when only the
  // notes format changed; it never fabricates a capture that does not exist.
  if (flag('skip-record')) {
    if (!fs.existsSync(path.join(OUT_DIR, 'frames.json'))) {
      die('--skip-record but no existing capture in ' + OUT_DIR);
    }
    console.log('-> --skip-record: re-emitting handoff from the existing capture.');
  } else {
    runRecorder(question);
  }

  const framesPath = path.join(OUT_DIR, 'frames.json');
  const answerPath = path.join(OUT_DIR, 'answer.json');
  const timelinePath = path.join(OUT_DIR, 'timeline.md');
  for (const p of [framesPath, answerPath, timelinePath]) {
    if (!fs.existsSync(p)) die('recorder did not produce ' + p);
  }

  const answerPre = JSON.parse(fs.readFileSync(answerPath, 'utf8'));
  await assertNoRealPartyNames(answerPre.answer_verbatim);

  const framesDoc = JSON.parse(fs.readFileSync(framesPath, 'utf8'));
  if (!Array.isArray(framesDoc.frames) || framesDoc.frames.length < 30) {
    die('frames.json has only ' + (framesDoc.frames || []).length + ' frames — too short to be a real take.');
  }
  const durationMs = framesDoc.frames[framesDoc.frames.length - 1].ts;

  // Fold provenance into the recorder's answer.json so the compositor and any
  // later review can trace the question back to the real row it came from.
  const answer = JSON.parse(fs.readFileSync(answerPath, 'utf8'));
  answer.capability_number = pickRow.capability_number;
  answer.capability_name = pickRow.capability_name;
  answer.delivery_capability = '#11 Talk to Dossie (typed command, text answer) — WORKS';
  answer.provenance = {
    source_table: pickRow.source_table,
    row_id: pickRow.row_id,
    author: pickRow.author,
    source_ref: pickRow.source_ref,
    verbatim_quote: pickRow.verbatim_text,
    mapper_signals: pickRow.matched_signals,
  };
  fs.writeFileSync(answerPath, JSON.stringify(answer, null, 2));

  // capture-notes.md = the recorder's DOM-read timeline, with the provenance
  // header and the verbatim answer the compositor has to caption.
  const timeline = fs.readFileSync(timelinePath, 'utf8');
  const notes = [
    '# Ask Dossie capture — notes for the compositor',
    '',
    '## Provenance (nothing here was invented)',
    '',
    '- **Real quote** (`' + pickRow.source_table + '` row `' + pickRow.row_id + '`, ' + pickRow.author + '):',
    '', '  > ' + String(pickRow.verbatim_text).replace(/\n+/g, ' ').trim(), '',
    '- **Mapped to verified capability** #' + pickRow.capability_number + ' — ' + pickRow.capability_name,
    '- **Delivered through** capability #11, Talk to Dossie (typed command → text answer) — WORKS.',
    '  Capability #12 (spoken voice I/O) is PARTIAL/UNVERIFIED: the edit must never',
    '  imply Dossie spoke back or that anyone talked to her out loud.',
    '- **Question actually typed into the app:** `' + question + '`',
    '',
    '## Verbatim answer the app rendered',
    '',
    '> ' + answer.answer_verbatim,
    '',
    'Captions and Luna VO use this string **verbatim**. Trailing sentences may be',
    'CUT to fit runtime; rewording, re-ordering or paraphrasing is not allowed',
    '(playbook §5 items 6 / 6a, enforced by the compositor).',
    '',
    '- Answer arrived at **' + answer.answered_at_ms + 'ms** (' +
      (answer.answer_latency_ms / 1000).toFixed(1) + 's after Send). No claim about the',
    '  answer may sit over a frame before that ts (playbook §5a check 13).',
    '- Capture: ' + framesDoc.frames.length + ' frames, ' + (durationMs / 1000).toFixed(1) + 's, 1170x2532.',
    '',
    cropAdvice(answer),
    '- Account: demo@meetdossie.com (Sarah Whitley demo profile — no real customer data).',
    '',
    '---',
    '',
  ].join('\n') + timeline;
  fs.writeFileSync(path.join(OUT_DIR, 'capture-notes.md'), notes);

  console.log('\nHANDOFF');
  console.log('  frames dir     ' + FRAME_DIR);
  console.log('  frames.json    ' + framesPath + '  (' + framesDoc.frames.length + ' frames, '
    + (durationMs / 1000).toFixed(1) + 's)');
  console.log('  capture-notes  ' + path.join(OUT_DIR, 'capture-notes.md'));
  console.log('  answer.json    ' + answerPath);
  return { frames: framesDoc.frames.length, durationMs, answerVerbatim: answer.answer_verbatim };
}

// =========================================================================
// main
// =========================================================================
(async () => {
  let doc = null;
  if (STAGE === 'map' || STAGE === 'all') doc = await stageMap();
  if (STAGE === 'map' || flag('dry-run')) return;

  if (!doc) {
    if (!fs.existsSync(MAPPED_JSON)) die('no ' + MAPPED_JSON + ' — run --stage map first.');
    doc = JSON.parse(fs.readFileSync(MAPPED_JSON, 'utf8'));
  }
  if (!doc.mapped.length) die('mapper produced 0 honest matches — nothing to film. This is a valid outcome.');

  let row = doc.mapped[0];
  if (PICK) {
    row = doc.mapped.find((r) => r.row_id === PICK) || doc.mapped[Number(PICK)] || null;
    if (!row) die('--pick "' + PICK + '" matched no mapped row.');
  }
  // --ask-index re-selects from the capability's closed question set at capture
  // time, without having to re-run the mapper.
  if (ASK_INDEX && Array.isArray(row.ask_alternatives) && row.ask_alternatives[ASK_INDEX]) {
    row = { ...row, ask_question: row.ask_alternatives[ASK_INDEX] };
  }
  console.log('\nQUESTION SOURCE: ' + row.source_table + ' / ' + row.row_id + ' (' + row.author + ')');
  console.log('QUOTE: ' + row.verbatim_text.slice(0, 220));
  console.log('CAPABILITY: #' + row.capability_number + ' — ' + row.capability_name);
  console.log('ASK: ' + row.ask_question + '\n');

  await stageCapture(row);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));

module.exports = { mapQuote, CAPABILITIES, FORBIDDEN };
