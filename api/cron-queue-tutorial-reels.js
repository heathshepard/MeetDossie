// Vercel Serverless Function: /api/cron-queue-tutorial-reels
// Queues published tutorial videos as social posts for Sage review.
// Reads tutorial_videos.distribution array, creates draft social_posts
// for each target platform, and caps output to max 2 per platform per week.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 6 * * * (6 AM CDT / 11 AM UTC daily)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const CAPTION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_PER_PLATFORM_PER_WEEK = 2;

// Platform distribution names from tutorial_videos.distribution array
// Maps to social_posts.platform. YouTube and unknown types are skipped.
const PLATFORM_MAPPING = {
  'instagram-reels': 'instagram',
  'tiktok': 'tiktok',
  'youtube-short': null, // YouTube not yet in Dossie social posting
  'facebook-reels': 'facebook',
};

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

// Generate platform-specific caption for tutorial video
async function generateCaption(bite) {
  const { title, description, target_audience } = bite;
  if (!ANTHROPIC_API_KEY) {
    console.warn('[cron-queue-tutorial-reels] ANTHROPIC_API_KEY missing, skipping caption generation');
    return null;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CAPTION_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Write a short, punchy social media caption for a tutorial video about Dossie (a real estate AI assistant for Texas agents).

Video: "${title}"
Description: "${description}"
Audience: ${target_audience}

Requirements:
- Hook first (max 8 words)
- Real scenario or pain point
- Mention ONE Dossie capability
- 5-10 hashtags for Instagram/TikTok, 2-3 for Facebook, none for YouTube
- No URLs or CTAs
- Third person (if needed)
- Max 280 characters (post body only, not hashtags)

Return plain text caption, hashtags on same line separated by spaces.`,
          },
        ],
      }),
    });

    const json = await res.json();
    if (!res.ok || !Array.isArray(json.content) || json.content.length === 0) {
      console.warn('[cron-queue-tutorial-reels] Claude API error:', json);
      return null;
    }

    // Sonnet 5 extended thinking may prepend a `thinking` block. Concat all text blocks.
    const caption = (json.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!caption) {
      console.warn('[cron-queue-tutorial-reels] Claude API returned no text block:', json);
      return null;
    }
    return caption;
  } catch (err) {
    console.warn('[cron-queue-tutorial-reels] generateCaption failed:', err && err.message);
    return null;
  }
}

// Count existing repurposed posts for a platform in the last 7 days
async function countRecentRepurposes(platform) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data, ok } = await supabaseFetch(
    `/rest/v1/social_posts?select=id&platform=eq.${platform}&source_type=eq.tutorial_repurpose&created_at=gte.${sevenDaysAgo.toISOString()}&limit=1&count=exact`,
  );

  if (!ok) {
    console.warn(`[cron-queue-tutorial-reels] Failed to count recent repurposes for ${platform}`);
    return 0;
  }

  return data && Array.isArray(data) ? data.length : 0;
}

// Check if a post already exists for this tutorial + platform combo
async function postExists(tutorialVideoId, platform) {
  const { data, ok } = await supabaseFetch(
    `/rest/v1/social_posts?select=id&tutorial_video_id=eq.${tutorialVideoId}&platform=eq.${platform}&limit=1`,
  );

  if (!ok) {
    console.warn(`[cron-queue-tutorial-reels] Failed to check if post exists for ${tutorialVideoId} on ${platform}`);
    return false;
  }

  return data && Array.isArray(data) && data.length > 0;
}

// Find next available posting slot for a platform
async function getNextScheduleSlot(platform) {
  // Query posting_schedule for this platform, find a slot with room
  const { data: schedules, ok } = await supabaseFetch(`/rest/v1/posting_schedule?select=*&platform=eq.${platform}`);

  if (!ok || !schedules || schedules.length === 0) {
    console.warn(`[cron-queue-tutorial-reels] No posting schedule found for ${platform}`);
    return null;
  }

  // Simple strategy: pick first slot 24 hours from now
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0); // 9 AM CST

  return tomorrow.toISOString();
}

// Insert a new social post for a tutorial video
async function createPost(tutorialVideoId, platform, caption, bite) {
  const scheduledFor = await getNextScheduleSlot(platform);
  if (!scheduledFor) {
    console.warn(`[cron-queue-tutorial-reels] Could not find schedule slot for ${platform}`);
    return false;
  }

  // Parse caption into body and hashtags (simple split on #)
  const parts = caption.split('\n');
  const body = parts[0] || caption;
  const hashtags = caption.match(/#\w+/g) || [];

  const payload = {
    platform,
    media_url: bite.video_url,
    content: body,
    hashtags: hashtags.map((h) => h.replace(/^#/, '')),
    persona: 'dossie',
    status: 'draft',
    scheduled_for: scheduledFor,
    source_type: 'tutorial_repurpose',
    tutorial_video_id: tutorialVideoId,
    requires_approval: true,
  };

  const { ok, data, status } = await supabaseFetch('/rest/v1/social_posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!ok) {
    console.warn(`[cron-queue-tutorial-reels] Failed to insert post for tutorial ${tutorialVideoId}:`, status, data);
    return false;
  }

  console.log(`[cron-queue-tutorial-reels] ✅ Created ${platform} post for ${bite.slug}`);
  return true;
}

module.exports = withTelemetry('cron-queue-tutorial-reels', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const token = authHeader.split(' ')[1];
  const isAuthorized = isVercelCron || token === CRON_SECRET;

  if (!isAuthorized) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Fetch all published tutorial videos
    const { data: tutorials, ok: tutOk } = await supabaseFetch(
      '/rest/v1/tutorial_videos?select=*&status=eq.published',
    );

    if (!tutOk || !tutorials) {
      res.status(500).json({ error: 'Failed to fetch tutorials' });
      return;
    }

    let created = 0;
    let skipped = 0;

    for (const bite of tutorials) {
      const distribution = Array.isArray(bite.distribution) ? bite.distribution : [];

      for (const distKey of distribution) {
        const platform = PLATFORM_MAPPING[distKey];
        if (!platform) continue; // Skip unknown distribution types

        // Check cap: max 2 repurposes per platform per week
        const recentCount = await countRecentRepurposes(platform);
        if (recentCount >= MAX_PER_PLATFORM_PER_WEEK) {
          console.log(
            `[cron-queue-tutorial-reels] Skipping ${platform} for ${bite.slug}: already at cap (${recentCount}/${MAX_PER_PLATFORM_PER_WEEK})`,
          );
          skipped++;
          continue;
        }

        // Check for existing post
        if (await postExists(bite.id, platform)) {
          console.log(`[cron-queue-tutorial-reels] Skipping ${platform} for ${bite.slug}: post exists`);
          skipped++;
          continue;
        }

        // Generate caption
        const caption = await generateCaption(bite);
        if (!caption) {
          console.warn(`[cron-queue-tutorial-reels] Failed to generate caption for ${bite.slug}`);
          skipped++;
          continue;
        }

        // Create post
        const success = await createPost(bite.id, platform, caption, bite);
        if (success) created++;
        else skipped++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Queued ${created} tutorial repurposes (${skipped} skipped)`,
      created,
      skipped,
    });
  } catch (err) {
    console.error('[cron-queue-tutorial-reels] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err && err.message });
  }
});
