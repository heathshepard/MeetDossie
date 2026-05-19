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

    // ===== EXPENSES & TECH STACK =====
    // Calculate Stripe fees from active subscriptions (2.9% + $0.30 per transaction)
    const stripeMonthlyFees = subscriptions?.length
      ? subscriptions.length * ((subscriptions.reduce((sum, s) => {
          const amount = s.plan === 'founding' ? 29 : s.plan === 'solo' ? 79 : 199;
          return sum + (amount * 0.029 + 0.30);
        }, 0)))
      : 0;

    const expenses = {
      // Hardcoded monthly costs (Heath can update these as needed)
      anthropic: 150, // Estimated from token usage
      elevenLabs: 22, // Voice synthesis
      supabase: 25, // Database + Storage
      vercel: 20, // Hosting
      stripe: Math.round(stripeMonthlyFees * 100) / 100,
      zernio: 12,
      hcti: 0, // Free plan, note upgrade at 1000 renders
      creatomate: 49, // Video assembly
      pexels: 0, // Free API
      resend: 0, // Free tier
    };

    const totalExpenses = Object.values(expenses).reduce((sum, val) => sum + val, 0);
    const netProfit = mrr - totalExpenses;
    const profitMargin = mrr > 0 ? ((netProfit / mrr) * 100).toFixed(1) : 0;

    metrics.expenses = {
      breakdown: expenses,
      total: Math.round(totalExpenses * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      profitMargin: `${profitMargin}%`,
    };

    // ===== FEATURE USAGE BY MEMBER =====
    // Get all non-demo customers with their activity
    const { data: customerProfiles } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('is_demo', false)
      .order('name');

    const customerUsage = [];

    for (const profile of customerProfiles || []) {
      // Get subscription plan
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('plan')
        .eq('user_id', profile.id)
        .eq('status', 'active')
        .single();

      // Count documents
      const { count: docsCount } = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id);

      // Count completed action items
      const { count: actionsCount } = await supabase
        .from('action_items')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .eq('status', 'completed');

      // Count drafted emails
      const { count: emailsCount } = await supabase
        .from('email_queue')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id);

      // Count transactions
      const { count: transactionsCount } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id);

      // Count milestones
      const { count: milestonesCount } = await supabase
        .from('dossier_milestones')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id);

      // Count share events
      const { count: sharesCount } = await supabase
        .from('share_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id);

      // Get last login from auth.users
      const { data: authUser } = await supabase
        .from('auth.users')
        .select('last_sign_in_at')
        .eq('id', profile.id)
        .single();

      customerUsage.push({
        name: profile.name || 'Unknown',
        email: profile.email,
        plan: sub?.plan || 'none',
        documents: docsCount || 0,
        actionsCompleted: actionsCount || 0,
        emails: emailsCount || 0,
        transactions: transactionsCount || 0,
        milestones: milestonesCount || 0,
        shares: sharesCount || 0,
        lastLogin: authUser?.last_sign_in_at || null,
        totalActivity: (docsCount || 0) + (actionsCount || 0) + (emailsCount || 0) + (transactionsCount || 0),
      });
    }

    // Sort by total activity descending
    customerUsage.sort((a, b) => b.totalActivity - a.totalActivity);

    metrics.customerUsage = customerUsage;

    // ===== FEATURE ADOPTION =====
    const totalCustomers = customerProfiles?.length || 1; // Avoid divide by zero

    // Users who've uploaded documents
    const { data: docsUsers } = await supabase
      .from('documents')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueDocsUsers = new Set(docsUsers?.map(d => d.user_id)).size;

    // Users who've created action items
    const { data: actionsUsers } = await supabase
      .from('action_items')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueActionsUsers = new Set(actionsUsers?.map(d => d.user_id)).size;

    // Users who've drafted emails
    const { data: emailsUsers } = await supabase
      .from('email_queue')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueEmailsUsers = new Set(emailsUsers?.map(d => d.user_id)).size;

    // Users who've created transactions
    const { data: transactionsUsers } = await supabase
      .from('transactions')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueTransactionsUsers = new Set(transactionsUsers?.map(d => d.user_id)).size;

    // Users who've created milestones
    const { data: milestonesUsers } = await supabase
      .from('dossier_milestones')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueMilestonesUsers = new Set(milestonesUsers?.map(d => d.user_id)).size;

    // Users who've used share button
    const { data: sharesUsers } = await supabase
      .from('share_events')
      .select('user_id')
      .not('user_id', 'is', null);
    const uniqueSharesUsers = new Set(sharesUsers?.map(d => d.user_id)).size;

    const { count: totalDocs } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true });

    const { count: totalActions } = await supabase
      .from('action_items')
      .select('id', { count: 'exact', head: true });

    const { count: totalEmails } = await supabase
      .from('email_queue')
      .select('id', { count: 'exact', head: true });

    const { count: totalTransactions } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true });

    const { count: totalMilestones } = await supabase
      .from('dossier_milestones')
      .select('id', { count: 'exact', head: true });

    const { count: totalShares } = await supabase
      .from('share_events')
      .select('id', { count: 'exact', head: true });

    metrics.featureAdoption = {
      documents: {
        users: uniqueDocsUsers,
        total: totalDocs || 0,
        adoptionRate: ((uniqueDocsUsers / totalCustomers) * 100).toFixed(1),
      },
      actionItems: {
        users: uniqueActionsUsers,
        total: totalActions || 0,
        adoptionRate: ((uniqueActionsUsers / totalCustomers) * 100).toFixed(1),
      },
      emails: {
        users: uniqueEmailsUsers,
        total: totalEmails || 0,
        adoptionRate: ((uniqueEmailsUsers / totalCustomers) * 100).toFixed(1),
      },
      transactions: {
        users: uniqueTransactionsUsers,
        total: totalTransactions || 0,
        adoptionRate: ((uniqueTransactionsUsers / totalCustomers) * 100).toFixed(1),
      },
      milestones: {
        users: uniqueMilestonesUsers,
        total: totalMilestones || 0,
        adoptionRate: ((uniqueMilestonesUsers / totalCustomers) * 100).toFixed(1),
      },
      shares: {
        users: uniqueSharesUsers,
        total: totalShares || 0,
        adoptionRate: ((uniqueSharesUsers / totalCustomers) * 100).toFixed(1),
      },
    };

    // ===== ENHANCED CUSTOMER DETAIL =====
    // Build enhanced subscriptions list
    const { data: allSubscriptions } = await supabase
      .from('subscriptions')
      .select('user_id, plan, status, created_at')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    const customerDetails = [];

    for (const sub of allSubscriptions || []) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('name, email')
        .eq('id', sub.user_id)
        .single();

      const { data: authUser } = await supabase
        .from('auth.users')
        .select('last_sign_in_at')
        .eq('id', sub.user_id)
        .single();

      const { count: userTransactions } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', sub.user_id);

      const lastLogin = authUser?.last_sign_in_at ? new Date(authUser.last_sign_in_at) : null;
      const now = new Date();
      let activityLevel = 'inactive';

      if (lastLogin) {
        const daysSinceLogin = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));
        if (daysSinceLogin === 0) activityLevel = 'daily';
        else if (daysSinceLogin <= 7) activityLevel = 'weekly';
        else if (daysSinceLogin <= 30) activityLevel = 'monthly';
        else activityLevel = 'inactive';
      }

      const signupDate = new Date(sub.created_at);
      const daysSinceSignup = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));

      customerDetails.push({
        name: profile?.name || 'Unknown',
        email: profile?.email || 'Unknown',
        plan: sub.plan,
        lastLogin: lastLogin ? lastLogin.toISOString() : null,
        activityLevel,
        daysSinceSignup,
        transactions: userTransactions || 0,
      });
    }

    metrics.customerDetails = customerDetails;

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
