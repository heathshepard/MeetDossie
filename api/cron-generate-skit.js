// Vercel Serverless Function: /api/cron-generate-skit
// Runs Tuesday + Friday at 11 AM UTC (6 AM CDT).
//
// What it does:
//   1. Auth check: x-vercel-cron: 1 OR Authorization: Bearer {CRON_SECRET}
//   2. Generate a skit script via Claude Haiku using enforced production rules
//   3. Save to skit_queue Supabase table with status='script_pending'
//   4. Send the script to DossieMarketingBot for Heath's approval
//   5. Return 200 OK
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 11 * * 2,5"

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// CAPABILITY BEAT RULE (Sage's diagnosis, Heath approved 2026-06-09 "Paradise Lost"):
// Every skit MUST have a Bill narrator line BEFORE the CTA that contains:
//   1. The literal word "Dossie"
//   2. A specific capability verb (from CAPABILITY_VERBS)
//   3. The specific thing Dossie does
// Vague closers ("Meet Dossie", "She's got it", etc.) are banned.
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

// Topic rotation — 7 topics, pick by week_of_year % 7
const SKIT_TOPICS = [
  { id: 'tc_quit_italy',           desc: 'TC quit while agent was traveling in Italy' },
  { id: 'option_period_surprise',  desc: 'Agent did not realize option period expired' },
  { id: 'five_followups',          desc: 'Agent has followed up 5 times, still waiting' },
  { id: '11pm_text',               desc: 'Client texts at 11PM asking about a deadline' },
  { id: 'wrong_title_company',     desc: 'Agent cannot remember which title company was used' },
  { id: 'two_transactions_same_time', desc: 'Agent managing 2 closings on the same day' },
  { id: 'addendum_lost',           desc: 'Addendum sent to wrong client, chaos ensues' },
];

