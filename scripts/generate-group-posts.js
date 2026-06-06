'use strict';

// scripts/generate-group-posts.js
//
// Reads group_registry where skip=false and cool-down has passed.
// For each eligible group, calls Claude Haiku to generate fresh post copy
// based on FB-GROUP-PLAYBOOK.md templates, inserts a group_posts row,
// and sends two messages to DossieMarketingBot for one-tap approval.
//
// Usage:
//   node scripts/generate-group-posts.js
//   node scripts/generate-group-posts.js --dry-run   # generate but don't send to Telegram
//   node scripts/generate-group-posts.js --group-id [uuid]  # single group only
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   TELEGRAM_MARKETING_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');

// Load .env.local when running locally
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env.local');
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
} catch (e) {
  // Non-fatal — env vars may already be set
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const groupIdFilter = (() => {
  const idx = args.indexOf('--group-id');
  return idx >= 0 ? args[idx + 1] : null;
})();

// ─── Supabase helpers ─────────────────────────────────────────────────────────

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

// ─── Template library ─────────────────────────────────────────────────────────
// Maps category to available template IDs and their scaffold copy.
// Haiku rewrites the scaffold in Heath's voice — we never post the scaffold verbatim.

const TEMPLATES = {
  texas_agent_networking: [
    {
      id: 'A-1',
      pillar: 'control',
      scaffold: `Does anyone else just... dread the option period window?

Like I know what I'm supposed to be tracking. I know the deadlines. But I'm also showing houses, answering lender calls, and trying not to miss my kid's thing on Saturday.

I had a deal where I miscalculated the option period end date by one day. One day. My client almost lost $2,500 in option fee money.

How are y'all tracking these? Still spreadsheets? Your brokerage system? Something else? Genuinely curious what's working.`,
      first_comment: `For anyone who asked - I built something specifically for this. It's called Dossie. AI transaction coordinator, auto-calculates every TREC deadline from contract date, sends me reminders, tracks all the documents. Texas agents only right now. meetdossie.com/founding - first 50 agents get in at founding pricing.`,
    },
    {
      id: 'A-2',
      pillar: 'cost',
      scaffold: `Hot take: hiring a TC is one of the most expensive mistakes a solo agent can make when they're under 20 deals a year.

I know that's controversial. Hear me out.

At $300-400/file, if you're doing 15 deals a year, you're spending $4,500-6,000 just to hand off paperwork and follow up with title. That's money you could put into leads, marketing, or just... keeping.

The agents I see thriving solo have systems, not staff. They know exactly where every deal stands without calling anyone to ask.

Curious if others see it this way or if I'm completely off base.`,
      first_comment: `A few people asked what system I use - meetdossie.com/founding is where I'm telling people right now. AI does the tracking, the deadline math, the follow-up sequencing. Founding pricing is still open for a few more spots.`,
    },
    {
      id: 'A-3',
      pillar: 'visibility',
      scaffold: `I had a client who almost fired me last month. Not because of anything I did wrong on the deal - because I went 18 hours without responding to a document request during inspection.

I was in back-to-back showings. The request came in at 10am, I didn't see it until 6pm. She panicked, called her sister who's also a realtor, and I got a "we might need to make a change" text.

Fixed it - she stayed - but I spent that week rethinking how I track in-flight deals. There's a lot of visibility problems hiding in every transaction that just don't surface until they explode.

Anyone else had a close call like that? What did you change after?`,
      first_comment: `Fwiw - what I changed: meetdossie.com/founding. Dossie pings me on pending docs, tracks every deadline automatically, sends me a morning brief on what's due that day. Pretty much eliminated the 18-hour blackout problem.`,
    },
    {
      id: 'A-4',
      pillar: 'control',
      scaffold: `Quick question for my Texas agent folks -

How do you currently track your TREC deadlines across open transactions?

A) My brokerage's system (Dotloop/SkySlope/etc)
B) My own spreadsheet
C) A physical calendar or notes app
D) I have a TC who handles it

Genuinely curious - I've been rethinking my whole setup lately and want to hear what's actually working for people.`,
      first_comment: `Love seeing these answers - the spread is wild. For what it's worth, I've been using an AI that auto-calculates every TREC deadline from contract date and sends daily deal briefs. meetdossie.com/founding if you're in the B or C camp and want to try something different.`,
    },
  ],
  trec_education: [
    {
      id: 'B-1',
      pillar: 'speed',
      scaffold: `PSA for Texas agents - with the new TREC forms going mandatory July 1, a few things worth knowing:

The 20-19 Resale Contract replaces the 20-18. The financing addendum becomes 40-12. Amendment goes to 39-11. These aren't optional after July 1 - old version forms are retired.

But here's the part that trips people up: the deadline math in the new forms works the same way as the old ones. The numbering changed, not the mechanics. Your option period is still calculated from the effective date. Your closing date is still based on the terms in Section 5.

If your brokerage system hasn't updated its form templates yet - check now, not June 30.

Anyone's brokerage already using the new versions? Curious who's ahead of it.`,
      first_comment: `I use Dossie for deadline tracking - it'll be updated to the new form versions before July 1. meetdossie.com/founding if you want to see it.`,
    },
    {
      id: 'B-2',
      pillar: 'control',
      scaffold: `Real question about the option period for the Texas agents here:

When you receive the option fee check - do you document the exact time it was received? Not just the date?

I ask because TREC is very specific that the option period begins at the time of contract execution, not when the fee is delivered. But if there's ever a dispute about whether the fee was delivered before the option period expired, you want a timestamp.

Learned this the hard way watching a deal almost unravel because of a "what time did you drop off the check" argument between the buyer's agent and the title company.

What's your process for documenting option fee receipt?`,
      first_comment: `Dossie tracks document uploads with timestamps - I use it for exactly this reason. meetdossie.com/founding`,
    },
    {
      id: 'B-3',
      pillar: 'control',
      scaffold: `I've been going deep on the new TREC forms ahead of the July 1 mandatory deadline and I have a genuine question for brokers and educators in here:

The new OP-H Seller's Disclosure adds four new categories: insurance issues, private roads, above-ground storage tanks, and conservation easements.

For sellers who have properties with none of these - do you walk them through each item anyway and document the conversation, or do you consider a clean N/A column sufficient?

I'm asking because I'm updating my transaction checklist and I want to make sure I'm not creating a gap for my sellers.`,
      first_comment: `For what it's worth, I've been tracking TREC updates pretty closely because I built a tool that auto-maps form versions to transactions. Happy to share what I've found on the new disclosures if useful.`,
    },
  ],
  hyperlocal: [
    {
      id: 'C-1',
      pillar: 'visibility',
      scaffold: `Is anyone else seeing buyers in the Hill Country getting more aggressive on inspection repair requests this spring?

I'm working a deal near Boerne right now where the buyer came back asking for $11k in credits on a $485k house after a pretty clean inspection. Two years ago that request gets laughed at. This month the seller caved.

Feels like the leverage is shifting. Curious if others in this market are seeing the same thing or if this was just a motivated seller situation.`,
      first_comment: `I've been tracking my deals more granularly since I started using Dossie - helps me see patterns across transactions. meetdossie.com/founding if you're curious.`,
    },
    {
      id: 'C-2',
      pillar: 'speed',
      scaffold: `San Antonio/Hill Country agents - quick one:

How long is your average time from executed contract to clear to close right now?

A) Under 21 days
B) 21-30 days
C) 30-45 days
D) 45+ (title is a mess right now)

Feels like things have stretched out lately. Curious if that's market-wide or just my pipeline.`,
      first_comment: `I track my close timelines in Dossie - the pipeline view makes it easy to spot which title companies are running slow. meetdossie.com/founding if you want to see it.`,
    },
    {
      id: 'C-3',
      pillar: 'visibility',
      scaffold: `Looking for a great lender recommendation for a buyer I'm working with near New Braunfels - conventional loan, solid credit, first-time buyer. Who are y'all using and loving right now in this market?

Happy to send referrals back your way - I work mostly Boerne/Hill Country/San Antonio.`,
      first_comment: null,
    },
  ],
  broker_team_lead: [
    {
      id: 'D-1',
      pillar: 'cost',
      scaffold: `Systems question for the team leads and brokers in here:

At what transaction volume does it stop making sense to manage deals yourself and start making sense to build a dedicated ops layer?

I've watched agents at 30+ deals/year burn out not because they can't sell, but because they're doing the same administrative work 30 separate times. The ceiling isn't sales skill - it's process leverage.

What does your ops setup look like at scale? Still using TCs per file? In-house TC? Something else?`,
      first_comment: `For what it's worth - I've been using AI to handle the ops layer. meetdossie.com/founding - Texas agents, founding pricing still open.`,
    },
    {
      id: 'D-2',
      pillar: 'visibility',
      scaffold: `Interesting data point for anyone thinking about transaction ops:

A typical residential transaction involves 87+ deadline-sensitive touchpoints from executed contract to close. Most agents have a mental model of maybe 10-15 of them. The other 70+ are time-sensitive things that can fall through without a system.

The agents who scale aren't necessarily the best salespeople - they're the ones who've systemized everything below the relationship layer.

What's the thing you've systemized that made the biggest difference in your business?`,
      first_comment: `I built Dossie specifically to handle the ops layer - deadline tracking, document management, daily deal briefs. meetdossie.com/founding if you want to see how it works.`,
    },
    {
      id: 'D-3',
      pillar: 'control',
      scaffold: `Broker question - what's your policy when an agent on your team misses a TREC deadline?

Not asking about anything specific, more curious how different brokerages handle it. Is it a coaching conversation? Written documentation? Pull them from a deal?

Trying to understand what accountability structures actually work at the brokerage level.`,
      first_comment: null,
    },
  ],
  national: [
    {
      id: 'E-1',
      pillar: 'speed',
      scaffold: `Question for the agents in here - what's the one administrative task in your transactions that takes the most time but adds the least value for your clients?

For me it's chasing document signatures. I can spend 45 minutes of a day just following up on things that should take 5.

Curious what yours is.`,
      first_comment: `I built something to handle this for myself - AI transaction coordinator. Happy to share if anyone wants details.`,
    },
    {
      id: 'E-2',
      pillar: 'cost',
      scaffold: `Real talk: the agents who will thrive in the next 5 years are the ones who figure out how to do more with less overhead, not the ones who hire more people.

The market punishes agents with high fixed costs in slow years. The ones with lean operations and good systems survive every cycle.

Agree/disagree?`,
      first_comment: `For what it's worth - the system I landed on is AI handling my transaction ops. meetdossie.com/founding if you're curious what that looks like.`,
    },
  ],
  buyer_seller: [],
};

// Pick a template for the group, avoiding the last-used template if possible.
// Returns { template, templateId } or null if no templates available.
function pickTemplate(category, lastTemplateId) {
  const pool = TEMPLATES[category] || [];
  if (!pool.length) return null;

  // Filter out last-used template to avoid repeating
  const candidates = pool.length > 1
    ? pool.filter((t) => t.id !== lastTemplateId)
    : pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Claude Haiku ─────────────────────────────────────────────────────────────

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

async function generatePostWithHaiku(group, template) {
  const categoryLabel = {
    texas_agent_networking: 'Texas Agent Networking',
    trec_education: 'TREC / Compliance / Education',
    hyperlocal: 'Market-Specific / Hyperlocal',
    broker_team_lead: 'Broker / Team Lead',
    national: 'National / General',
    buyer_seller: 'Buyer / Seller',
  }[group.category] || group.category;

  const prompt = `You are writing a Facebook group post for Heath Shepard, a licensed Texas REALTOR based in San Antonio / Hill Country. Heath is also the founder of Dossie (an AI transaction coordinator for Texas agents), but he NEVER mentions Dossie in the post body.

GROUP: ${group.group_name}
CATEGORY: ${categoryLabel}
TEMPLATE ID: ${template.id}
CONTENT PILLAR: ${template.pillar}

TEMPLATE SCAFFOLD (rewrite this - do not copy verbatim):
---
${template.scaffold}
---

RULES - NON-NEGOTIABLE:
1. Write in Heath's voice: warm, casual, genuine, first-person, self-deprecating. No corporate language.
2. Do NOT mention Dossie in the post body. Ever.
3. Do NOT include any links in the post body.
4. End with a genuine open question that invites comments.
5. Keep the same general topic and structure as the scaffold, but write fresh copy. Different wording, different specific details, same emotional truth.
6. Plain ASCII only - no em-dashes, no curly quotes, no special Unicode. Use plain hyphens (-) and straight quotes only.
7. For TREC/education posts: all facts must be accurate. July 1 2026 is the mandatory deadline for new TREC form versions.
8. Length: 100-300 words depending on template type. Polls can be shorter. Stories need more room.

FIRST COMMENT (rewrite this too, keep Dossie mention natural):
---
${template.first_comment || '(no first comment for this template)'}
---

Return STRICT JSON only. No markdown. No commentary.

{
  "post_body": "<the rewritten post, plain text, newlines allowed>",
  "first_comment_body": "<rewritten first comment with Dossie mention, or null if template has no first comment>"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);

  const data = JSON.parse(text);
  const raw = data?.content?.[0]?.text || '';

  // Strip markdown fences if present
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const fb = s.indexOf('{');
  const lb = s.lastIndexOf('}');
  if (fb < 0 || lb <= fb) throw new Error('No JSON object in Haiku response: ' + s.slice(0, 200));

  return JSON.parse(s.slice(fb, lb + 1));
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendToTelegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data };
}

async function sendGroupPostForApproval(group, post) {
  // Message 1: preview (no buttons)
  const previewText = [
    'GROUP POST DRAFT',
    '',
    `Group: ${group.group_name}`,
    `Category: ${group.category}`,
    `Template: ${post.template_id}`,
    `Pillar: ${post.pillar}`,
    '',
    post.post_body,
  ].join('\n').slice(0, 4096);

  await sendToTelegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: previewText,
    disable_web_page_preview: true,
  });

  // Message 2: first comment + approval buttons
  const commentPreview = post.first_comment_body
    ? `FIRST COMMENT (post after 3+ replies):\n\n${post.first_comment_body}`
    : '(No first comment for this template)';

  const buttonText = [
    commentPreview,
    '',
    'Tap Approve to queue for posting.',
  ].join('\n').slice(0, 4096);

  const buttons = {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `group_approve_${post.id}` },
      { text: 'Reject', callback_data: `group_reject_${post.id}` },
      { text: 'Skip', callback_data: `group_skip_${post.id}` },
    ]],
  };

  const result = await sendToTelegram('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: buttonText,
    reply_markup: buttons,
    disable_web_page_preview: true,
  });

  return result.data?.result?.message_id || null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[generate-group-posts] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('[generate-group-posts] ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[generate-group-posts] TELEGRAM_MARKETING_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    process.exit(1);
  }

  console.log('[generate-group-posts] Starting' + (DRY_RUN ? ' (DRY RUN)' : '') + (groupIdFilter ? ` for group ${groupIdFilter}` : ''));

  // Fetch eligible groups
  let registryQuery = '/rest/v1/group_registry?skip=eq.false&requires_heath_review=eq.false&select=*';
  if (groupIdFilter) {
    registryQuery = `/rest/v1/group_registry?id=eq.${encodeURIComponent(groupIdFilter)}&select=*`;
  }

  const { ok, data: groups } = await supabaseFetch(registryQuery);
  if (!ok || !Array.isArray(groups)) {
    console.error('[generate-group-posts] Failed to fetch group_registry');
    process.exit(1);
  }

  // Log skipped Ginger group explicitly
  const { data: gingerGroups } = await supabaseFetch('/rest/v1/group_registry?requires_heath_review=eq.true&select=group_name');
  if (Array.isArray(gingerGroups)) {
    for (const g of gingerGroups) {
      console.log(`[generate-group-posts] Skipping ${g.group_name} - manual review required`);
    }
  }

  const now = new Date();
  let processed = 0;
  let skipped = 0;

  for (const group of groups) {
    // Check cool-down
    if (group.last_posted_at) {
      const lastPosted = new Date(group.last_posted_at);
      const hoursSince = (now - lastPosted) / (1000 * 60 * 60);
      if (hoursSince < group.cool_down_hours) {
        const hoursLeft = Math.ceil(group.cool_down_hours - hoursSince);
        console.log(`[generate-group-posts] Skipping "${group.group_name}" - cool-down: ${hoursLeft}h remaining`);
        skipped++;
        continue;
      }
    }

    // Find last-used template for this group to avoid repetition
    const { data: recentPosts } = await supabaseFetch(
      `/rest/v1/group_posts?group_registry_id=eq.${encodeURIComponent(group.id)}&order=created_at.desc&limit=1&select=template_id`,
    );
    const lastTemplateId = Array.isArray(recentPosts) && recentPosts.length > 0
      ? recentPosts[0].template_id
      : null;

    const template = pickTemplate(group.category, lastTemplateId);
    if (!template) {
      console.log(`[generate-group-posts] No templates for category "${group.category}" - skipping "${group.group_name}"`);
      skipped++;
      continue;
    }

    console.log(`[generate-group-posts] Generating for "${group.group_name}" (template ${template.id})`);

    let generated;
    try {
      generated = await generatePostWithHaiku(group, template);
    } catch (err) {
      console.error(`[generate-group-posts] Haiku failed for "${group.group_name}":`, err.message);
      continue;
    }

    const postBody = String(generated.post_body || '').trim();
    const firstComment = generated.first_comment_body
      ? String(generated.first_comment_body).trim()
      : null;

    if (!postBody) {
      console.error(`[generate-group-posts] Empty post_body for "${group.group_name}" - skipping`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n--- DRY RUN: ${group.group_name} (${template.id}) ---`);
      console.log(postBody);
      if (firstComment) {
        console.log('\n[First comment]');
        console.log(firstComment);
      }
      console.log('---\n');
      processed++;
      continue;
    }

    // Insert group_posts row
    const insertRow = {
      group_registry_id: group.id,
      group_name: group.group_name,
      group_url: group.group_url,
      category: group.category,
      template_id: template.id,
      post_body: postBody,
      first_comment_body: firstComment,
      status: 'draft',
      pillar: template.pillar,
    };

    const { ok: insOk, data: insData } = await supabaseFetch('/rest/v1/group_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(insertRow),
    });

    if (!insOk || !Array.isArray(insData) || !insData.length) {
      console.error(`[generate-group-posts] Insert failed for "${group.group_name}":`, JSON.stringify(insData).slice(0, 200));
      continue;
    }

    const post = insData[0];
    console.log(`[generate-group-posts] Inserted post ${post.id} for "${group.group_name}"`);

    // Send to DossieMarketingBot
    let messageId = null;
    try {
      messageId = await sendGroupPostForApproval(group, post);
      console.log(`[generate-group-posts] Sent to Telegram (message_id=${messageId})`);
    } catch (err) {
      console.error(`[generate-group-posts] Telegram send failed for "${group.group_name}":`, err.message);
    }

    // Record telegram_message_id and telegram_sent_at
    if (messageId) {
      await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          telegram_message_id: String(messageId),
          telegram_sent_at: new Date().toISOString(),
        }),
      });
    }

    processed++;

    // Small delay between groups to avoid Telegram rate limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`[generate-group-posts] Done. Processed: ${processed}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error('[generate-group-posts] Fatal error:', err.message);
  process.exit(1);
});
