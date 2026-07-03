'use strict';

// api/_lib/group-post-generator.js
//
// Shared logic for FB group post generation. Used by:
//   - scripts/generate-group-posts.js (manual CLI)
//   - api/cron-daily-fb-posts.js (daily cron)
//
// Reads group_registry for eligible groups (skip=false, cool-down expired),
// picks a fresh template per group via Haiku, inserts group_posts rows
// with status='draft', and sends DossieMarketingBot approval messages.
//
// Pipeline match: callback handler in api/group-post-callback.js flips the
// row to status='approved' on tap. Then fb-group-poster.js (Playwright,
// local) is run with --post-id to actually post.

// Template library — kept here so both CLI and cron see the same scaffolds.
// Haiku rewrites the scaffold in Heath's voice — we never post verbatim.
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
      first_comment: `Love seeing these answers - the spread is wild. I built Dossie for exactly this - it auto-calculates every TREC deadline from the contract date and sends me a morning brief on what's due. meetdossie.com/founding if you're in the B or C camp and want to try it.`,
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
      first_comment: `For what it's worth, I built Dossie to auto-map TREC form versions to transactions - July 1 updates are already in the system. Happy to share what I've found on the new disclosures if useful. meetdossie.com/founding`,
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
      first_comment: `For what it's worth - I built Dossie to handle the ops layer for solo agents. meetdossie.com/founding - Texas agents, founding pricing still open.`,
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
      first_comment: `I built Dossie to handle this for myself - she auto-calculates TREC deadlines, sends morning briefs, and chases document signatures. meetdossie.com/founding`,
    },
    {
      id: 'E-2',
      pillar: 'cost',
      scaffold: `Real talk: the agents who will thrive in the next 5 years are the ones who figure out how to do more with less overhead, not the ones who hire more people.

The market punishes agents with high fixed costs in slow years. The ones with lean operations and good systems survive every cycle.

Agree/disagree?`,
      first_comment: `For what it's worth - I built Dossie to handle my transaction ops. meetdossie.com/founding if you're curious what that looks like.`,
    },
  ],
  buyer_seller: [],
};

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function pickTemplate(category, lastTemplateId) {
  const pool = TEMPLATES[category] || [];
  if (!pool.length) return null;
  const candidates = pool.length > 1
    ? pool.filter((t) => t.id !== lastTemplateId)
    : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function makeSupabaseFetch(url, key) {
  return async function supabaseFetch(urlPath, init = {}) {
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${url}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data };
  };
}

async function generatePostWithHaiku(group, template, anthropicKey) {
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

FIRST COMMENT — DIFFERENT RULES FROM POST BODY:
---
${template.first_comment || '(no first comment for this template)'}
---

FIRST COMMENT RULES — NON-NEGOTIABLE:
A. The first comment MUST contain the literal word "Dossie" (capital D, exact spelling). This is the ONE place where the brand IS named.
B. The first comment MUST name ONE specific Dossie capability tied to the post's pain point. Pick from:
   - "Dossie auto-calculates every TREC deadline from the contract date"
   - "Dossie sends me a morning brief with every deal that needs attention today"
   - "Dossie tracks document uploads with timestamps"
   - "Dossie pings me on every pending document so nothing sits"
   - "Dossie handles the follow-up sequencing with title and lender"
   - "Dossie maps every transaction to a pipeline view I can see at a glance"
C. FORBIDDEN phrasings — do not use any of these:
   - "an AI tool I've been working with"
   - "a tool I've been using"
   - "something I built"
   - "the system I landed on"
   - "AI handling my [anything]"
   - any framing that describes Dossie without naming it
D. Tone: still casual and in Heath's voice. Naming Dossie is required; sounding corporate is not.
E. Include "meetdossie.com/founding" at the end of the first comment if (and only if) the scaffold's first_comment includes a URL.

Return STRICT JSON only. No markdown. No commentary.

{
  "post_body": "<the rewritten post, plain text, newlines allowed>",
  "first_comment_body": "<rewritten first comment that includes the literal word Dossie and ONE specific capability, or null if template has no first comment>"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
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
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const raw = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());

  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const fb = s.indexOf('{');
  const lb = s.lastIndexOf('}');
  if (fb < 0 || lb <= fb) throw new Error('No JSON object in Haiku response: ' + s.slice(0, 200));

  return JSON.parse(s.slice(fb, lb + 1));
}