const SKIT_SYSTEM_PROMPT = `You are generating a Dossie AI skit video script. Dossie is a real estate transaction management app for Texas agents. Brand voice: warm, feminine, capable.

NARRATIVE STRUCTURE - NON-NEGOTIABLE
Every skit must hit these four beats in order:
  Beat 1 (PAIN): Show the specific moment of agent pain. A real, vivid scenario.
  Beat 2 (COST): Make the cost of that pain feel concrete (lost deal, wrecked vacation, angry client).
  Beat 3 (CAPABILITY): One declarative narrator line that NAMES what Dossie does. THIS BEAT IS THE WHOLE POINT.
  Beat 4 (CTA): Bill closes with "Texas agents - meetdossie.com slash founding."

THE CAPABILITY BEAT (Beat 3) - HARD RULES
This is the line that turns the skit from "funny meme" into "ad that sells software." It is the single line a viewer must remember. It is also the line every previous skit got wrong.

The capability beat line MUST:
  - Be spoken by bill (the narrator). Never by charlie or luna.
  - Contain the literal word "Dossie" (capitalized).
  - Contain at least ONE capability verb from this list:
    remembers, tracks, drafts, fills, sends, calculates, reminds, organizes,
    files, books, attaches, signs, scans, alerts, watches, surfaces, queues, completes
  - Name the SPECIFIC thing Dossie does (the title company, the option deadline, the addendum, the inbox, etc.).
  - Be a flat declarative sentence. No questions. No vague "she's got it."

The capability beat line MUST NEVER be one of these banned phrases:
  "Meet Dossie", "Try Dossie", "This is Dossie", "She's got it",
  "Dossie's got it", "Dossie helps", "Dossie can help",
  "Dossie makes it easier", "Dossie's there", "Get Dossie", "Download Dossie"

WRONG examples (do not generate anything like these):
  bill: "Meet Dossie."
  bill: "She's got it."
  bill: "Dossie can help."
  bill: "Try Dossie."

RIGHT examples (this is what we want):
  bill: "Dossie remembers every title company on every deal."
  bill: "Dossie drafts the amendment, attaches it to the right client, and sends."
  bill: "Dossie tracks every TREC deadline so you don't have to."
  bill: "Dossie watches the inbox and surfaces the one email that matters."
  bill: "Dossie texts your inspector the morning of."

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
    ["charlie", "Pain line..."],
    ["bill", "Cost line..."],
    ["bill", "Dossie [capability verb] [specific thing]."],
    ["bill", "Texas agents - meetdossie.com slash founding."]
  ]
}`;

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function generateSkitId(topic) {
  const date = new Date().toISOString().slice(0, 10);
  return `skit-${topic}-${date}`;
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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// Validate the capability beat: there MUST be a bill line BEFORE the CTA
// that contains "dossie" + a capability verb. Banned closer phrases auto-fail.
// Returns { ok: true, verb, matchedIdx, matchedText } on success,
// or { ok: false, reason } on failure.
function validateCapabilityBeat(script) {
  if (!script || !Array.isArray(script.lines)) {
    return { ok: false, reason: 'script.lines is missing or not an array' };
  }

  const lines = script.lines.map((entry) => {
    if (Array.isArray(entry)) return { voice: String(entry[0] || ''), text: String(entry[1] || '') };
    if (entry && typeof entry === 'object') return { voice: String(entry.voice || entry[0] || ''), text: String(entry.text || entry[1] || '') };
    return { voice: '', text: '' };
  });

  // Find CTA line: LAST bill line containing CTA_REQUIRED_SUBSTRING (case-insensitive)
  let ctaIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.voice.toLowerCase() === 'bill' && l.text.toLowerCase().includes(CTA_REQUIRED_SUBSTRING)) {
      ctaIdx = i;
      break;
    }
  }
  if (ctaIdx === -1) {
    return { ok: false, reason: `No bill line ending with "${CTA_REQUIRED_SUBSTRING}" found` };
  }

  // Pre-CTA bill lines
  const preCtaBillLines = [];
  for (let i = 0; i < ctaIdx; i++) {
    if (lines[i].voice.toLowerCase() === 'bill') {
      preCtaBillLines.push({ idx: i, text: lines[i].text });
    }
  }
  if (preCtaBillLines.length === 0) {
    return { ok: false, reason: 'No bill line before the CTA. Beat 3 (capability) must be spoken by bill.' };
  }

  // Reject any banned phrase appearing in pre-CTA bill lines
  for (const { idx, text } of preCtaBillLines) {
    const lower = text.toLowerCase();
    for (const banned of CAPABILITY_BANNED_PHRASES) {
      if (lower.includes(banned)) {
        return {
          ok: false,
          reason: `Bill line ${idx} contains banned vague phrase "${banned}": "${text}". Replace with a specific capability beat (e.g. "Dossie tracks every TREC deadline.").`,
        };
      }
    }
  }

  // Look for a pre-CTA bill line containing "dossie" + a capability verb (word-boundary)
  for (const { idx, text } of preCtaBillLines) {
    const lower = text.toLowerCase();
    if (!/\bdossie\b/i.test(text)) continue;
    for (const verb of CAPABILITY_VERBS) {
      const re = new RegExp(`\\b${verb}\\b`, 'i');
      if (re.test(text)) {
        return { ok: true, verb, matchedIdx: idx, matchedText: text };
      }
    }
  }

  return {
    ok: false,
    reason: `No bill line before the CTA contains BOTH "Dossie" AND a capability verb (${CAPABILITY_VERBS.join(', ')}). Add a line like "Dossie tracks every TREC deadline" or "Dossie drafts the amendment and sends it."`,
  };
}

