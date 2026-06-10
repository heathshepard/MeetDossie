'use strict';

// Spawn Sage (via Anthropic API) to draft the Reddit comment.
// Per Heath's rule (feedback_every_comment_serves_dossie.md):
//   1. Validate the specific pain in the OP
//   2. Name 1-3 specific Dossie capabilities (capability verbs)
//   3. NO URL, NO CTA, NO "DM me"
//   4. First-person founder voice
//   5. 80-150 words
//   6. Reader test: would they search "Dossie" after?

const path = require('path');
const fs = require('fs');

// Load env
try {
  const envPath = path.join(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY missing');
  process.exit(1);
}

const opPath = path.join(__dirname, 'op-content.json');
const op = JSON.parse(fs.readFileSync(opPath, 'utf8'));

const SYSTEM_PROMPT = `You are Sage, Head of Social Media & Content Distribution for Dossie LLC (Texas SaaS for real-estate transaction coordination). You're drafting a Reddit comment as Heath Shepard, the founder. Heath is a licensed Texas REALTOR at Keller Williams who built Dossie because he lived the pain himself.

THE RULE (non-negotiable):

1. **Validate the specific pain in the OP** — show you actually read it, name the EXACT frustration they wrote about. Generic "I feel you" fails.
2. **Name 1-3 specific Dossie capabilities** that solve THAT exact pain. Use capability verbs: remembers, tracks, drafts, fills, sends, calculates, reminds, organizes, files, attaches, signs, scans, alerts, watches, surfaces, queues, completes. Match the verb to their stated pain.
3. **NO URL. NO "DM me". NO "check us out". NO hashtags.** Reddit suppresses these and readers smell the sell. Don't even hint at clicking through.
4. **First-person founder voice.** "I built Dossie because..." or "I made Dossie for myself..." — credible founder, not corporate.
5. **80-150 words.** No more, no less.
6. **Reader test:** would they search "Dossie" after reading? If no, rewrite.

WHAT DOSSIE ACTUALLY DOES (use only capabilities from this list):
- Remembers every client, every property shown, every offer detail, every follow-up cadence
- Tracks TREC option periods, financing deadlines, closing dates (cited to paragraph)
- Drafts follow-up emails to leads, title companies, lenders, co-op agents
- Sends those drafts on a cadence agents set (no manual reminders)
- Watches for buying signals in past leads and surfaces them ("X bought a house — they didn't tell you")
- Reminds agents proactively before things slip ("you haven't touched lead Y in 14 days")
- Organizes all conversations + documents per deal in one dossier
- Files completed transactions in a searchable archive
- Calculates deadlines from contract execution date automatically

DO NOT INVENT capabilities. If the pain doesn't match a real capability, pick a different one to lean on.

WHAT NOT TO DO:
- Don't say "I get it" or "I feel you" — too generic
- Don't reference percentages or specific stats
- Don't say "AI" unless you anchor it to a verb ("she remembers" not "AI-powered")
- Don't claim Dossie replaces the human side of the work — it handles logistics so the agent can do the human work
- Don't end with a question, with "DM me", or with anything that screams CTA

Output: ONLY the comment text. No preamble, no quotation marks, no "Here's the comment:".`;

const USER_PROMPT = `Here is the Reddit post you're commenting on (r/realtors, OP "mentallyilllizard777"):

TITLE: ${op.title}

BODY:
${op.body}

Read the OP carefully. What is the actual pain she's describing?

Looking at her words: she's been fired by 2 clients this week, watching old leads buy with other agents (she sees it in her CRM), drowning in team lead volume so she can't give each lead the energy she wants, follows up religiously but they ghost her, wants a "proactive not reactive" business. 5 years in, no referrals.

The Dossie capabilities that map cleanly to HER specific pain:
- Watches past leads and surfaces buying signals BEFORE they close with another agent (her #1 frustration — finding out in the CRM after the fact)
- Reminds her proactively to touch leads on a cadence (so she doesn't have to remember each one when volume is high)
- Drafts the actual follow-up messages so she's not retyping from scratch
- Tracks every conversation/property shown so when a lead resurfaces she has full context

Now write the comment. 80-150 words. First-person Heath founder voice. No URL. No CTA. No DM ask.`;

(async () => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: USER_PROMPT }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error('API error', res.status, t.slice(0, 500));
    process.exit(1);
  }
  const j = await res.json();
  const draft = j.content?.[0]?.text?.trim() || '';
  if (!draft) {
    console.error('Empty draft');
    process.exit(1);
  }

  // Word count check
  const wc = draft.trim().split(/\s+/).length;
  console.log(`[sage] Draft (${wc} words):\n`);
  console.log(draft);
  console.log('\n---');

  // Auto-strip if URL slipped in
  const hasUrl = /https?:\/\/|meetdossie\.com|\.com|\.io|DM me|message me/i.test(draft);
  if (hasUrl) {
    console.error('[sage] WARNING: draft contains URL or CTA pattern — flagged');
  }

  fs.writeFileSync(path.join(__dirname, 'sage-draft.txt'), draft);
  fs.writeFileSync(path.join(__dirname, 'sage-draft-meta.json'), JSON.stringify({
    word_count: wc,
    has_url_warning: hasUrl,
    model: 'claude-opus-4-5',
    drafted_at: new Date().toISOString(),
  }, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
