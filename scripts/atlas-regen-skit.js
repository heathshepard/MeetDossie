// Atlas one-shot skit regen — picks a chosen pain pillar, runs through the
// SAME generate+validate logic as api/cron-generate-skit.js, saves to skit_queue,
// and pings Cole (Heath's chat via TELEGRAM_BOT_TOKEN / Claudy) with the draft.
//
// Usage:
//   node scripts/atlas-regen-skit.js --topic addendum_lost
//
// Why a separate script: the cron handler picks topic by week_of_year % 7,
// which would re-pick wrong_title_company today. This forces a chosen topic.

// Minimal .env.local loader (no dotenv dep)
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const CAPABILITY_VERBS = [
  'remembers', 'tracks', 'drafts', 'fills', 'sends', 'calculates',
  'reminds', 'organizes', 'files', 'books', 'attaches', 'signs',
  'scans', 'alerts', 'watches', 'surfaces', 'queues', 'completes',
];

const CAPABILITY_BANNED_PHRASES = [
  'meet dossie', 'try dossie', 'this is dossie', "she's got it",
  "dossie's got it", 'dossie helps', 'dossie can help',
  'dossie makes it easier', "dossie's there", 'get dossie',
  'download dossie',
];

const CTA_REQUIRED_SUBSTRING = 'meetdossie.com slash founding';

const TOPIC_LIBRARY = {
  addendum_lost: 'Agent sent the addendum to the wrong client and chaos ensues - she has 3 deals in flight and cannot remember which buyer got which version',
  tc_quit_italy: 'TC quit while agent was traveling in Italy',
  option_period_surprise: 'Agent did not realize option period expired',
  two_transactions_same_time: 'Agent managing 2 closings on the same day',
  lender_callback: 'Agent forgot which lender she promised a callback to - phone keeps buzzing with the wrong name',
  inspection_period: 'Agent realizes the inspection period is about to expire and she has not scheduled the inspector yet',
  escrow_confusion: 'Agent cannot remember which buyer wired their earnest money and which one still owes - title is asking',
};

const SKIT_SYSTEM_PROMPT = `You are generating a Dossie AI skit video script. Dossie is a real estate transaction management app for Texas agents. Brand voice: warm, feminine, capable.

NARRATIVE STRUCTURE - NON-NEGOTIABLE
Every skit must hit these four beats in order:
  Beat 1 (PAIN): Show the specific moment of agent pain. A real, vivid scenario.
  Beat 2 (COST): Make the cost of that pain feel concrete (lost deal, wrecked vacation, angry client).
  Beat 3 (CAPABILITY): One declarative narrator line that NAMES what Dossie does. THIS BEAT IS THE WHOLE POINT.
  Beat 4 (CTA): Bill closes with "Texas agents - meetdossie.com slash founding."

THE CAPABILITY BEAT (Beat 3) - HARD RULES
This is the line that turns the skit from "funny meme" into "ad that sells software." It is the single line a viewer must remember.

The capability beat line MUST:
  - Be spoken by bill (the narrator). Never by charlie or luna.
  - Contain the literal word "Dossie" (capitalized).
  - Contain at least ONE capability verb from this list:
    remembers, tracks, drafts, fills, sends, calculates, reminds, organizes,
    files, books, attaches, signs, scans, alerts, watches, surfaces, queues, completes
  - Name the SPECIFIC thing Dossie does (the addendum, the lender callback, the earnest money, etc.).
  - Be a flat declarative sentence. No questions. No vague "she's got it."

The capability beat line MUST NEVER be one of these banned phrases:
  "Meet Dossie", "Try Dossie", "This is Dossie", "She's got it",
  "Dossie's got it", "Dossie helps", "Dossie can help",
  "Dossie makes it easier", "Dossie's there", "Get Dossie", "Download Dossie"

VISUAL RULES (Kling scene prompts)
  - Exactly 4 Kling scenes. Scene 4 is the CTA card, auto-generated downstream - DO NOT include it.
  - Scene 0: ONE character clip (agent OR TC). Must contain an action/emotion word (stressed, rushing, sighing, exasperated, defeated, panicked, frustrated, overwhelmed).
  - Scenes 1-3: environment/object only. NO people. Phones, laptops, calendars, inboxes, text threads, desks.
  - Each character role appears AT MOST ONCE per skit.
  - Style lock REQUIRED on EVERY Kling prompt (exact string):
    "warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"
  - Environment prompts that risk implying people MUST start with: "Close-up shot, NO people in frame - "
  - NEVER say "same person" in any prompt.

DIALOGUE RULES
  - Voices available: charlie (agent male), luna (TC female), bill (narrator/deadpan).
  - Bill speaks the capability beat AND the CTA.
  - CTA must be exactly: "Texas agents - meetdossie.com slash founding."
  - Audio target: 28-44 seconds (~130 words/min, so ~60-95 words total across all lines).
  - Third person only. Personas illustrate pain - they are not speaking AS Dossie.
  - Plain ASCII only. No em-dashes (use plain "-"), no curly quotes.
  - No invented stats. Hypotheticals only.
  - Keep each individual line under 12 words. Short punchy lines beat long ones.
  - Beat 0 (the hook / pain line) must be SPECIFIC - not "managing transactions is hard." Reference the actual detail (a name, a doc, a deadline).

Return ONLY valid JSON with this exact structure:
{
  "topic": "short_slug_no_spaces",
  "caption": "Instagram/TikTok caption for this skit, max 150 chars, end with meetdossie.com/founding",
  "scenes": [
    {"type": "character", "role": "agent_stressed_female", "NO_PERSON": false, "prompt": "...warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"},
    {"type": "environment", "role": null, "NO_PERSON": true, "prompt": "Close-up shot, NO people in frame - ...warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"},
    {"type": "environment", "role": null, "NO_PERSON": true, "prompt": "Close-up shot, NO people in frame - ...warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"},
    {"type": "environment", "role": null, "NO_PERSON": true, "prompt": "Close-up shot, NO people in frame - ...warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"}
  ],
  "lines": [
    ["charlie", "Pain line - specific and short..."],
    ["bill", "Cost line - what it cost her..."],
    ["bill", "Dossie [capability verb] [specific thing]."],
    ["bill", "Texas agents - meetdossie.com slash founding."]
  ]
}`;