/**
 * Run the group-post generation pipeline.
 *
 * @param {object} opts
 * @param {string} opts.supabaseUrl
 * @param {string} opts.supabaseKey
 * @param {string} opts.anthropicKey
 * @param {string} opts.telegramToken
 * @param {string} opts.telegramChatId
 * @param {boolean} [opts.dryRun=false]
 * @param {string|null} [opts.groupIdFilter=null]   only generate for one group
 * @param {number|null} [opts.maxPerRun=null]       cap how many groups we touch (per cron run)
 * @param {function} [opts.log=console.log]
 * @returns {{processed: number, skipped: number, generated: Array}}
 */
async function runGroupPostGeneration(opts) {
  const {
    supabaseUrl, supabaseKey, anthropicKey, telegramToken, telegramChatId,
    dryRun = false,
    groupIdFilter = null,
    maxPerRun = null,
    log = console.log,
  } = opts;

  const supabaseFetch = makeSupabaseFetch(supabaseUrl, supabaseKey);

  log('[group-post-generator] Starting' + (dryRun ? ' (DRY RUN)' : '') + (groupIdFilter ? ` for group ${groupIdFilter}` : '') + (maxPerRun ? ` (cap=${maxPerRun})` : ''));

  let registryQuery = '/rest/v1/group_registry?skip=eq.false&requires_heath_review=eq.false&select=*&order=last_posted_at.asc.nullsfirst';
  if (groupIdFilter) {
    registryQuery = `/rest/v1/group_registry?id=eq.${encodeURIComponent(groupIdFilter)}&select=*`;
  }

  const { ok, data: groups } = await supabaseFetch(registryQuery);
  if (!ok || !Array.isArray(groups)) {
    throw new Error('Failed to fetch group_registry');
  }

  const now = new Date();
  let processed = 0;
  let skipped = 0;
  const generated = [];

  for (const group of groups) {
    if (maxPerRun != null && processed >= maxPerRun) {
      log(`[group-post-generator] Reached per-run cap (${maxPerRun}). Stopping.`);
      break;
    }

    if (group.last_posted_at) {
      const lastPosted = new Date(group.last_posted_at);
      const hoursSince = (now - lastPosted) / (1000 * 60 * 60);
      if (hoursSince < group.cool_down_hours) {
        const hoursLeft = Math.ceil(group.cool_down_hours - hoursSince);
        log(`[group-post-generator] Skipping "${group.group_name}" - cool-down: ${hoursLeft}h remaining`);
        skipped++;
        continue;
      }
    }

    const { data: recentPosts } = await supabaseFetch(
      `/rest/v1/group_posts?group_registry_id=eq.${encodeURIComponent(group.id)}&order=created_at.desc&limit=1&select=template_id`,
    );
    const lastTemplateId = Array.isArray(recentPosts) && recentPosts.length > 0
      ? recentPosts[0].template_id
      : null;

    const template = pickTemplate(group.category, lastTemplateId);
    if (!template) {
      log(`[group-post-generator] No templates for category "${group.category}" - skipping "${group.group_name}"`);
      skipped++;
      continue;
    }

    log(`[group-post-generator] Generating for "${group.group_name}" (template ${template.id})`);

    let result;
    try {
      result = await generatePostWithHaiku(group, template, anthropicKey);
    } catch (err) {
      log(`[group-post-generator] Haiku failed for "${group.group_name}": ${err.message}`);
      continue;
    }

    const postBody = String(result.post_body || '').trim();
    const firstComment = result.first_comment_body
      ? String(result.first_comment_body).trim()
      : null;

    if (!postBody) {
      log(`[group-post-generator] Empty post_body for "${group.group_name}" - skipping`);
      continue;
    }

    // Sage rule: first_comment_body must include the literal word "Dossie".
    // Validator at api/group-post-callback.js will block approval if it doesn't.
    // Retry once with explicit feedback before giving up.
    if (firstComment && !firstComment.includes('Dossie')) {
      log(`[group-post-generator] First comment for "${group.group_name}" missing "Dossie" - retrying with feedback`);

      const retryPrompt = `Your previous first_comment_body did not contain the word "Dossie".

The first comment is the ONE place where Dossie MUST be named explicitly. Rewrite the first comment to:
1. Include the literal word "Dossie" (capital D).
2. Name ONE specific Dossie capability tied to the post topic.
3. Match Heath's casual voice.
4. Do NOT use phrases like "an AI tool", "a tool I've been working with", "something I built". Those are forbidden.

Original post_body (do not change):
---
${postBody}
---

Original first_comment that failed:
---
${firstComment}
---

Return STRICT JSON only:
{
  "first_comment_body": "<rewritten first comment that includes the literal word Dossie>"
}`;

      try {
        const retryRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 500,
            messages: [{ role: 'user', content: retryPrompt }],
          }),
        });
        const retryText = await retryRes.text();
        if (retryRes.ok) {
          const retryData = JSON.parse(retryText);
          // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
          let r = ((retryData?.content || [])
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
            .trim());
          if (r.startsWith('```')) r = r.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
          const fb = r.indexOf('{');
          const lb = r.lastIndexOf('}');
          if (fb >= 0 && lb > fb) {
            const retryParsed = JSON.parse(r.slice(fb, lb + 1));
            const retryComment = retryParsed.first_comment_body
              ? String(retryParsed.first_comment_body).trim()
              : null;
            if (retryComment && retryComment.includes('Dossie')) {
              log(`[group-post-generator] Retry succeeded for "${group.group_name}"`);
              // Reassign for downstream insert
              // eslint-disable-next-line no-param-reassign
              result.first_comment_body = retryComment;
            } else {
              log(`[group-post-generator] Retry still missing "Dossie" for "${group.group_name}" - skipping insert`);
              skipped++;
              continue;
            }
          }
        }
      } catch (err) {
        log(`[group-post-generator] Retry error for "${group.group_name}": ${err.message} - skipping insert`);
        skipped++;
        continue;
      }
    }

    // Re-derive firstComment from possibly-updated result before insertRow
    const finalFirstComment = result.first_comment_body
      ? String(result.first_comment_body).trim()
      : null;

    if (dryRun) {
      generated.push({ group_name: group.group_name, template_id: template.id, post_body: postBody, first_comment_body: firstComment });
      processed++;
      continue;
    }

    const insertRow = {
      group_registry_id: group.id,
      group_name: group.group_name,
      group_url: group.group_url,
      category: group.category,
      template_id: template.id,
      post_body: postBody,
      first_comment_body: finalFirstComment,
      status: 'pending_sage_review',
      pillar: template.pillar,
    };

    const { ok: insOk, data: insData } = await supabaseFetch('/rest/v1/group_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(insertRow),
    });

    if (!insOk || !Array.isArray(insData) || !insData.length) {
      log(`[group-post-generator] Insert failed for "${group.group_name}": ${JSON.stringify(insData).slice(0, 200)}`);
      continue;
    }

    const post = insData[0];
    log(`[group-post-generator] Inserted post ${post.id} for "${group.group_name}"`);

    // Insert into sage_inbox for Sage's autonomous review
    const { ok: sageOk } = await supabaseFetch('/rest/v1/sage_inbox', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        post_id: post.id,
        status: 'pending_sage_review',
      }),
    });

    if (!sageOk) {
      log(`[group-post-generator] Failed to insert sage_inbox for "${group.group_name}" post ${post.id}`);
    } else {
      log(`[group-post-generator] Queued to Sage review: ${post.id}`);
    }

    generated.push({
      id: post.id,
      group_name: group.group_name,
      template_id: template.id,
      pillar: template.pillar,
    });
    processed++;

    await new Promise((r) => setTimeout(r, 1000));
  }

  log(`[group-post-generator] Done. Processed: ${processed}, Skipped: ${skipped}`);
  return { processed, skipped, generated };
}

module.exports = { runGroupPostGeneration, TEMPLATES };
