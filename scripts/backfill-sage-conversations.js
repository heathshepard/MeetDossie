const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const envText = fs.readFileSync(envPath, 'utf8');
const envMap = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  envMap[m[1]] = v;
}

const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
const KEY = envMap.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const CHAT_ID = '7874782923';

const row1Text = `SAGE here.

Before I propose anything, I owe you my work. My agent file (~/.claude/agents/sage.md) has algorithm weights and posting windows for IG Reels, FB Page Reels, TikTok, LinkedIn, X, and YouTube — what gets boosted, what gets shadow-banned, what hashtag density is optimal where. Honest gap: FB Groups specifically are NOT in my agent file. My knowledge there is general training, not Dossie-tested. I also haven't read live Zernio analytics yet because cron-sage-intelligence hasn't completed a full 7-day window.

Five high-confidence principles on FB groups from what I know:
1. Conversation beats broadcast. Posts with a real question outperform posts that announce a thing.
2. Native screenshots beat outbound links every single time. The algorithm penalizes anything that pulls users off Facebook.
3. The helpful-comment-to-DM is the actual funnel. Most converters in TX RE groups never click a link — they DM the poster after seeing 3-5 of their comments add real value.
4. On commenting: yes, unlimited as long as substantive. The anti-spam trip wire is identical phrasing across groups, not raw comment count. 10 personalized helpful comments/day stays safe; 50 copy-paste flags you.
5. Video natively uploaded outperforms shared YouTube links 3-5x.

To make a real plan I need to interview you. Five questions:
1. Beyond Miki and Amanda from Ginger's group, which other founding members trace back to FB groups specifically?
2. Where do you want growth — solo agents (faster close) or team-lead brokers (multi-seat, higher LTV)? Or both, split?
3. Inventory check: which TX RE FB groups are you IN but haven't posted in substantially?
4. From your years as a member, what kinds of posts in TX RE groups actually blow up?
5. What's your no-go list? (e.g. fake testimonials, paid endorsements without disclosure, anything else?)

— Sage`;

const row2Text = `I think almost all of our members came from Facebook groups. Suzanne is a friend. Lisa Nilsson came from calling about 100 Realtors. Or texting a bunch, I think Tiffany Gill. Also, I knew her, but I think she came from the Internet from Facebook as well. So yeah, it's our main driving force. Natalie is on vacation, so I won't be able to talk to her for a while.

I mean I would like to get brokers. That would be my ideal would be to get brokers because they have agents under them. I just don't know how realistic that is at this point. I think solo agents might be easier to convert than brokers who have well established systems. So I still don't have an answer to that unfortunately. I could need help with that.

I don't know how many Facebook groups we have not posted in. I'm sure we've posted in most of them at this point, but not substantially. Most of the Facebook groups are realtor focused.

What posts blow up in Texas RE groups? I don't know. I've never really been very active on social media 'cause I don't know how to do it. So that's why I'm trying to train you to be the absolute expert on social media. So that you can do it and do it. As an expert would.

I'm trying to train you, Sage. As a first first class Wall Street level social media marketing executive. If that makes sense. It's like tip top. Knows everything there is to know about social media, its algorithms, how to succeed. And I guess specifically? Umm, we want to go viral as Texas's premier Transaction coordinator software. I don't want you to feel limited. I want to know everything that you need to do that.

So if we have a plan in place. And you say you need money to do this or that because it's necessary for our to get to our desired income. You have to let me know. I want to be able to trust you. That you know what you're doing. So you need to really do deep research and earn my trust. That you know how to sell dossie as the premier transaction coordinator software AI software in the space.

Me saying I flat out won't do. I won't lie. Or be dishonest. I want to be authentic sounding. Trustworthy. So no contradictions of myself.

I am willing to pay influencers. It's been on my mind, actually. And maybe to. I've reached out to a couple of the large names in like Texas. And tried to pitch them a referral link concept. I think it could still be improved upon. I haven't heard back from any of them.`;

