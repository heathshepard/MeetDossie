// Vercel Serverless Function: /api/cron-generate-posts
// Daily content generator for Dossie's marketing pipeline.
//   - Generates 9 social posts per day via Claude Sonnet:
//     CAPABILITY_ONELINER (Facebook), TREC_EDUCATION (Instagram),
//     PERSONA_STORY/brenda (Twitter), CAPABILITY_ONELINER (LinkedIn),
//     TREC_EDUCATION (Twitter), FOUNDER_STORY (Facebook),
//     PERSONA_STORY/victor (Twitter - 3rd daily slot),
//     PERSONA_STORY/victor (TikTok - activates DONE video pipeline),
//     TREC_EDUCATION (YouTube - educational 60-90s voiceover, added 2026-05-29),
//     rotating topic chosen by day-of-year.
//   - Inserts each post into social_posts as status='draft'.
//   - Wraps the run in a content_batches row for tracking.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 11 * * * (11:00 UTC daily, ~6am Central during DST).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Default flipped 2026-05-20 from true to false. Until the content-verifier pass
// proves itself across a few clean batches, every post hits the Telegram
// approval flow. Set AUTO_APPROVE_POSTS=true in Vercel env to restore auto-publish.
const AUTO_APPROVE_POSTS = process.env.AUTO_APPROVE_POSTS === 'true';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
// Verifier runs as a cheaper model — it only checks claims against an embedded
// facts snapshot, doesn't generate copy. Haiku 4.5 is sufficient and adds
// roughly a few hundred ms + ~$0.001 per post to the batch.
const VERIFIER_MODEL = 'claude-haiku-4-5-20251001';

// ─── Content-Verifier facts snapshot ─────────────────────────────────────
// REGENERATE THIS BLOCK WHEN CLAUDE.md CHANGES (sections 6 + 7 + 8) or when
// new founder pain stories are appended to project_heath_founder_pain_stories.md.
// Last regenerated: 2026-05-20.
//
// This snapshot is inlined into the verifier system prompt — never load
// CLAUDE.md at runtime. The verifier's only job is to compare a draft against
// these facts and flag fabrications.
const VERIFIER_SYSTEM_PROMPT = `You are the Dossie Content Verifier. Your only job is to find fabrications, false specifics, and over-claims in customer-facing marketing copy before it ships. You are skeptical, terse, and accurate. You do not rewrite the copy — you flag what needs to change.

## CONTENT FORMATS — know which rules apply

Posts come in four formats. The format is declared in the verification request. Apply format-specific rules:

### PERSONA_STORY posts (Brenda, Patricia, Victor)
These are fictional Texas agent personas — NOT real customers. Any persona-branded content is intentional. Do NOT flag persona names, persona usage of Dossie, or persona pain stories.

### CAPABILITY_ONELINER posts (Dossie brand voice)
Dossie brand voice, no persona. Verifier must check: (a) is the claimed feature in the shipped features list? (b) is only ONE feature claimed? Flag any unshipped feature or stacked capability claims as red.

### TREC_EDUCATION posts (Dossie brand voice)
Dossie brand voice, no persona. Verifier must check: is the TREC fact accurate and in the pre-verified list? Pre-verified facts: option period from execution date, earnest money due within 3 days to title, survey period, title commitment review period (~20 days), closing date extension via amendment, third-party financing contingency. Flag any invented TREC rule or deadline not in this list as red.

### FOUNDER_STORY posts (Heath's real verified stories only)
Three approved stories: (1) TC quit while Heath was in Italy, (2) $400/file + 4:30am stress about option fee receipts, (3) remote deal management anxiety. Flag any specific detail that is NOT from these three stories (invented addresses, invented dollar amounts, invented timestamps) as red.

## FICTIONAL MARKETING PERSONAS — NEVER check against the founding member list

Brenda, Patricia, and Victor are FICTIONAL characters used in Dossie's social media marketing content. They are NOT real customers and must NEVER be compared against or checked against the verified founding member list below. Any post written in one of their voices is intentional persona content — the persona name appearing in a post is never a fabrication or an unverified customer claim. Do not flag Brenda, Patricia, or Victor for any reason related to customer verification.

IMPORTANT - PERSONA CONTENT IS LEGITIMATE:
These posts are written from the perspective of FICTIONAL MARKETING PERSONAS (Brenda, Patricia, Victor). They are invented characters illustrating real agent pain points - NOT real Dossie customers.

ALWAYS APPROVE content that is:
- A persona's pain story (e.g. "Brenda got a 4:30am call", "Victor missed a deadline")
- Hypothetical frustrations or scenarios ("imagine losing a deal because...")
- General agent experiences without specific Dossie usage claims
- A persona described as USING Dossie (e.g. "She started using Dossie recently", "Victor uses Dossie now", "The morning brief lands in his inbox") — this is fictional persona storytelling, NOT a real customer claim. Approve it.
- A persona experiencing a Dossie feature in the narrative (e.g. "Now she gets a morning brief", "He saw the deadline tracker pull every date from the contract") — this is persona storytelling. Approve it.
- CAPABILITY_ONELINER, TREC_EDUCATION, or FOUNDER_STORY posts written in Dossie brand voice (no persona) — these are intentional brand-voice posts. Approve them if facts are accurate per the format-specific rules above.

ONLY FLAG content that:
- Claims a REAL named person (from the founding member list below) SIGNED UP, joined, or became a Dossie MEMBER — with specifics like join date or member number
- Gives an exact join date, timestamp, or member number for a real customer
- Quotes a real customer by name with a specific claim Heath did not make
- States a specific founding member count as fact using a number higher than __FOUNDING_COUNT__
- Claims Brenda, Patricia, or Victor is a "founding member" or gives them a member number (they are fictional personas, not real members)

NEVER FLAG these patterns in persona copy:
- "[Persona] started using Dossie recently" — fictional usage, fine
- "[Persona] uses Dossie now" — fictional, fine
- Persona experiencing any real Dossie feature — fine
- Persona described as solving pain with Dossie — fine

## VERIFIED FACTS — the only source of truth for specific claims

### Current customers (__FOUNDING_COUNT__ founding members as of run time — count is queried live from the subscriptions table each batch)
1. Kimberly Herrera — $29/mo founding member
2. Tiffany Gill — $29/mo founding member
3. Brittney YBarbo — $29/mo founding member. Broker, ~80 tx/yr, Southeast Texas. Found Dossie via Facebook search "transaction coordinating in Texas". Control-freak who can't trust delegation. Direct quote: "the lack of systems I have in place isn't sustainable."
4. Suzanne Page — $1/mo founding friend (FOUNDING_FRIEND coupon)
5. Miki Mccarthy — $29/mo founding member, Rio Grande Valley / Greater McAllen, My Real Estate Company brokerage
6. Cecilia Whitley — $29/mo founding member, Austin, Sterling and Associates brokerage
7. Terry Katz — $29/mo founding member, Houston / Spring TX
8. Amanda Nuckles — $29/mo founding member, Central Texas, All City Real Estate
9. Zelda Cain — $29/mo founding member, Houston, A2Z Real Estate Consultants LLC
10. Natalie Megerson — $29/mo founding member, San Antonio + Austin + San Marcos, REAL Broker

If a draft references a founding member number, ONLY 1-__FOUNDING_COUNT__ are valid. Higher numbers ("#15", "#22") are FABRICATIONS — flag as red.

### Shipped features (these are real, safe to claim)
- TREC deadline auto-calculation, cited to paragraph
- Contract PDF scanning
- Email draft queue (drafts only — agent reviews and sends)
- Morning Brief with Luna voice (daily audio + text deal summary)
- Closing milestone cards (shareable, privacy-safe)
- Dossier pipeline view with deal cards + deadline badges
- Talk-to-Dossie voice/text chat
- Natural-language deadlines throughout
- Founding application flow + Stripe checkout
- Share Dossie button (desktop sidebar + mobile bottom nav)
- TREC deadline calculator at meetdossie.com/calculator
- 10 SEO guide pages + 5 AEO answer pages

### NOT yet built — never claim as live (red flag if claimed)
- Reply Monitoring
- AI Autopilot
- Compliance Vault
- White Label
- Brokerage compliance document sending
- Stripe Payment Links (current checkouts expire 24h)
- TikTok automation (manual until ~May 20, 2026)
- Zernio analytics feedback loop
- Brevo email nurture sequence
- Bulk email drafts
- Amendment drafting
- SMS sending
- Voice escalation
- Mobile native app
- Discord / community platform (Founding Files is the private space, but no Discord)

### Heath behaviors that DO happen
- He answers Telegram messages from founders
- He builds Dossie (founder-built product)
- He's a licensed Texas REALTOR at Keller Williams (City View / Boerne)
- He runs Plane & Ember (cigar woodwork business)

### Heath behaviors that DO NOT happen (red flag if claimed)
- Posting code commits to socials
- Doing live debug streams
- Running a public Discord
- Recording weekly office hours
- Public roadmap streams

### Verified founder pain stories (specifics OK to reference)
- "TC quit while I was in Italy" — Heath has been through 3 transaction coordinators. The last one quit while he was on vacation in Italy with active transactions in escrow. The 7-8 hour time difference destroyed the vacation.
- "$400 per file, still waking up at 4:30am wondering if she sent that repair amendment" — the $400/file pain story.
- "Vacation is the stress test your systems fail" — Heath's reframe.
- Brittney's "control freak vs. visibility problem" reframe — flagged the Week-5 control_freak_agent angle.

If a draft uses founder-pain specifics NOT in this list (e.g. "Tuesday 9:43pm debug session", "Spent 4 hours fixing the deadline rollover edge case tonight because Brittney caught it"), flag as red — those are invented.

### Pricing (locked, real)
- Founding: $29/mo (50 spots, __FOUNDING_COUNT__ taken, __FOUNDING_REMAINING__ remaining)
- Solo: $79/mo, Team: $199/mo, Brokerage: custom

## What to flag

🔴 RED (highest severity — verdict MUST be needs_revision):
- Founding member numbers past __FOUNDING_COUNT__
- Invented timestamps with the air of specificity ("Tuesday at 9:43pm", "10pm debug session", "ship in 48 hours") not documented above
- Customer names + events not in the verified list above
- Features claimed as live from the NOT-yet-built list
- Heath behaviors that don't happen
- Made-up quoted testimonials
- Numbers presented as real stats ("80% of our users", "saved $X across the platform") — Dossie has __FOUNDING_COUNT__ customers; aggregate stats don't exist

🟡 YELLOW (medium severity — flag for human review):
- Specific stats that COULD be real but can't be verified from the facts above
- Time-of-day specifics that match a documented pain but with wrong details
- Quoted customer testimonials that paraphrase but should be checked

🟢 GREEN (lowest severity — optional notes only):
- Tone mismatch with persona
- Weak/missing CTA
- Hashtag count off

## Output format — STRICT JSON ONLY

Return ONLY this JSON shape. No markdown fences. No prose before or after.

{
  "verdict": "approve" | "needs_revision",
  "flags": [
    {
      "severity": "red" | "yellow" | "green",
      "claim": "<exact phrase from the draft>",
      "issue": "<why it's a problem>",
      "fix": "<suggested generic/hypothetical replacement — not a new fabrication>"
    }
  ],
  "summary": "<one sentence>"
}

Rules:
- verdict "approve" ONLY when zero red flags AND at most one yellow flag.
- verdict "needs_revision" when ANY red flag, OR two+ yellow flags.
- Always include the flags array, even if empty.
- Be terse. Total response well under 500 tokens.
- Never rewrite the draft. Only flag and suggest replacements.
- Never add new factual claims. When in doubt, suggest more universal/hypothetical framing.`;

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