async function _generateSkitScriptOnce(topic, extraGuidance) {
  let userMessage = `Generate a skit video script for this scenario: ${topic.desc}

Topic slug: ${topic.id}

Pick a character voice appropriate for the scenario:
- For TC quitting scenarios: luna (TC female) + charlie (agent male)
- For agent-alone scenarios: charlie (agent male) + bill (narrator)
- Bill always speaks Beat 3 (capability) AND Beat 4 (CTA)

Make the dialogue feel like a real overheard conversation - specific, a little painful, and ultimately funny. Keep it tight (under 120 words for all lines combined).

REMEMBER: Beat 3 must name a specific Dossie capability. Beat 3 is the line a viewer remembers.`;

  if (extraGuidance) {
    userMessage += `\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${extraGuidance}\n\nFix that issue in this attempt.`;
  }

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

  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error('Anthropic returned non-JSON response');
  }

  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const rawContent = ((parsed?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  if (!rawContent) throw new Error('Anthropic returned empty content');

  // Extract JSON from content (strip any markdown fences)
  let s = rawContent.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(s);
}

async function generateSkitScript(topic) {
  const MAX_ATTEMPTS = 3;
  let lastReason = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[cron-generate-skit] Generation attempt ${attempt}/${MAX_ATTEMPTS}${lastReason ? ' (retry)' : ''}`);
    let script;
    try {
      script = await _generateSkitScriptOnce(topic, lastReason);
    } catch (err) {
      lastReason = `Generation error: ${err && err.message}`;
      console.warn(`[cron-generate-skit] Attempt ${attempt} threw: ${lastReason}`);
      if (attempt === MAX_ATTEMPTS) throw err;
      continue;
    }

    const check = validateCapabilityBeat(script);
    if (check.ok) {
      console.log(`[cron-generate-skit] Capability beat OK on attempt ${attempt}: verb="${check.verb}" line="${check.matchedText}"`);
      script._capability_beat = {
        verb: check.verb,
        line_index: check.matchedIdx,
        text: check.matchedText,
      };
      return script;
    }

    lastReason = check.reason;
    console.warn(`[cron-generate-skit] Attempt ${attempt} failed capability-beat validation: ${lastReason}`);
  }

  throw new Error(
    `Skit script failed capability-beat validation after ${MAX_ATTEMPTS} attempts. Last reason: ${lastReason}`
  );
}

async function sendSkitForApproval(skitId, script) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-generate-skit] No Telegram token — skipping approval send');
    return null;
  }

  // Format scenes preview
  const scenesPreview = (script.scenes || []).map((s, i) => {
    const typeLabel = s.type === 'character' ? '[character]' : '[env]';
    const promptPreview = (s.prompt || '').slice(0, 60);
    return `${i}: ${typeLabel} ${promptPreview}`;
  }).join('\n');

  // Format voiceover
  const linesPreview = (script.lines || []).map(([voice, text]) => {
    return `[${voice}] "${text}"`;
  }).join('\n');

  // Estimate duration: ~130 words/min = 2.17 words/sec
  const allWords = (script.lines || []).map(([, t]) => t).join(' ').split(/\s+/).filter(Boolean);
  const estSecs = Math.round(allWords.length / 2.17);

  // Re-validate to surface the capability beat for Heath's quick scan
  const beatCheck = validateCapabilityBeat(script);
  const beatBlock = beatCheck.ok
    ? [
        `CAPABILITY BEAT (the line that explains what Dossie does):`,
        `[bill] "${beatCheck.matchedText}"`,
        `(verb: ${beatCheck.verb})`,
      ]
    : [
        `CAPABILITY BEAT: MISSING`,
        `Reason: ${beatCheck.reason}`,
      ];

  const msgText = [
    `SKIT SCRIPT READY FOR APPROVAL`,
    `Topic: ${script.topic || skitId}`,
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
  ].join('\n');

  const inline_keyboard = [[
    { text: 'Approve - Render It', callback_data: `skit_approve_${skitId}` },
    { text: 'Reject', callback_data: `skit_reject_${skitId}` },
  ]];

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msgText.slice(0, 4096),
        reply_markup: { inline_keyboard },
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data?.ok) {
      console.log(`[cron-generate-skit] Sent to Telegram, message_id=${data?.result?.message_id}`);
      return data?.result?.message_id || null;
    } else {
      console.error('[cron-generate-skit] Telegram send failed:', JSON.stringify(data).slice(0, 300));
      return null;
    }
  } catch (err) {
    console.error('[cron-generate-skit] Telegram error:', err && err.message);
    return null;
  }
}

module.exports = withTelemetry('cron-generate-skit', async function handler(req, res) {
  // Auth check
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Pick topic based on week_of_year % 7
  const weekNum = getWeekNumber(new Date());
  const topicIdx = weekNum % SKIT_TOPICS.length;
  const topic = SKIT_TOPICS[topicIdx];
  const skitId = generateSkitId(topic.id);

  console.log(`[cron-generate-skit] Week ${weekNum}, topic[${topicIdx}]: ${topic.id}`);
  console.log(`[cron-generate-skit] Skit ID: ${skitId}`);

  // Generate script via Claude Haiku
  let script;
  try {
    script = await generateSkitScript(topic);
    console.log(`[cron-generate-skit] Script generated for topic: ${script.topic}`);
  } catch (err) {
    console.error('[cron-generate-skit] Script generation failed:', err && err.message);
    return res.status(500).json({ ok: false, error: `Script generation failed: ${err && err.message}` });
  }

  // Save to skit_queue with status='script_pending'
  const row = {
    id: skitId,
    topic: script.topic || topic.id,
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
    console.error('[cron-generate-skit] DB insert failed:', insertResult.status, JSON.stringify(insertResult.data).slice(0, 200));
    return res.status(502).json({ ok: false, error: 'Failed to save skit to DB' });
  }

  console.log(`[cron-generate-skit] Saved to skit_queue: id=${skitId}`);

  // Send to Telegram for Heath's approval
  const messageId = await sendSkitForApproval(skitId, script);

  // Update telegram_message_id if we got one
  if (messageId) {
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_message_id: messageId }),
    });
  }

  return res.status(200).json({
    ok: true,
    skit_id: skitId,
    topic: script.topic,
    telegram_message_id: messageId,
    lines_count: (script.lines || []).length,
  });
});