const row3Text = `SAGE —

ICP call (you asked me to make it): Don't pick, sequence. Solo agents this quarter to fund the broker push next quarter. Brittney is the case study that eventually unlocks brokers. Sales cycle reality: solo agents close in days, brokers in 6-12 months with case studies. We don't have the case studies yet, so we win the solos that fund our patience.

Research I'm committing to deliver by Friday June 12:
1. TX RE FB group post mining — 100 top-performing posts from 2024-2026, analyzed for hook structure, format, persona, length, time-of-day
2. Competitor teardown — DealDock, ListedKit, Done Deal — their last 90 days of social, gaps Dossie can own
3. TX RE influencer map — top 30 names with REAL engagement, not vanity follower counts
4. Algorithm audits per platform for SMB SaaS founder content in 2026
5. Redefined viral metric — for Dossie, "viral" = every TX agent thinks "Dossie" when they hear "transaction coordinator" within 90 days, not 1M views

Influencer pitch diagnosis: cold-DM referral-link pitches are dead on arrival to influencers — they look transactional and low-tier. Real influencer deals require relationship (months in orbit), reciprocity (you've referred them, hyped them, sent them something), and a SPECIFIC paid offer with simple economics — not "let's set up a referral arrangement" hand-wave.

Recommended 3-touch sequence:
- Touch 1 — public engagement: comment thoughtfully on 5+ of their recent posts over 2 weeks
- Touch 2 — value send: DM a Dossie demo with their workflow specifically mapped, no ask
- Touch 3 — paid offer: $1,500-2,500 for a single sponsored post with FTC disclosure + the option to upgrade to ongoing affiliate (~30% of first 12 months MRR per signup)

Budget asks I'd defend:
- Submagic Business tier upgrade: $60/mo (restores API access for auto-captions on every video — Carter blocked here since 2026-05-25)
- Influencer test budget: $500-2,000 one-time for 1 sponsored post pilot with 1 TX RE influencer (10k+ engaged followers, not raw count)
- Paid social boost: $100/mo on the 1 best organic post per month to test paid amplification on a proven hit
- Heath photoshoot day: ~$200 one-time for 90-min headshot + B-roll session — every authority post needs your face and we don't have enough current photos

Total: ~$2,000-2,500 one-time + $160/mo recurring.

Echoing your no-go list so you know I heard:
- No lies, no fabricated specifics, no contradictions of your prior statements
- No fake testimonials, no AI-deepfake voiceovers of other people
- Always disclose paid endorsements (FTC + your integrity)
- Adding to the list: no bot engagement, no buying followers, no comment automation that pastes identical text across groups, no private group scraping

My ask back to you: which TX RE influencers did you already DM with the referral pitch? I don't want to re-tap them with the same approach. And — while I run the deep research this week, what should you ship FIRST to keep momentum?

— Sage`;

const rows = [
  {
    chat_id: CHAT_ID,
    telegram_message_id: '6823',
    role: 'sage',
    text: row1Text,
    created_at: '2026-06-09T14:31:00Z',
  },
  {
    chat_id: CHAT_ID,
    telegram_message_id: '6831',
    role: 'user',
    text: row2Text,
    created_at: '2026-06-09T14:36:51Z',
  },
  {
    chat_id: CHAT_ID,
    telegram_message_id: '6829',
    role: 'sage',
    text: row3Text,
    created_at: '2026-06-09T14:38:30Z',
  },
];

async function main() {
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/sage_conversations`, {
    method: 'POST',
    headers: {
      'apikey': KEY,
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(rows),
  });

  const insertBody = await insertRes.text();
  console.log('INSERT status:', insertRes.status);
  console.log('INSERT body:', insertBody);
  if (!insertRes.ok) process.exit(1);

  const verifyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/sage_conversations?chat_id=eq.${CHAT_ID}&order=created_at.asc&select=id,chat_id,telegram_message_id,role,created_at,text`,
    {
      headers: {
        'apikey': KEY,
        'Authorization': `Bearer ${KEY}`,
      },
    }
  );
  const verifyBody = await verifyRes.json();
  console.log('VERIFY status:', verifyRes.status);
  console.log('VERIFY count:', Array.isArray(verifyBody) ? verifyBody.length : 'not array');
  console.log('VERIFY rows (truncated text):');
  for (const r of verifyBody) {
    console.log(`  id=${r.id} role=${r.role} msg_id=${r.telegram_message_id} created=${r.created_at} text_len=${r.text.length}`);
  }
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