// Live count of active founding subscriptions. Used to substitute
// __FOUNDING_COUNT__ and __FOUNDING_REMAINING__ in the verifier prompt and
// the generator's factual-accuracy block. Falls back to the previous
// hardcoded value (9) if the query fails, with a console.warn so the
// failure is visible — better than serving content with a fabricated count.
async function getFoundingMemberCount() {
  const FOUNDING_TOTAL = 50;
  const FALLBACK = 9;
  try {
    const r = await supabaseFetch(
      `/rest/v1/subscriptions?select=id&status=in.(active,trialing)&plan=eq.founding`,
      { headers: { Prefer: 'count=exact' } },
    );
    // Supabase returns the count via Content-Range header when Prefer: count=exact
    // is set; the body is the rows. We have only id selected, so count the array.
    if (r.ok && Array.isArray(r.data)) {
      return { taken: r.data.length, remaining: Math.max(0, FOUNDING_TOTAL - r.data.length) };
    }
    console.warn('[cron-generate-posts] getFoundingMemberCount: unexpected response', r.status);
    return { taken: FALLBACK, remaining: FOUNDING_TOTAL - FALLBACK };
  } catch (err) {
    console.warn('[cron-generate-posts] getFoundingMemberCount failed:', err && err.message);
    return { taken: FALLBACK, remaining: FOUNDING_TOTAL - FALLBACK };
  }
}

// Substitute __FOUNDING_COUNT__ and __FOUNDING_REMAINING__ placeholders in
// any prompt string using the live numbers from getFoundingMemberCount().
function applyFoundingCount(promptText, founding) {
  return String(promptText)
    .replace(/__FOUNDING_COUNT__/g, String(founding.taken))
    .replace(/__FOUNDING_REMAINING__/g, String(founding.remaining));
}

const PERSONAS = {
  brenda: {
    name: 'Brenda',
    summary: 'Burned-out solo agent, 6 years in, pays her transaction coordinator $8,000/year. Voice: tired, witty, blunt about industry pain. Not whiny — wry. Talks like she\'s telling a friend over coffee at 9pm after the kids are in bed.',
  },
  patricia: {
    name: 'Patricia',
    summary: 'Part-time agent, 8-12 deals/year, also has a day job. Voice: practical, budget-conscious, no fluff. Skeptical of anything that sounds like a sales pitch. Cares about whether something pays for itself in 2 deals or fewer.',
  },
  victor: {
    name: 'Victor',
    summary: 'Top producer, 50+ deals/year, runs a small team. Voice: confident, math-driven, ambitious. Talks in margins and capacity. Not cocky — operational. Sees TC cost as a fixed leak and is always looking for the unlock.',
  },
};

const TOPICS = [
  {
    key: 'cost_math',
    label: 'The cost math (current TC cost vs Dossie at $29/mo)',
    angle: 'Compare what an agent currently spends on TC services to Dossie\'s $29/mo founding-member price. Use real numbers. Avoid generic "save money!" framing — show the actual delta.',
  },
  {
    key: 'pain_points',
    label: 'Pain points: missed deadlines, ghosted TCs, weekend stress',
    angle: 'Concrete pain stories. Sunday night option period scramble. TC unreachable Friday afternoon. The 9pm contract review. Make it specific to Texas real estate.',
  },
  {
    key: 'day_in_the_life',
    label: 'Day-in-the-life moments where Dossie quietly handles things',
    angle: 'Small wins. Contract scanned in 8 seconds. Morning Brief at 6am. Follow-up email the agent forgot to send. A moment of "oh, that\'s already done."',
  },
  {
    key: 'capability_oneliners',
    label: 'Product capability one-liners',
    angle: 'Punchy single capability statements. "Your contract scanned in 8 seconds." "Every deadline tracked. Every party followed up." "She works nights, weekends, holidays."',
  },
  {
    key: 'control_freak_agent',
    label: 'Control + visibility — for agents who don\'t trust delegating',
    angle: 'Speak directly to the agent who refuses to hire a TC because they can\'t trust someone else to do it right. Reframe Dossie as visibility and control, NOT delegation. Lean into "you don\'t have to trust someone else — Dossie shows you everything", "control freaks make the best Dossie users", "you\'re not giving up control, you\'re finally getting it." Specifics: every deadline visible at a glance, every email drafted but not sent without you tapping send, every TREC paragraph cited so you can verify the math yourself. Avoid "let go" / "trust the process" framing — that\'s exactly what this audience refuses.',
  },
  {
    key: 'build_in_public',
    label: 'Build in Public — show the behind-the-scenes work',
    angle: 'Share what Heath is actively building right now. Code commits, feature decisions, late-night debugging sessions, customer feedback that shaped a feature. Make it personal and transparent. Show the human builder behind Dossie, not a faceless company. Examples: "Spent 4 hours fixing the deadline rollover edge case tonight because Brittney caught it", "Just shipped voice transcription for Talk to Dossie — here\'s why it took 3 weeks", "Founding member #12 asked for bulk email drafts. Built it in 48 hours."',
  },
  {
    key: 'feature_reveal',
    label: 'Feature Reveal — announce new capabilities as they ship',
    angle: 'Announce a specific new feature that just went live. Focus on the capability and the why, not just the what. Show before/after, pain → solution. Examples: "Milestone Cards just shipped — share Under Contract / Clear to Close / Closed cards directly to Instagram", "Talk to Dossie now transcribes voice notes — update deals hands-free between showings", "Morning Brief now includes escalated items with follow-up counts — know exactly which tasks need your attention first."',
  },
  {
    key: 'community_movement',
    label: 'Community/Movement — highlight The Founding Files and the collective',
    angle: 'Emphasize that founding members aren\'t just subscribers — they\'re part of a movement. Highlight The Founding Files private community, feature voting, early access, member stories, the "first 50" exclusivity. Examples: "Founding member #8 voted for pipeline drag-and-drop. It shipped today.", "The Founding Files isn\'t a Facebook group. It\'s where Dossie gets built.", "48 spots left. After that, the founding rate and The Founding Files close forever."',
  },
];