function generateSkitId(topic) {
  const date = new Date().toISOString().slice(0, 10);
  return `skit-${topic}-${date}-regen`;
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function validateCapabilityBeat(script) {
  if (!script || !Array.isArray(script.lines)) {
    return { ok: false, reason: 'script.lines is missing or not an array' };
  }

  const lines = script.lines.map((entry) => {
    if (Array.isArray(entry)) return { voice: String(entry[0] || ''), text: String(entry[1] || '') };
    if (entry && typeof entry === 'object') return { voice: String(entry.voice || entry[0] || ''), text: String(entry.text || entry[1] || '') };
    return { voice: '', text: '' };
  });

  let ctaIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.voice.toLowerCase() === 'bill' && l.text.toLowerCase().includes(CTA_REQUIRED_SUBSTRING)) {
      ctaIdx = i;
      break;
    }
  }
  if (ctaIdx === -1) return { ok: false, reason: `No bill line ending with "${CTA_REQUIRED_SUBSTRING}" found` };

  const preCtaBillLines = [];
  for (let i = 0; i < ctaIdx; i++) {
    if (lines[i].voice.toLowerCase() === 'bill') preCtaBillLines.push({ idx: i, text: lines[i].text });
  }
  if (preCtaBillLines.length === 0) return { ok: false, reason: 'No bill line before the CTA.' };

  for (const { idx, text } of preCtaBillLines) {
    const lower = text.toLowerCase();
    for (const banned of CAPABILITY_BANNED_PHRASES) {
      if (lower.includes(banned)) {
        return { ok: false, reason: `Bill line ${idx} contains banned phrase "${banned}": "${text}".` };
      }
    }
  }

  for (const { idx, text } of preCtaBillLines) {
    if (!/\bdossie\b/i.test(text)) continue;
    for (const verb of CAPABILITY_VERBS) {
      const re = new RegExp(`\\b${verb}\\b`, 'i');
      if (re.test(text)) return { ok: true, verb, matchedIdx: idx, matchedText: text };
    }
  }

  return { ok: false, reason: `No bill line contains BOTH "Dossie" AND a capability verb.` };
}

async function _generateOnce(topicId, topicDesc, extraGuidance) {
  let userMessage = `Generate a skit video script for this scenario: ${topicDesc}

Topic slug: ${topicId}

Pick a character voice appropriate for the scenario:
- For TC quitting scenarios: luna (TC female) + charlie (agent male)
- For agent-alone scenarios: charlie (agent male) + bill (narrator)
- Bill always speaks Beat 3 (capability) AND Beat 4 (CTA)

Make the dialogue feel like a real overheard conversation - specific, a little painful, and ultimately funny. Keep it tight (under 90 words for all lines combined).

REMEMBER: Beat 3 must name a specific Dossie capability. Beat 3 is the line a viewer remembers. Beat 0 hook must be specific - reference the actual detail (a name, a doc, a deadline).`;

  if (extraGuidance) userMessage += `\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${extraGuidance}\n\nFix that issue in this attempt.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: SKIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const rawContent = ((parsed?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  if (!rawContent) throw new Error('Anthropic empty content');

  let s = rawContent.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  return JSON.parse(s);
}

async function generate(topicId, topicDesc) {
  let lastReason = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[atlas-regen] Attempt ${attempt}/3${lastReason ? ' (retry)' : ''}`);
    let script;
    try { script = await _generateOnce(topicId, topicDesc, lastReason); }
    catch (err) {
      lastReason = `Generation error: ${err && err.message}`;
      console.warn(`[atlas-regen] Attempt ${attempt} threw: ${lastReason}`);
      if (attempt === 3) throw err;
      continue;
    }
    const check = validateCapabilityBeat(script);
    if (check.ok) {
      console.log(`[atlas-regen] Capability beat OK: verb="${check.verb}" line="${check.matchedText}"`);
      script._capability_beat = { verb: check.verb, line_index: check.matchedIdx, text: check.matchedText };
      return script;
    }
    lastReason = check.reason;
    console.warn(`[atlas-regen] Attempt ${attempt} failed validation: ${lastReason}`);
  }
  throw new Error(`Failed validation after 3 attempts. Last: ${lastReason}`);
}

