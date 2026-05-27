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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

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

RULES (enforced - do not violate):
- 4 scenes + 1 CTA (CTA is auto-generated, do not include it)
- Scene 0: character clip - one character (agent or TC), shown ONCE, must have an action/emotion word (stressed, rushing, sighing, exasperated, defeated, panicked, frustrated, overwhelmed)
- Scenes 1-3: environment/object only - NO people. Phone, laptop, calendar, inbox, text thread, desk items
- Each character role appears AT MOST ONCE per skit
- Style lock required on EVERY Kling prompt: "warm cinematic lighting, shallow depth of field, golden hour tones, 9:16 vertical aspect ratio, photorealistic"
- Environment clips (1-3): if prompt might imply people, prepend "Close-up shot, NO people in frame - "
- Voices available: charlie (agent male), luna (TC female), bill (narrator/deadpan)
- Audio duration target: 28-44 seconds (~130 words/minute)
- Never say "same person" in Kling prompts
- Always end with bill saying: "meetdossie.com slash founding"

PERSONA VOICE - CRITICAL:
- Write in THIRD PERSON, never first person
- No em-dashes (use plain hyphens -), no curly quotes, plain ASCII only
- No invented stats - frame as hypotheticals only

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
    ["bill", "Narrator line..."],
    ["charlie", "Agent line..."],
    ["bill", "meetdossie.com slash founding"]
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

async function generateSkitScript(topic) {
  const userMessage = `Generate a skit video script for this scenario: ${topic.desc}

Topic slug: ${topic.id}

Pick a character voice appropriate for the scenario:
- For TC quitting scenarios: luna (TC female) + charlie (agent male)
- For agent-alone scenarios: charlie (agent male) + bill (narrator)
- Bill always closes with the CTA line

Make the dialogue feel like a real overheard conversation - specific, a little painful, and ultimately funny. Keep it tight (under 120 words for all lines combined).`;

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

  const rawContent = parsed?.content?.[0]?.text;
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

  const msgText = [
    `SKIT SCRIPT READY FOR APPROVAL`,
    `Topic: ${script.topic || skitId}`,
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

module.exports = async function handler(req, res) {
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
};