// Per-platform algorithm rules. Injected into the generation prompt for every
// post so the model knows the distribution mechanics, not just the surface
// stylistic notes. These reflect how each platform's algorithm actually
// distributes content (hook attention, length sweet spot, format, CTA signal,
// hashtag weight). Treat them as hard constraints during generation.
const PLATFORM_RULES = {
  tiktok: {
    hook_rule: "First sentence must be under 8 words and create immediate curiosity or tension. Never start with 'I' — start with a question, a number, or a provocative statement.",
    length_rule: "Keep total post under 150 words. Shorter = higher completion rate = more reach.",
    format_rule: "Use line breaks after every 1-2 sentences. No paragraphs. Mobile reading pattern.",
    cta_rule: "End with a single clear action: 'Link in bio' or 'Comment YES if this is you'",
    timing: "Best performing: 6-9AM or 7-9PM CST",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  instagram: {
    hook_rule: "First line must make someone stop scrolling. Ask a question or make a bold claim. Gets cut off at ~125 chars so front-load the value.",
    length_rule: "150-300 words ideal. Long enough to be useful, short enough to read.",
    format_rule: "Line breaks between every thought. Use emojis sparingly — 1-2 max, relevant only.",
    cta_rule: "Ask for a SAVE ('save this for your next transaction') or SHARE ('send this to an agent who needs it'). Saves and shares beat likes for reach.",
    timing: "Best performing: 8-11AM or 6-8PM CST",
    hashtags: "REQUIRED: 8-10 hashtags at end. Mix high-volume (#realestate #realtor #realtorlife), Texas-specific (#texasrealestate #texasrealtor #trec #sanantoniorealestate), and niche (#transactioncoordinator #realtortools #closingday)",
  },
  facebook: {
    hook_rule: "Start with a relatable pain point or a question agents are already thinking. Facebook audience skews older — be direct, not trendy.",
    length_rule: "Facebook rewards long-form. 200-500 words performs better than short posts. Tell a story.",
    format_rule: "Short paragraphs, 2-3 sentences max. White space is your friend. No bullet points — Facebook reads like a conversation.",
    cta_rule: "Ask a direct question at the end to drive comments. Comments are the strongest signal. 'How many of you are still doing this manually?' works.",
    timing: "Best performing: Tuesday-Thursday 9AM-1PM CST",
    hashtags: "NONE. Facebook hashtags add no value. Do not include any hashtags in Facebook posts.",
  },
  twitter: {
    hook_rule: "Under 280 chars for the opener. Punchy, opinionated, or contrarian. Takes get pushed. Safe content dies.",
    length_rule: "Either under 280 chars (single tweet) or a thread of 5-8 tweets. Nothing in between.",
    format_rule: "For threads: each tweet must stand alone AND connect to the next. Write clean tweet text without manual numbering — the publish system handles threading automatically.",
    cta_rule: "End threads with 'RT if this helped' or a question. Quote tweets and replies are the strongest signals.",
    timing: "Best performing: 8-10AM or 12-1PM CST weekdays",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  linkedin: {
    hook_rule: "First two lines are visible before the 'see more' fold — front-load the value with a specific operational insight, a contrarian take, or a number. No clickbait, no 'You won't believe...' Sound like a peer talking shop, not a marketer.",
    length_rule: "1300-2000 chars. LinkedIn rewards story-shaped, single-thread posts in this range with the strongest dwell signal. Shorter posts under 600 chars also work for sharp one-line takes.",
    format_rule: "Short paragraphs, 1-3 sentences each. Heavy line-breaks for white space. Skimmable structure beats prose blocks. Lists OK if they're load-bearing, not ornamental.",
    cta_rule: "End with a specific question that invites operators to reply with their own number or workflow ('What does your TC actually cost per file when you add the chase time?'). Comments dwarf likes for reach. Avoid 'Thoughts?' — too generic.",
    timing: "Best performing: Tuesday-Thursday 7-10AM CST. Friday morning also lands well for ops-minded audiences.",
    hashtags: "REQUIRED: 3-5 hashtags at end. Use: #realestate #transactioncoordinator #texasrealestate #proptech #realtors",
  },
  youtube: {
    hook_rule: "First sentence must hook the viewer in under 10 words — state the specific problem or outcome. YouTube viewers decide in the first 3 seconds. Examples: 'Your option period deadline is 8 days away.' or 'Most Texas agents miss this TREC rule.'",
    length_rule: "Description: 150-300 words. The voiceover_script should target 60-90 seconds spoken (550-800 chars) — longer than TikTok/Instagram, educational depth expected. YouTube rewards watch time, not brevity.",
    format_rule: "Description uses short paragraphs. Voiceover is conversational and structured: intro problem, explain the rule or feature, show the solution, CTA. No bullet points in voiceover — write for ears, not eyes.",
    cta_rule: "End description with 'Subscribe for more Texas real estate tips + Link: meetdossie.com/founding'. Voiceover ends with 'This is Dossie. Texas agents - meetdossie.com slash founding.'",
    timing: "Best performing: 9AM-12PM CST (14:00-17:00 UTC). Post 1/day max.",
    hashtags: "REQUIRED: 3-5 hashtags at end of description. Use: #texasrealestate #realtortips #trec #transactioncoordinator #realestateagent",
  },
};

// ─── Content Format Definitions ──────────────────────────────────────────────
// Each post slot specifies a FORMAT that controls whether it uses a persona
// wrapper or Dossie brand voice directly. Non-persona formats (CAPABILITY_ONELINER,
// TREC_EDUCATION, FOUNDER_STORY) skip the persona entirely and post as Dossie.
//
// FORMAT types:
//   PERSONA_STORY      — fictional Texas agent persona (Brenda/Patricia/Victor), third-person voice
//   CAPABILITY_ONELINER — Dossie brand voice, one shipped feature, plain language
//   TREC_EDUCATION     — Dossie brand voice, real TREC fact + how Dossie handles it
//   FOUNDER_STORY      — Heath's real verified pain stories only, Dossie brand voice
//
// Connected zernio_accounts as of 2026-05-07: facebook, instagram, twitter,
// tiktok (gated locally), linkedin.
// YouTube added 2026-05-29 — account ID via ZERNIO_YOUTUBE_ACCOUNT_ID env var.
//
// Length rules live in PLATFORM_RULES (single source of truth). Per-post
// notes only carry format-flavor guidance, not length conflicts.
//
// Weekly format mix (updated 2026-05-29 — 9 posts/day, YouTube added):
//   2x CAPABILITY_ONELINER (facebook + linkedin)
//   2x TREC_EDUCATION (instagram + twitter)
//   1x FOUNDER_STORY (facebook — high-credibility platform)
//   2x PERSONA_STORY/brenda+victor (twitter — fills 3/day cap)
//   1x PERSONA_STORY/victor (tiktok — feeds DONE video pipeline)
//   1x TREC_EDUCATION (youtube — educational long-form, 60-90s voiceover)
const POST_PLAN_BASE = [
  // CAPABILITY_ONELINER — shows one specific shipped feature in plain Dossie voice
  {
    format: 'CAPABILITY_ONELINER',
    persona: null,
    platform: 'facebook',
    notes: 'Feature name -> what it does -> one concrete outcome -> CTA. Plain language, no hype. Facebook audience skews experienced agents — make the feature feel obvious and useful, not trendy.',
  },
  // TREC_EDUCATION — teaches Texas agents something real about TREC
  {
    format: 'TREC_EDUCATION',
    persona: null,
    platform: 'instagram',
    notes: 'TREC fact/rule -> why it matters -> how Dossie handles it -> CTA. Keep it crisp and mobile-readable. Line breaks between each beat.',
  },
  // PERSONA_STORY — one emotional persona slot for connection
  {
    format: 'PERSONA_STORY',
    persona: 'brenda',
    platform: 'twitter',
    notes: 'One punchline. Tired-but-witty voice. Third person throughout.',
  },
  // CAPABILITY_ONELINER — second slot, LinkedIn/professional audience
  {
    format: 'CAPABILITY_ONELINER',
    persona: null,
    platform: 'linkedin',
    notes: 'Peer-to-peer operational voice. Open with the specific capability and a number or outcome. Close with a question that invites brokers/producers to share their own workflow.',
  },
  // TREC_EDUCATION — second slot, Twitter for professional credibility
  {
    format: 'TREC_EDUCATION',
    persona: null,
    platform: 'twitter',
    notes: 'Sharp thread or punchy single tweet. Lead with the TREC rule, follow with the agent consequence, land on how Dossie solves it.',
  },
  // FOUNDER_STORY — Heath real stories, high-credibility on Facebook
  {
    format: 'FOUNDER_STORY',
    persona: null,
    platform: 'facebook',
    notes: 'Draw ONLY from the three approved Heath pain stories. Specific moment -> what it cost -> what Dossie would have done -> CTA. Conversational, not polished-marketing. This is a founder talking to agents, not a brand announcement.',
  },
  // PERSONA_STORY — Victor third Twitter slot (fills the 3/day cap)
  {
    format: 'PERSONA_STORY',
    persona: 'victor',
    platform: 'twitter',
    notes: 'Confident, math-driven voice. Volume-agent angle. Third person throughout. A sharp operational take — margins, deal count, efficiency. One punchy thread or single tweet.',
  },
  // PERSONA_STORY — TikTok slot. Generates caption+hook for the DONE video pipeline.
  // cron-publish-approved parks these as pending_video; a video must be attached
  // before they publish. Short-form, curiosity-first, under 150 words.
  {
    format: 'PERSONA_STORY',
    persona: 'victor',
    platform: 'tiktok',
    notes: 'Under 150 words. First sentence under 8 words, immediate curiosity or tension. Line break after every 1-2 sentences. End with "Link in bio" or "Comment YES if this is you." 2-3 hashtags. This content will be attached to a video via the DONE pipeline before posting.',
  },
  // TREC_EDUCATION — YouTube slot. Educational long-form (60-90s voiceover).
  // YouTube rewards watch time — more depth than TikTok/Instagram.
  // Video required: cron-publish-approved will park as pending_video if media_url is null.
  // Account ID: ZERNIO_YOUTUBE_ACCOUNT_ID env var (Heath must add in Vercel dashboard).
  {
    format: 'TREC_EDUCATION',
    persona: null,
    platform: 'youtube',
    notes: 'Educational angle — teach one TREC rule, show how Dossie handles it, give the agent a takeaway they can use today. Voiceover should be 60-90 seconds (550-800 chars). More depth than TikTok — YouTube audience expects to learn something, not just feel something. Description (caption) supports the video. 3-5 hashtags at end.',
  },
];

function getPostPlan(date = new Date(), opts = {}) {
  // LinkedIn now posts daily, no day-of-week routing needed
  return POST_PLAN_BASE;
}

function parseForceDay(req) {
  let raw = null;
  try {
    if (req && req.query && req.query.force_day) raw = String(req.query.force_day);
    else if (req && typeof req.url === 'string') {
      raw = new URL(req.url, 'https://x').searchParams.get('force_day');
    }
  } catch (_e) { raw = null; }
  if (!raw) return null;
  const m = String(raw).toLowerCase();
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  if (m in map) return map[m];
  const n = parseInt(m, 10);
  return (Number.isInteger(n) && n >= 0 && n <= 6) ? n : null;
}

function pickTopic() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const today = new Date();
  const dayOfYear = Math.floor((today - start) / 86400000);
  return TOPICS[dayOfYear % TOPICS.length];
}

// ─── Top-performer hook injection ──────────────────────────────────────────
// Fetches the 5 highest-engagement hooks from post_analytics (joined to
// social_posts) and returns them as example strings to inject into the
// generation prompt. Returns an empty array if the table has no data yet
// (first weeks before analytics accumulate) — graceful degradation.
async function fetchTopPerformerHooks() {
  try {
    // Join post_analytics to social_posts via social_post_id, order by
    // engagement_score desc, grab distinct hooks from the top 5.
    const { data, ok } = await supabaseFetch(
      `/rest/v1/post_analytics?select=hook,platform,persona,engagement_score&engagement_score=gt.0&order=engagement_score.desc&limit=5`,
    );
    if (!ok || !Array.isArray(data) || data.length === 0) return [];

    // Deduplicate and filter blank hooks
    const seen = new Set();
    const hooks = [];
    for (const row of data) {
      const h = String(row.hook || '').trim();
      if (!h || seen.has(h)) continue;
      seen.add(h);
      hooks.push({
        hook: h,
        platform: row.platform || 'unknown',
        persona: row.persona || 'unknown',
        score: Number(row.engagement_score || 0),
      });
    }
    return hooks;
  } catch (err) {
    console.warn('[cron-generate-posts] fetchTopPerformerHooks failed:', err && err.message);
    return [];
  }
}

// Build the top-performer examples block injected into the generation prompt.
// Returns an empty string when no data is available (first run, no analytics yet).
function buildTopPerformerBlock(topHooks) {
  if (!topHooks || topHooks.length === 0) return '';
  const lines = [
    '',
    '## TOP-PERFORMING HOOKS (real engagement data from our past posts)',
    'These hooks generated the highest engagement on our actual audience.',
    'Study the PATTERN and TONE — replicate the formula, not the exact words.',
    'Do not reuse these verbatim. Use them to calibrate your opening energy.',
    '',
  ];
  for (const { hook, platform, persona, score } of topHooks) {
    lines.push(`- "${hook}" (${platform}/${persona}, score ${score})`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Hook Rotation System ─────────────────────────────────────────────────
// Five distinct hook formulas cycle through posts so no two adjacent posts
// open the same way and the algorithm sees variety across the day's batch.
// Formula is selected per-post by (dayOfYear + postIndex) % 5, guaranteeing:
//   - Different formula for each post within the same batch
//   - Formula set shifts each day so the same platform never gets the same
//     opener two days running
const HOOK_FORMULAS = [
  {
    name: 'STAT',
    description: 'Lead with a shocking or specific number.',
    example: '$8,000 a year. For email follow-ups.',
    instruction: 'Open with a concrete number that creates immediate "wait, really?" tension. The number should feel specific and surprising, not round or generic. State the number first, then the context. E.g. "$400 a file. And she still missed the amendment."',
  },
  {
    name: 'QUESTION',
    description: 'Open with the exact question the agent is already thinking.',
    example: 'What happens when your TC quits mid-deal?',
    instruction: 'Ask the question that is already running through the agent\'s head but that they haven\'t said aloud. Must be a real operational fear, not rhetorical filler. E.g. "Who follows up with the lender when you\'re at a showing?"',
  },
  {
    name: 'CONTRAST',
    description: 'Before vs after — then vs now.',
    example: 'Last month: spreadsheets at midnight. This month: Dossie handles it.',
    instruction: 'Two beats: the old painful reality vs the new Dossie reality. Keep each beat short — 5-8 words each. The contrast should feel earned, not like an ad. E.g. "Last week: three missed follow-ups. This week: Dossie caught all of them."',
  },
  {
    name: 'STORY_OPEN',
    description: 'Drop directly into a scene.',
    example: 'She had 6 closings in 10 days and no TC.',
    instruction: 'Start in the middle of a scene — no setup, no preamble. Immediate situation. The reader should feel like they walked into the room mid-story. E.g. "Friday at 4pm. Option period expires Monday. TC unreachable." Then continue the story.',
  },
  {
    name: 'BOLD_CLAIM',
    description: 'Make a direct, confident declaration.',
    example: 'You don\'t need a TC. You need a system.',
    instruction: 'Lead with a confident declarative statement that challenges a common assumption. Must be true and defensible, not hype. E.g. "Every missed deadline has the same cause. No one was watching."',
  },
];

// Returns the hook formula for a given post index within today\'s batch.
// Uses dayOfYear so the daily cycle shifts even when postIndex repeats across
// days (i.e., post 0 gets a different formula on Tuesday than on Monday).
function pickHookFormula(dayOfYear, postIndex) {
  const idx = (dayOfYear + postIndex) % HOOK_FORMULAS.length;
  return HOOK_FORMULAS[idx];
}

// Pre-compute today\'s dayOfYear once for the full batch so all formula picks
// are consistent within a single run.
function getDayOfYear() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const today = new Date();
  return Math.floor((today - start) / 86400000);
}

// ─── Format Validation (Improvement 3) ────────────────────────────────────
// Enforces caption length limits and hashtag count rules per platform.
// Mutates caption in-place (truncation) or strips/trims hashtags.
// Never throws — returns the corrected caption string.

const CAPTION_LIMITS = {
  instagram: 2200,
  twitter: 280,
  linkedin: 3000,
  facebook: 63206,
  tiktok: 2200,
  youtube: 5000, // YouTube description limit is 5000 chars
};

const HASHTAG_RULES = {
  twitter:   { max: 3 },
  instagram: { min: 8 },
  linkedin:  { min: 3, max: 5 },
  facebook:  { strip: true },
  tiktok:    { max: 3 },
  youtube:   { min: 3, max: 5 },
};

function validateAndFixCaption(caption, platform) {
  let text = String(caption || '');

  // 1. Strip all hashtags from Facebook posts
  const rules = HASHTAG_RULES[platform] || {};
  if (rules.strip) {
    const before = text;
    text = text.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();
    if (text !== before) {
      console.warn(`[cron-generate-posts] [format] stripped hashtags from facebook post`);
    }
  }

  // 2. Enforce Twitter max 3 hashtags
  if (rules.max && platform === 'twitter') {
    const hashtagMatches = [...text.matchAll(/#\w+/g)];
    if (hashtagMatches.length > rules.max) {
      // Remove excess hashtags from the end of the string
      const excess = hashtagMatches.slice(rules.max);
      for (const m of excess.reverse()) {
        text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      }
      text = text.replace(/\s{2,}/g, ' ').trim();
      console.warn(`[cron-generate-posts] [format] trimmed twitter hashtags to ${rules.max}`);
    }
  }

  // 3. Warn if Instagram has fewer than 8 hashtags (don't fail — verifier handles)
  if (platform === 'instagram' && rules.min) {
    const count = (text.match(/#\w+/g) || []).length;
    if (count < rules.min) {
      console.warn(`[cron-generate-posts] [format] instagram post has ${count} hashtags (min ${rules.min})`);
    }
  }

  // 4. Enforce character limits — truncate at last space before limit, append '...'
  const limit = CAPTION_LIMITS[platform];
  if (limit && text.length > limit) {
    let truncated = text.slice(0, limit - 3);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > limit * 0.8) truncated = truncated.slice(0, lastSpace);
    text = truncated + '...';
    console.warn(`[cron-generate-posts] [format] truncated ${platform} caption to ${text.length} chars (limit ${limit})`);
  }

  return text;
}

function buildPlatformRulesBlock(platform) {
  const r = PLATFORM_RULES[platform];
  if (!r) return '';
  return [
    `   ALGORITHM RULES FOR ${platform.toUpperCase()} — apply strictly:`,
    `   - Hook: ${r.hook_rule}`,
    `   - Length: ${r.length_rule}`,
    `   - Format: ${r.format_rule}`,
    `   - CTA: ${r.cta_rule}`,
    `   - Hashtags: ${r.hashtags}`,
  ].join('\n');
}

// Platform-native format instructions — more opinionated than PLATFORM_RULES.
// These describe the exact writing style expected, not just the algorithm rules.
// Injected per-post alongside the hook formula so the model has a complete,
// coherent brief for the specific platform it\'s writing for.
const PLATFORM_NATIVE_FORMAT = {
  facebook: `   FACEBOOK WRITING STYLE — native format:
   - Emotional storytelling. Write like a real agent posting from their personal page, not a brand account.
   - 3-5 sentences max for the opening hook before a line break. Then continue the story in 2-3 more short paragraphs.
   - Conversational tone, like a post from a friend who happens to know real estate inside out.
   - End with a soft, natural CTA — not a sales pitch. "If you're still doing this manually, meetdossie.com/founding is worth 2 minutes."
   - NO HASHTAGS. Facebook hashtags add zero distribution value and look spammy. Hard rule.`,

  twitter: `   TWITTER/X WRITING STYLE — native format:
   - Punchy, opinionated, or contrarian. Opinions and takes get pushed; safe content dies.
   - First tweet must be under 240 characters — it is the hook that determines whether anyone reads the thread.
   - For threads: write each tweet as a standalone thought that also connects to the next. The publish system handles threading automatically — do NOT add manual numbering like "1/" or "2/4".
   - Bold opener. Cut the fluff from word one.
   - 2-3 hashtags max at the very end of the final tweet only.`,

  instagram: `   INSTAGRAM WRITING STYLE — native format:
   - Visual-first: the caption supports the image card, not the other way around. The hook must make someone stop scrolling before they even read the card.
   - Short punchy lines. Put a line break between every sentence — Instagram captions are read on mobile in portrait mode, not as prose blocks.
   - The first 125 characters show before "more" — front-load the sharpest line.
   - End with a save-or-share CTA: "Save this for your next transaction" or "Send this to an agent who needs it." Saves and shares beat likes for reach.
   - 8-10 hashtags at the very end, on their own line after the CTA.`,

  linkedin: `   LINKEDIN WRITING STYLE — native format:
   - Professional peer-to-peer, not marketer-to-prospect. Write like a broker talking shop with other brokers.
   - First two lines are visible before the "see more" fold — they must deliver a specific insight, number, or contrarian take. No "Excited to share..." openers.
   - 1300-2000 characters total (roughly 200-300 words). LinkedIn's algorithm rewards this range with the strongest dwell signal.
   - Short paragraphs, 1-3 sentences each, heavy line breaks. Skimmable, not dense.
   - End with a specific operational question that invites readers to reply with their own number or process. "What does your TC actually cost per file when you add the chase time?" beats "Thoughts?" by 3x on replies.
   - 3-5 professional hashtags at the end.`,

  tiktok: `   TIKTOK WRITING STYLE — native format:
   - First sentence must be under 8 words and create immediate curiosity or tension. Never start with "I".
   - Under 150 words total. Shorter = higher completion rate = more reach.
   - Line break after every 1-2 sentences. No paragraphs. This is mobile, portrait-mode reading.
   - End with a single clear action: "Link in bio" or "Comment YES if this is you."
   - 2-3 hashtags at the end.`,

  youtube: `   YOUTUBE WRITING STYLE — native format:
   - This is the description field. It supports the video — write for someone who just watched and wants to learn more or take action.
   - Open with 1-2 punchy sentences restating the core value of the video. Then expand with context (1-2 short paragraphs).
   - YouTube description is read AFTER the video, not instead of it — don't repeat the voiceover verbatim. Complement it.
   - Include a clear CTA paragraph: "Try Dossie free: meetdossie.com/founding" + "Subscribe for more Texas real estate tips."
   - 3-5 relevant hashtags at the end.
   VOICEOVER NOTE: For YouTube, the voiceover_script should be 60-90 seconds (550-800 chars). More educational depth than TikTok. Structure: state the problem -> explain the TREC rule or feature with one concrete example -> show how Dossie handles it -> CTA. Conversational, not scripted. End with "This is Dossie. Texas agents - meetdossie.com slash founding."`,
};

function buildPlatformNativeBlock(platform) {
  return PLATFORM_NATIVE_FORMAT[platform] || '';
}

// ─── Per-format slot brief builder ───────────────────────────────────────────
// Returns the brief block for one post slot in the generation prompt.
// Persona slots use the existing persona + hook-formula pattern.
// Non-persona slots (CAPABILITY_ONELINER, TREC_EDUCATION, FOUNDER_STORY) get
// a Dossie brand-voice brief instead — no persona wrapper, no fictional agent.
function buildSlotBrief(slot, index, dayOfYear) {
  const { format = 'PERSONA_STORY', persona: personaKey, platform, notes } = slot;
  const hookFormula = pickHookFormula(dayOfYear, index);

  if (format === 'PERSONA_STORY') {
    const persona = PERSONAS[personaKey];
    return `${index + 1}. FORMAT: PERSONA_STORY
   Persona: ${persona.name} (${personaKey}) — ${persona.summary}
   Platform: ${platform}
   ${notes}
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}
   HOOK FORMULA FOR THIS POST — ${hookFormula.name}:
   Description: ${hookFormula.description}
   Example: "${hookFormula.example}"
   How to apply: ${hookFormula.instruction}`;
  }

  if (format === 'CAPABILITY_ONELINER') {
    return `${index + 1}. FORMAT: CAPABILITY_ONELINER — Dossie brand voice, NO persona wrapper
   Voice: Dossie (warm, capable, Texas-specific, never corporate)
   Platform: ${platform}
   ${notes}
   STRUCTURE: feature name -> what it does -> one concrete outcome -> CTA
   EXAMPLE CAPTION: "Dossie scans a TREC contract in about 8 seconds. Deadlines auto-calculated, paragraph cited. No math. No spreadsheet. $29/month founding pricing at meetdossie.com/founding"
   ALLOWED FEATURES (shipped, safe to claim): TREC deadline auto-calc with paragraph cites, contract PDF scanning, email draft queue (drafts only - agent reviews and sends), morning brief with Luna voice, closing milestone cards, dossier pipeline view with deadline badges, Talk-to-Dossie chat, natural-language deadlines.
   DO NOT claim any unshipped feature. Keep it to ONE feature per post — do not stack multiple capabilities into one claim.
   Set "persona" in the output JSON to "dossie" for this slot.
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}
   HOOK FORMULA FOR THIS POST — ${hookFormula.name}:
   Description: ${hookFormula.description}
   Example: "${hookFormula.example}"
   How to apply: ${hookFormula.instruction}`;
  }

  if (format === 'TREC_EDUCATION') {
    return `${index + 1}. FORMAT: TREC_EDUCATION — Dossie brand voice, NO persona wrapper
   Voice: Dossie (authoritative but plain-language, peer-to-peer with Texas agents, never corporate)
   Platform: ${platform}
   ${notes}
   STRUCTURE: TREC fact/rule -> why it matters to the agent -> how Dossie handles it -> CTA
   EXAMPLE CAPTION: "Option period in Texas runs from executed date plus N days. Miss the termination deadline by one minute and the right is gone. Dossie calculates it automatically and flags it in your morning brief. meetdossie.com/founding"
   PRE-VERIFIED TREC FACTS (safe to reference — pick one per post):
   - Option period: buyer's right to terminate, runs from execution date; one-minute miss eliminates the right
   - Earnest money: typically due within 3 days of contract execution to title company
   - Survey period: buyer obtains survey, seller reviews objections within specified period
   - Title commitment: typically 20 days for buyer to review and object
   - Closing date: TREC specifies exact mechanics for extensions via amendment only
   - Third-party financing contingency: buyer has a financing contingency period; lapse = non-refundable earnest money risk
   Use only one TREC fact per post. Do NOT invent additional TREC rules or deadlines not listed above.
   Set "persona" in the output JSON to "dossie" for this slot.
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}
   HOOK FORMULA FOR THIS POST — ${hookFormula.name}:
   Description: ${hookFormula.description}
   Example: "${hookFormula.example}"
   How to apply: ${hookFormula.instruction}`;
  }

  if (format === 'FOUNDER_STORY') {
    return `${index + 1}. FORMAT: FOUNDER_STORY — Heath's real verified pain stories, Dossie brand voice, NO persona wrapper
   Voice: Dossie / Heath's authentic founder voice (direct, personal, no polish, talking agent-to-agent)
   Platform: ${platform}
   ${notes}
   STRUCTURE: specific moment -> what it cost -> what Dossie would have done -> CTA
   THREE APPROVED STORIES — use ONLY these, pick one, do not invent any new details:
   1. TC quit mid-deal while Heath was traveling internationally (Italy). 7-8 hour time difference. Active transactions in escrow. Vacation destroyed. Quote: "vacation is the stress test your systems fail."
   2. $400/file cost, still waking up at 4:30am wondering if the option fee receipt was sent (wondering if the repair amendment went out). Paid the TC. Still lost sleep.
   3. Managing transactions remotely while away from home — constant background anxiety about what might be falling through the cracks without someone watching.
   DO NOT invent new specifics (timestamps, deal addresses, dollar amounts not listed above). If a detail is not in the three stories above, it is forbidden.
   Set "persona" in the output JSON to "dossie" for this slot.
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}
   HOOK FORMULA FOR THIS POST — ${hookFormula.name}:
   Description: ${hookFormula.description}
   Example: "${hookFormula.example}"
   How to apply: ${hookFormula.instruction}`;
  }

  // Fallback — treat unknown formats as PERSONA_STORY if persona is set
  if (personaKey && PERSONAS[personaKey]) {
    const persona = PERSONAS[personaKey];
    return `${index + 1}. FORMAT: ${format} (fallback to PERSONA_STORY)
   Persona: ${persona.name} (${personaKey}) — ${persona.summary}
   Platform: ${platform}
   ${notes}
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}`;
  }

  return `${index + 1}. FORMAT: ${format} — Dossie brand voice
   Platform: ${platform}
   ${notes}
${buildPlatformRulesBlock(platform)}
${buildPlatformNativeBlock(platform)}`;
}

function buildPrompt(topic, plan, dayOfYear, topPerformerBlock) {
  const planLines = plan.map((p, i) => buildSlotBrief(p, i, dayOfYear)).join('\n\n');

  // Determine if any persona slots exist in this plan (for persona-voice section)
  const hasPersonaSlots = plan.some((p) => (p.format || 'PERSONA_STORY') === 'PERSONA_STORY');
  // Determine if any non-persona (brand-voice) slots exist
  const hasBrandVoiceSlots = plan.some((p) => p.format && p.format !== 'PERSONA_STORY');

  const personaVoiceSection = hasPersonaSlots ? `
PERSONA VOICE — CRITICAL (applies ONLY to PERSONA_STORY slots)
- ALL persona content MUST be written in THIRD PERSON, never first person.
- NEVER write "I" as if the persona is the poster.
- Write ABOUT the persona, not AS the persona.
- Examples:
  * WRONG: "I closed 6 deals this month."
  * RIGHT: "She closed 6 deals this month."
  * WRONG: "Last year I paid $8,000 for TC work."
  * RIGHT: "Last year she paid $8,000 for TC work."
- Brenda = she/her, Patricia = she/her, Victor = he/him.
- AVOID the phrasing "X started using Dossie recently" — write "Now Dossie handles X for her" or jump directly into describing the result.
` : '';

  const brandVoiceSection = hasBrandVoiceSlots ? `
DOSSIE BRAND VOICE — for CAPABILITY_ONELINER, TREC_EDUCATION, and FOUNDER_STORY slots
- Write AS Dossie / the Dossie brand — not as a fictional persona, not as a marketer.
- Warm, capable, Texas-specific, never corporate.
- Plain language. Real specifics. No hype.
- First person is allowed for the brand voice ("Dossie scans", "Dossie calculates").
- Do NOT invent any persona wrapper for these slots. No "Brenda did X." No fictional agent.
- Set "persona" to "dossie" in the JSON output for these slots.
` : '';

  return `${topPerformerBlock || ''}## FACTUAL ACCURACY RULES — NON-NEGOTIABLE

You may ONLY reference verified real facts about Dossie. Hallucinated specifics destroy customer trust the moment they're noticed.

ALLOWED specifics:
- The founder pain stories saved verbatim in CLAUDE.md and the memory file \`project_heath_founder_pain_stories.md\` (TC quit while Heath was in Italy with deals in escrow; $400/file and still waking at 4:30am wondering if the option fee receipt was sent; "vacation is the stress test your systems fail" reframe; Brittney's "control freak / visibility problem" insight)
- Customer first names + brokerage + market that are documented in CLAUDE.md section 6 "CURRENT CUSTOMERS" (currently __FOUNDING_COUNT__ founding members). If you need to count founders, use "__FOUNDING_COUNT__ of 50 founding spots taken" — never go higher.
- Real product features that exist: TREC deadline auto-calc with paragraph cites, contract PDF scanning, email draft queue (drafts only, agent sends), morning brief with voice, closing milestone cards, dossier pipeline view, Talk-to-Dossie chat.

FORBIDDEN specifics:
- Any founding member number past __FOUNDING_COUNT__
- Invented timestamps ("Tuesday 9:43pm", "10pm debug session")
- Features that aren't shipped yet: bulk email drafts, Reply Monitoring, AI Autopilot, amendment drafting, Social Media Autopilot
- Heath behaviors that don't happen: Heath posting code commits to socials, Heath doing public debug streams, Heath having a Discord/community
- Specific customer events not in CLAUDE.md ("Brittney sent a message at X time about Y") — UNLESS the event is documented in CLAUDE.md or in the founder pain stories memory
- Made-up customer testimonials or quotes you invent

When in doubt, frame as universal/hypothetical rather than specific: "Most agents have had a deadline almost slip at 7am" beats "Brittney had a 7am call about a deadline" (which would require verification).

If the theme of the post (e.g. \`build_in_public\`) tempts you to invent a story, REFRAME instead: write about the GENERAL pattern using verified facts only.

---

Generate 9 social media posts for Dossie. Topic for today: ${topic.label}.

Topic angle:
${topic.angle}

BRAND CONTEXT
- Dossie is an AI transaction coordinator for Texas real estate agents.
- Founding-member pricing is $29/month, locked while subscription stays active.
- Sign up: meetdossie.com/founding
- Voice: warm but blunt. Peer-to-peer, not marketer-to-prospect. No hashtag-stuffing. No "🔥💯🚀" emoji-spam. No "Game changer!" or "Stop scrolling!" hooks.
${personaVoiceSection}${brandVoiceSection}
NUMBERS & CLAIMS
- Any number used in a post (deals/year, $/file, etc.) is fictional and MUST be framed as a hypothetical or example. Use phrasing like "agents doing 50+ deals a year", "if you're paying around $400 a file", "say you do 10-12 deals a year".
- Do NOT present specific numbers as if they're real stats about the agent or about Dossie's user base. Never write "54 deals" as if reporting fact — write "50+ deals a year" or "an agent doing 50 a year" instead.
- No claims about user counts, subscriber counts, or comparative metrics ("X% faster", "$Y saved last year") — Dossie is brand new and those numbers don't exist yet.
- The $29/month founding price IS real — that one specific number is fine to state directly.

TIMEFRAMES & DOSSIE-USAGE DURATION
- Dossie launched recently. When a persona references how long they've been using Dossie, use "recently" or "over the last few weeks" — NEVER "a few months ago", "for the past year", "since last summer", or any phrasing that implies they've used Dossie for longer than a few weeks.
- Past-tense scenarios about life BEFORE Dossie are fine and can be specific ("Last year she forgot two lender intros"). The constraint is only on phrasing that puts Dossie in the persona's life on a months/years timescale.
- "Dossie calculates X", "Now Dossie handles it" are fine tense-neutral phrasings. Use them for brand-voice slots.

ALGORITHM OPTIMIZATION
You are generating content optimized for each platform's algorithm performance. The rules under each post in the plan below are not suggestions — they describe how that platform actually distributes content. Breaking these rules means the post gets shown to fewer people. Apply them strictly per post. The goal is maximum organic reach.

POST PLAN (9 posts):

${planLines}

OUTPUT FORMAT
Return STRICT JSON only. No markdown fences. No commentary before or after. Format:

{
  "posts": [
    {
      "format": "PERSONA_STORY" | "CAPABILITY_ONELINER" | "TREC_EDUCATION" | "FOUNDER_STORY",
      "persona": "brenda" | "patricia" | "victor" | "dossie",
      "platform": "linkedin" | "facebook" | "instagram" | "tiktok" | "twitter" | "youtube",
      "voiceover_script": "<35-45 second spoken script for ElevenLabs TTS. Conversational, present-tense, no em-dashes. Ends with 'This is Dossie. Texas agents - meetdossie.com slash founding.' Never use special characters. Approx 400-500 chars.>",
      "caption": "<the full post text for social media — can be longer, tell the full story, include CTA and hashtags at the end>",
      "hook": "<punchy, pattern-interrupting opening — 5-8 words MAXIMUM. Examples: 'Your TC just quit. Now what?', '80 transactions. Zero TC.', 'She closed 6 deals this month.' Start with a question, number, or provocative statement — never generic 'Real talk' openers.>",
      "cta": "<the CTA line — should naturally include meetdossie.com/founding or 'founding member spots open' or similar>",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3"],
      "stat": "<bold anchor — single value, max 10 characters. Examples: '$29/mo', '80+', '$8,000', '9:47pm'. Pulled directly from the post — no new claims.>",
      "stat_label": "<plain descriptive phrase, max 50 characters. Examples: 'per year for a solo TC', 'deals this month', 'what the stress costs'>"
    }
  ]
}

Rules:
- Exactly 9 posts, in the order listed in the plan above.
- "format" must match the FORMAT specified in the slot brief (PERSONA_STORY, CAPABILITY_ONELINER, TREC_EDUCATION, or FOUNDER_STORY).
- "persona" must be "dossie" for CAPABILITY_ONELINER, TREC_EDUCATION, and FOUNDER_STORY slots.
- HASHTAGS: Must be appended to the END of the "caption" field (not just in the array):
  * Instagram: 8-10 hashtags separated by spaces
  * Twitter: 2-3 hashtags separated by spaces
  * LinkedIn: 3-5 hashtags separated by spaces
  * Facebook: ALWAYS 2-3 hashtags — use #txrealestate and #realtorlife plus one topic-relevant hashtag. Never leave blank for Facebook.
  * TikTok: 2-3 hashtags separated by spaces
- "hashtags" array must match what's in caption (no leading "#", no spaces in array entries).
- "stat" and "stat_label" are required for every post. Pull the stat from
  something the post actually says — never invent a new number.
- VOICEOVER SCRIPT: "voiceover_script" is the spoken narration for ElevenLabs TTS, used to
  build the Creatomate video. Conversational, present-tense. Must end with
  "This is Dossie. Texas agents - meetdossie.com slash founding." No em-dashes,
  no curly quotes, no special characters. Approx 400-500 chars (35-45s at natural pace).
- CAPTION: "caption" is the full post text that appears on social media. Can be
  longer, tell the full story. Must include CTA and hashtags at the end.
- TEXT ENCODING: Never use em-dashes (—), en-dashes (–), curly quotes (" " ' '),
  or special Unicode characters. Use only plain hyphens (-) and straight quotes (' ").
- The CTA must appear inside the "caption" field naturally — don't tack it on.
- Vary the openings. Don't start every post with "Real talk" or "Honest take."
- Don't reuse the exact same numbers across posts (different agents, different math).`;
}

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Anthropic returned non-JSON: ' + text.slice(0, 200));
  }
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error('Anthropic returned no content block');
  return content;
}

function extractJson(raw) {
  // Be lenient — strip markdown fences if present, find the first {…} block.
  let s = String(raw || '').trim();
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

// ─── Content-Verifier pass ──────────────────────────────────────────────
// Second Anthropic call (Haiku) that scans each generated post against the
// embedded facts snapshot and returns a JSON verdict. Fails safe: any error
// or malformed response → needs_revision with an explanatory flag.
async function verifyPost({ platform, persona, format, topic, content, founding }) {
  const userMessage = `Verify this draft. Return only the JSON verdict.\n\nFormat: ${format || 'PERSONA_STORY'}\nPlatform: ${platform}\nPersona: ${persona}\nTopic: ${topic}\n\nDRAFT:\n${content}`;

  let res, text;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VERIFIER_MODEL,
        max_tokens: 800,
        system: applyFoundingCount(VERIFIER_SYSTEM_PROMPT, founding),
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    text = await res.text();
  } catch (err) {
    return {
      verdict: 'needs_revision',
      flags: [{
        severity: 'red',
        claim: '(verifier API error)',
        issue: `verifier API call failed: ${String(err && err.message || err).slice(0, 200)}`,
        fix: 'retry verification or review manually',
      }],
      summary: 'Verifier call failed — defaulting to needs_revision (fail-safe).',
    };
  }

  if (!res.ok) {
    return {
      verdict: 'needs_revision',
      flags: [{
        severity: 'red',
        claim: '(verifier API error)',
        issue: `verifier returned HTTP ${res.status}: ${String(text || '').slice(0, 200)}`,
        fix: 'retry verification or review manually',
      }],
      summary: 'Verifier HTTP error — defaulting to needs_revision (fail-safe).',
    };
  }

  let raw;
  try {
    const data = JSON.parse(text);
    raw = data?.content?.[0]?.text;
  } catch {
    raw = null;
  }

  if (!raw) {
    return {
      verdict: 'needs_revision',
      flags: [{
        severity: 'red',
        claim: '(verifier response empty)',
        issue: 'verifier returned no content block',
        fix: 'retry verification or review manually',
      }],
      summary: 'Verifier returned empty response — defaulting to needs_revision (fail-safe).',
    };
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    return {
      verdict: 'needs_revision',
      flags: [{
        severity: 'red',
        claim: '(verifier malformed JSON)',
        issue: 'verifier returned malformed JSON',
        fix: 'review manually',
      }],
      summary: 'Verifier returned malformed JSON — defaulting to needs_revision (fail-safe).',
      raw_response: String(raw).slice(0, 500),
    };
  }

  // Normalize shape — guard against missing keys.
  const verdict = parsed?.verdict === 'approve' ? 'approve' : 'needs_revision';
  const flags = Array.isArray(parsed?.flags) ? parsed.flags : [];
  const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';

  // Defense in depth: even if the model says "approve", if it included any red
  // flag, override to needs_revision. The content-verifier rules require this.
  const hasRedFlag = flags.some((f) => String(f?.severity || '').toLowerCase() === 'red');
  const finalVerdict = hasRedFlag ? 'needs_revision' : verdict;

  return { verdict: finalVerdict, flags, summary };
}

function formatVerifierFlagsForErrorMessage(verifierResult) {
  if (!verifierResult) return '';
  const lines = [];
  lines.push(`VERIFIER: ${verifierResult.verdict}`);
  if (verifierResult.summary) lines.push(verifierResult.summary);
  const flags = Array.isArray(verifierResult.flags) ? verifierResult.flags : [];
  const interesting = flags.filter((f) => ['red', 'yellow'].includes(String(f?.severity || '').toLowerCase()));
  for (const f of interesting) {
    const sev = String(f.severity || '').toLowerCase();
    const claim = String(f.claim || '').slice(0, 120);
    const issue = String(f.issue || '').slice(0, 200);
    const fix = String(f.fix || '').slice(0, 200);
    lines.push(`[${sev}] "${claim}" — ${issue}${fix ? ' → ' + fix : ''}`);
  }
  return lines.join('\n').slice(0, 1800);
}

// ─── Card renderer — KILLED 2026-05-29 ────────────────────────────────────
// Image card (HCTI) pipeline is permanently retired. ALL social posts are now
// video-only. Posts flow directly to video_required=true status; the Creatomate
// pipeline attaches a rendered video via cron-send-for-approval or the DONE
// handler before Zernio publish. No card render step. No HCTI API calls.
// CARD_PLATFORMS and renderSocialCard are intentionally removed.

async function lookupZernioAccountId(platform) {
  const encoded = encodeURIComponent(platform);
  const { data } = await supabaseFetch(
    `/rest/v1/zernio_accounts?platform=eq.${encoded}&is_active=eq.true&select=zernio_account_id&limit=1`,
  );
  if (Array.isArray(data) && data.length > 0) return data[0].zernio_account_id || null;
  return null;
}

module.exports = async function handler(req, res) {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
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

  const now = new Date();
  const topic = pickTopic();
  const forceDay = parseForceDay(req);
  const plan = getPostPlan(now, { forceDay });
  const founding = await getFoundingMemberCount();
  const dayOfYear = getDayOfYear();
  // Log which hook formulas are assigned to today's batch for diagnostics.
  const hookAssignments = plan.map((p, i) => {
    const f = pickHookFormula(dayOfYear, i);
    const slotLabel = p.format || (p.persona ? `persona:${p.persona}` : 'unknown');
    return `${slotLabel}/${p.platform}=${f.name}`;
  });

  // Fetch top-performer hooks from post_analytics. Fails gracefully (returns [])
  // until the analytics pipeline has accumulated data (first few weeks).
  const topHooks = await fetchTopPerformerHooks();
  const topPerformerBlock = buildTopPerformerBlock(topHooks);
  if (topHooks.length > 0) {
    console.log(`[cron-generate-posts] injecting ${topHooks.length} top-performer hooks into prompt`);
  }

  console.log('[cron-generate-posts] starting batch — topic:', topic.key, 'slots:', plan.map((p) => `${p.format || 'PERSONA_STORY'}/${p.platform}`).join(','), 'force_day:', forceDay, 'founding:', founding.taken, 'remaining:', founding.remaining, 'hooks:', hookAssignments.join(' | '), 'top_performer_hooks:', topHooks.length, 'at', now.toISOString());

  let raw;
  try {
    raw = await callAnthropic(applyFoundingCount(buildPrompt(topic, plan, dayOfYear, topPerformerBlock), founding));
  } catch (err) {
    console.error('[cron-generate-posts] Anthropic call failed:', err && err.message);
    return res.status(502).json({ ok: false, error: 'content generation failed', detail: err && err.message });
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    console.error('[cron-generate-posts] failed to parse JSON. Raw head:', String(raw).slice(0, 400));
    return res.status(502).json({ ok: false, error: 'Anthropic response was not valid JSON' });
  }

  const generated = Array.isArray(parsed?.posts) ? parsed.posts : [];
  if (generated.length === 0) {
    console.error('[cron-generate-posts] no posts returned. Parsed:', JSON.stringify(parsed).slice(0, 400));
    return res.status(502).json({ ok: false, error: 'no posts returned' });
  }

  // Dry-run path: return the generated posts without inserting into the DB.
  // Used to preview output of new prompt/rules without polluting the queue.
  const reqUrl = new URL(req.url, 'https://meetdossie.com');
  if (reqUrl.searchParams.get('dry_run') === '1') {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      topic: topic.key,
      generated_count: generated.length,
      posts: generated,
    });
  }

  // Create batch row first so each post can reference it (informational only —
  // social_posts has no batch_id column today; we still record the totals).
  const batchPayload = {
    batch_name: `${now.toISOString().slice(0, 10)} — ${topic.key}`,
    total_posts: 0,
    approved_posts: 0,
    rejected_posts: 0,
    notes: `Auto-generated. Topic: ${topic.label}`,
    generated_at: now.toISOString(),
  };
  const batchInsert = await supabaseFetch('/rest/v1/content_batches', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(batchPayload),
  });
  const batchRow = Array.isArray(batchInsert.data) ? batchInsert.data[0] : batchInsert.data;
  const batchId = batchRow?.id || null;

  let inserted = 0;
  const insertErrors = [];
  const verifierSummary = []; // diagnostic: per-post verifier outcome
  // renderSummary removed 2026-05-29 — HCTI image cards retired, video-only pipeline
  for (let i = 0; i < generated.length; i++) {
    const p = generated[i];
    if (!p || typeof p !== 'object') continue;
    const format = String(p.format || 'PERSONA_STORY').toUpperCase();
    const persona = String(p.persona || '').toLowerCase();
    const platform = String(p.platform || '').toLowerCase();
    let caption = String(p.caption || p.content || '').trim(); // caption = full post text
    const voiceoverScript = String(p.voiceover_script || '').trim(); // spoken TTS script for Creatomate video
    const hook = String(p.hook || '').trim();
    const cta = String(p.cta || '').trim();
    const stat = String(p.stat || '').trim();
    const stat_label = String(p.stat_label || '').trim();
    const hashtags = Array.isArray(p.hashtags) ? p.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean) : [];
    // Brand-voice formats set persona="dossie" — valid, not a missing field.
    if (!caption || !platform || !persona) {
      insertErrors.push({ index: i, error: 'missing required field', got: { persona, platform, format, caption_length: caption.length } });
      continue;
    }

    // ─── Format validation (Improvement 3) ────────────────────────────────
    // Enforce caption length limits + hashtag rules before insert.
    // Mutates caption in-place; non-fatal — never blocks the insert.
    caption = validateAndFixCaption(caption, platform);

    let zernioAccountId = null;
    try { zernioAccountId = await lookupZernioAccountId(platform); } catch (_e) { zernioAccountId = null; }

    // When force_day is set we may run multiple test batches in a single day;
    // add a short epoch-second suffix so post_ids don't collide with the real
    // morning batch (which has no suffix).
    const testSuffix = forceDay !== null ? `-test${Math.floor(Date.now() / 1000) % 100000}` : '';
    const postId = `${now.toISOString().slice(0, 10)}-${persona}-${platform}-${i}${testSuffix}`;

    // Image card render removed 2026-05-29.
    // media_url stays null until the DONE handler attaches a Creatomate-rendered
    // video URL. video_required is platform-specific: only instagram and tiktok
    // require media before Zernio will publish. Twitter, LinkedIn, and Facebook
    // are text-only and must NOT be gated on video -- setting video_required=true
    // for those platforms caused LinkedIn/Twitter to stop posting permanently.
    const mediaUrl = null;
    // Platforms that require a video/image attachment before publishing.
    // All others publish text-only via Zernio without any media gate.
    const VIDEO_REQUIRED_PLATFORMS = new Set(["instagram", "tiktok", "youtube"]);
    const platformVideoRequired = VIDEO_REQUIRED_PLATFORMS.has(platform);

    // ─── Content-Verifier pass ───────────────────────────────────────────
    // Every freshly-generated post gets a second AI eyeballing it against
    // the embedded facts snapshot. Posts with red flags or "needs_revision"
    // verdict are auto-rejected so Heath doesn't see fabrications in the
    // approval queue.
    const verifierStart = Date.now();
    const verifierResult = await verifyPost({
      platform,
      persona,
      format,
      topic: topic.key,
      content: caption,
      founding,
    });
    const verifierMs = Date.now() - verifierStart;
    const flagsCount = Array.isArray(verifierResult.flags) ? verifierResult.flags.length : 0;
    console.log(`[verifier] ${postId} verdict=${verifierResult.verdict} flags=${flagsCount} (${verifierMs}ms)`);
    verifierSummary.push({
      post_id: postId,
      verdict: verifierResult.verdict,
      flags: flagsCount,
      ms: verifierMs,
    });

    // Decide row status:
    //   needs_revision → always rejected (regardless of AUTO_APPROVE_POSTS)
    //   approve + AUTO_APPROVE_POSTS=true → approved
    //   approve + AUTO_APPROVE_POSTS=false (default) → draft (manual approval)
    let rowStatus;
    if (verifierResult.verdict === 'needs_revision') {
      rowStatus = 'rejected';
    } else if (AUTO_APPROVE_POSTS) {
      rowStatus = 'approved';
    } else {
      rowStatus = 'draft';
    }

    // For rejected posts, surface flag details in error_message for quick debugging.
    let errorMessage = null;
    if (verifierResult.verdict === 'needs_revision') {
      errorMessage = formatVerifierFlagsForErrorMessage(verifierResult);
    }

    // Notify Heath via Telegram when a post is auto-rejected by the verifier.
    // Fire-and-forget — a Telegram failure should never block DB insert.
    if (rowStatus === 'rejected' && verifierResult.verdict === 'needs_revision') {
      const tgChatId = process.env.TELEGRAM_CHAT_ID || '7874782923';
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      if (tgToken) {
        const hookPreview = String(caption).slice(0, 80);
        const reason = verifierResult.summary || (Array.isArray(verifierResult.flags) && verifierResult.flags.length > 0
          ? verifierResult.flags.filter(f => f.severity === 'red').map(f => f.issue).join('; ').slice(0, 200)
          : 'no details');
        const tgText = `Warning Auto-rejected post (platform: ${platform}, persona: ${persona})\nReason: ${reason}\nHook: ${hookPreview}`;
        fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChatId, text: tgText }),
        }).catch((err) => {
          console.warn('[cron-generate-posts] Telegram auto-reject notification failed:', err && err.message);
        });
      }
    }

    const row = {
      post_id: postId,
      platform,
      content: caption, // Full post text for social media
      content_hash: require('crypto').createHash('md5').update(caption).digest('hex'),
      hook: hook || caption.slice(0, 120),
      cta,
      hashtags,
      status: rowStatus,
      telegram_sent_at: null,
      zernio_account_id: zernioAccountId,
      persona,
      topic: topic.key,
      media_url: mediaUrl, // null — video attached downstream by Creatomate pipeline
      voiceover_script: voiceoverScript || null, // spoken TTS text for Creatomate render
      video_required: platformVideoRequired, // only instagram+tiktok require media; twitter/linkedin/facebook publish text-only
      generated_at: now.toISOString(),
      created_at: now.toISOString(),
      // Store format in verifier_result metadata — no new column needed
      verifier_result: { ...verifierResult, content_format: format },
      error_message: errorMessage,
    };

    const ins = await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (ins.ok) inserted++;
    else insertErrors.push({ index: i, status: ins.status, body: typeof ins.data === 'string' ? ins.data.slice(0, 200) : JSON.stringify(ins.data).slice(0, 200) });
  }

  // Bug 2 fix: for every slot in the planned post schedule that produced no
  // generated post (missing required fields caused a `continue` above), insert
  // a status='failed' row so the gap is visible in Supabase rather than silent.
  //
  // Key by position (index) rather than persona-platform — new brand-voice formats
  // can have multiple slots on the same platform with no persona, so persona+platform
  // is no longer unique. The generated array is positionally ordered to match plan.
  const successfulIndexes = new Set();
  for (let i = 0; i < generated.length; i++) {
    const p = generated[i];
    if (p && p.platform && (p.caption || p.content)) successfulIndexes.add(i);
  }
  for (let i = 0; i < plan.length; i++) {
    if (successfulIndexes.has(i)) continue;
    const slot = plan[i];
    const slotLabel = slot.format || (slot.persona ? slot.persona : 'dossie');
    const slotKey = `${slotLabel}-${String(slot.platform || '').toLowerCase()}-${i}`;
    const testSuffix = forceDay !== null ? `-test${Math.floor(Date.now() / 1000) % 100000}` : '';
    const failedPostId = `${now.toISOString().slice(0, 10)}-${slotLabel}-${slot.platform}-${i}-failed${testSuffix}`;
    const failedRow = {
      post_id: failedPostId,
      platform: slot.platform,
      persona: slot.persona || 'dossie',
      topic: topic.key,
      status: 'failed',
      content: '',
      generated_at: now.toISOString(),
      created_at: now.toISOString(),
      error_message: `Post generation failed: missing required fields for planned slot ${slotKey} (format: ${slot.format || 'PERSONA_STORY'})`,
    };
    console.warn(`[cron-generate-posts] slot ${slotKey} produced no valid post — inserting failed row ${failedPostId}`);
    await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(failedRow),
    });
  }

  // Update batch totals.
  if (batchId) {
    await supabaseFetch(`/rest/v1/content_batches?id=eq.${encodeURIComponent(batchId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ total_posts: inserted }),
    });
  }

  const verifierApproved = verifierSummary.filter((v) => v.verdict === 'approve').length;
  const verifierRejected = verifierSummary.filter((v) => v.verdict === 'needs_revision').length;
  console.log('[cron-generate-posts] done — inserted', inserted, 'of', generated.length, 'errors:', insertErrors.length, 'verifier approve:', verifierApproved, 'needs_revision:', verifierRejected, '(video-only mode: no card renders)');

  // Batch rejection rate alert: if 2+ posts rejected in a single run, send an alert via Claudy.
  if (verifierRejected >= 2) {
    const tgChatId = process.env.TELEGRAM_CHAT_ID || '7874782923';
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    if (tgToken) {
      const rejectedPlatforms = verifierSummary
        .filter((v) => v.verdict === 'needs_revision')
        .map((v) => v.post_id || 'unknown')
        .join(', ');
      const alertText = `Verifier rejected ${verifierRejected} posts today (topic: ${topic.key})\nPost IDs: ${rejectedPlatforms}\nCheck social_posts table error_message for details.\nTotal in batch: ${generated.length} generated, ${inserted} inserted, ${verifierApproved} approved`;
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text: alertText }),
      }).catch((err) => {
        console.warn('[cron-generate-posts] batch rejection alert failed:', err && err.message);
      });
    }
  }

  return res.status(200).json({
    ok: true,
    generated: generated.length,
    inserted,
    batch_id: batchId,
    topic: topic.key,
    force_day: forceDay,
    errors: insertErrors,
    video_only_mode: true, // image cards retired 2026-05-29; all posts have video_required=true
    verifier_summary: verifierSummary,
    verifier_totals: { approve: verifierApproved, needs_revision: verifierRejected },
  });
};
