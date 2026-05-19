/**
 * Admin Dashboard API
 * Returns analytics metrics for the Dossie admin dashboard
 * Auth: requires logged-in user with email = heath.shepard@kw.com
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check - require logged-in user via session token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Verify token and get user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized - invalid token' });
  }

  // Check if user email is heath.shepard@kw.com
  if (user.email !== 'heath.shepard@kw.com') {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }

  try {
    const metrics = {};

    // ===== REVENUE & GROWTH =====
    const { data: subscriptions } = await supabase
      .from('subscriptions')
      .select('plan, status')
      .eq('status', 'active');

    const founding = subscriptions?.filter(s => s.plan === 'founding').length || 0;
    const solo = subscriptions?.filter(s => s.plan === 'solo').length || 0;
    const team = subscriptions?.filter(s => s.plan === 'team').length || 0;

    const mrr = (founding * 29) + (solo * 79) + (team * 199);

    metrics.revenue = {
      mrr,
      foundingCount: founding,
      foundingRemaining: 50 - founding,
      soloCount: solo,
      teamCount: team,
      totalActive: subscriptions?.length || 0,
    };

    // Cancellations this month
    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);

    const { count: cancellationsThisMonth } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'canceled')
      .gte('updated_at', thisMonthStart.toISOString());

    metrics.revenue.cancellationsThisMonth = cancellationsThisMonth || 0;

    // ===== USER ACTIVITY =====
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_demo', false);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Query auth.users directly for performance (replaces slow listUsers() call)
    let active7d = 0;
    let active30d = 0;
    let neverLoggedIn = 0;

    try {
      // Count users active in last 7 days (exclude demo accounts)
      const { count: count7d, error: error7d } = await supabase
        .from('auth.users')
        .select('id', { count: 'exact', head: true })
        .not('email', 'like', '%demo%')
        .not('last_sign_in_at', 'is', null)
        .gte('last_sign_in_at', sevenDaysAgo.toISOString());

      if (error7d) throw error7d;
      active7d = count7d || 0;

      // Count users active in last 30 days (exclude demo accounts)
      const { count: count30d, error: error30d } = await supabase
        .from('auth.users')
        .select('id', { count: 'exact', head: true })
        .not('email', 'like', '%demo%')
        .not('last_sign_in_at', 'is', null)
        .gte('last_sign_in_at', thirtyDaysAgo.toISOString());

      if (error30d) throw error30d;
      active30d = count30d || 0;

      // Count users who never logged in (exclude demo accounts)
      const { count: countNever, error: errorNever } = await supabase
        .from('auth.users')
        .select('id', { count: 'exact', head: true })
        .not('email', 'like', '%demo%')
        .is('last_sign_in_at', null);

      if (errorNever) throw errorNever;
      neverLoggedIn = countNever || 0;

    } catch (authQueryError) {
      console.error('Auth query error:', authQueryError);
      // Return zeros on error - dashboard will still load with other metrics
      active7d = 0;
      active30d = 0;
      neverLoggedIn = 0;
    }

    metrics.users = {
      total: totalUsers || 0,
      active7d,
      active30d,
      neverLoggedIn,
    };

    // ===== PRODUCT USAGE =====
    const { count: totalDossiers } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true });

    const { count: activeDossiers } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: closedDossiers } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'closed');

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { count: contractsThisWeek } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'contract')
      .gte('created_at', weekAgo.toISOString());

    const { count: docsThisWeek } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString());

    const { count: emailsThisWeek } = await supabase
      .from('email_queue')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString());

    // Morning Brief and Talk to Dossie sessions - these aren't tracked yet, show 0
    const morningBriefPlays = 0;
    const talkSessions = 0;

    metrics.usage = {
      totalDossiers: totalDossiers || 0,
      activeDossiers: activeDossiers || 0,
      closedDossiers: closedDossiers || 0,
      contractsThisWeek: contractsThisWeek || 0,
      morningBriefPlays,
      talkSessions,
      emailsThisWeek: emailsThisWeek || 0,
      docsThisWeek: docsThisWeek || 0,
    };

    // ===== PIPELINE HEALTH =====
    const { data: dealsByStage } = await supabase
      .from('transactions')
      .select('stage');

    const stageGroups = {};
    dealsByStage?.forEach(d => {
      const stage = d.stage || 'unknown';
      stageGroups[stage] = (stageGroups[stage] || 0) + 1;
    });

    const activeUserCount = metrics.users.active30d || 1; // avoid divide by zero
    const avgDealsPerUser = totalDossiers ? (totalDossiers / activeUserCount).toFixed(1) : '0';

    const { count: milestoneCards } = await supabase
      .from('dossier_milestones')
      .select('id', { count: 'exact', head: true });

    metrics.pipeline = {
      dealsByStage: stageGroups,
      avgDealsPerUser,
      milestoneCards: milestoneCards || 0,
    };

    // ===== SOCIAL PIPELINE =====
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: postsGeneratedToday } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', today.toISOString());

    const { count: postsGeneratedThisWeek } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString());

    const { count: postsPublishedToday } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'posted')
      .gte('updated_at', today.toISOString());

    const { count: postsPublishedThisWeek } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'posted')
      .gte('updated_at', weekAgo.toISOString());

    const { count: postsFailedToday } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('updated_at', today.toISOString());

    const { count: postsFailedThisWeek } = await supabase
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('updated_at', weekAgo.toISOString());

    const totalAttempts = postsPublishedThisWeek + postsFailedThisWeek;
    const successRate = totalAttempts > 0
      ? ((postsPublishedThisWeek / totalAttempts) * 100).toFixed(1)
      : '100';

    const { data: platformBreakdown } = await supabase
      .from('social_posts')
      .select('platforms')
      .eq('status', 'posted')
      .gte('updated_at', weekAgo.toISOString());

    const platformCounts = {};
    platformBreakdown?.forEach(p => {
      const platforms = p.platforms || [];
      platforms.forEach(plat => {
        platformCounts[plat] = (platformCounts[plat] || 0) + 1;
      });
    });

    metrics.social = {
      generatedToday: postsGeneratedToday || 0,
      generatedThisWeek: postsGeneratedThisWeek || 0,
      publishedToday: postsPublishedToday || 0,
      publishedThisWeek: postsPublishedThisWeek || 0,
      failedToday: postsFailedToday || 0,
      failedThisWeek: postsFailedThisWeek || 0,
      successRate: `${successRate}%`,
      platformCounts,
    };

    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      metrics,
    });

  } catch (error) {
    console.error('Admin dashboard error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