async function sendToTelegram(skitId, script, topicId) {
  if (!TELEGRAM_BOT_TOKEN) { console.warn('[atlas-regen] No Telegram token'); return null; }

  const scenesPreview = (script.scenes || []).map((s, i) => {
    const typeLabel = s.type === 'character' ? '[character]' : '[env]';
    return `${i}: ${typeLabel} ${(s.prompt || '').slice(0, 60)}`;
  }).join('\n');

  const linesPreview = (script.lines || []).map(([v, t]) => `[${v}] "${t}"`).join('\n');
  const allWords = (script.lines || []).map(([, t]) => t).join(' ').split(/\s+/).filter(Boolean);
  const estSecs = Math.round(allWords.length / 2.17);

  const beatCheck = validateCapabilityBeat(script);
  const beatBlock = beatCheck.ok
    ? [`CAPABILITY BEAT:`, `[bill] "${beatCheck.matchedText}"`, `(verb: ${beatCheck.verb})`]
    : [`CAPABILITY BEAT: MISSING`, `Reason: ${beatCheck.reason}`];

  const msgText = [
    `FRESH SKIT DRAFT (regen):`,
    `Topic: ${script.topic || topicId}  (pillar: ${topicId})`,
    `Skit ID: ${skitId}`,
    ``,
    ...beatBlock,
    ``,
    `SCENES:`,
    scenesPreview,
    ``,
    `VOICEOVER:`,
    linesPreview,
    ``,
    `Caption: ${(script.caption || '').slice(0, 150)}`,
    `Est. duration: ~${estSecs}s`,
    ``,
    `Old wrong_title_company skit rejected. This is the regen. Heath: approve via DossieMarketingBot when it sends, or reply here with edits.`,
  ].join('\n');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msgText.slice(0, 4096),
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (data?.ok) { console.log(`[atlas-regen] Sent to Telegram, msg_id=${data?.result?.message_id}`); return data?.result?.message_id; }
  console.error('[atlas-regen] Telegram failed:', JSON.stringify(data).slice(0, 300));
  return null;
}

async function main() {
  const topicArg = process.argv.indexOf('--topic');
  if (topicArg === -1 || !process.argv[topicArg + 1]) {
    console.error('Usage: node scripts/atlas-regen-skit.js --topic <topic_id>');
    console.error('Topics:', Object.keys(TOPIC_LIBRARY).join(', '));
    process.exit(1);
  }
  const topicId = process.argv[topicArg + 1];
  const topicDesc = TOPIC_LIBRARY[topicId];
  if (!topicDesc) { console.error(`Unknown topic: ${topicId}`); process.exit(1); }

  console.log(`[atlas-regen] Topic: ${topicId} - ${topicDesc}`);

  const skitId = generateSkitId(topicId);
  const script = await generate(topicId, topicDesc);

  // Save to skit_queue
  const row = {
    id: skitId,
    topic: script.topic || topicId,
    script_json: script,
    caption: script.caption || null,
    status: 'script_pending',
    created_at: new Date().toISOString(),
  };
  const insertResult = await supabaseFetch('/rest/v1/skit_queue?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!insertResult.ok) {
    console.error('[atlas-regen] DB insert failed:', insertResult.status, JSON.stringify(insertResult.data).slice(0, 200));
    process.exit(1);
  }
  console.log(`[atlas-regen] Saved skit_queue id=${skitId}`);

  const messageId = await sendToTelegram(skitId, script, topicId);
  if (messageId) {
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_message_id: messageId }),
    });
  }

  console.log('[atlas-regen] DONE');
  console.log(JSON.stringify({ skit_id: skitId, topic: script.topic, lines: script.lines, capability_beat: script._capability_beat }, null, 2));
}

main().catch((e) => { console.error('[atlas-regen] FATAL:', e && e.message); process.exit(1); });
