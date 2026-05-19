/**
 * Admin Cost Analytics API
 * Returns usage and cost metrics across all metered services
 * Auth: requires logged-in user with email = heath.shepard@kw.com
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Pricing constants (updated as of 2026-05-19)
const PRICING = {
  elevenlabs_per_1k_chars: 0.30,
  anthropic_sonnet_input_per_1m: 3.00,
  anthropic_sonnet_output_per_1m: 15.00,
  anthropic_haiku_input_per_1m: 0.25,
  anthropic_haiku_output_per_1m: 1.25,
  resend_per_1k_emails: 1.00,
  hcti_monthly_free: 50,
  hcti_paid_per_month: 14.00,
  creatomate_per_render: 0.05, // Estimated based on plan
};

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
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ===== OVERVIEW CARDS =====
    const { data: logsThisMonth } = await supabase
      .from('usage_logs')
      .select('service, estimated_cost')
      .gte('created_at', thisMonthStart.toISOString());

    const serviceBreakdown = {};
    let totalCost = 0;

    (logsThisMonth || []).forEach(log => {
      const service = log.service;
      serviceBreakdown[service] = (serviceBreakdown[service] || 0) + parseFloat(log.estimated_cost || 0);
      totalCost += parseFloat(log.estimated_cost || 0);
    });

    // ===== PER-SERVICE BREAKDOWN =====

    // ElevenLabs
    const { data: elevenLabsLogs } = await supabase
      .from('usage_logs')
      .select('user_id, units_consumed, estimated_cost')
      .eq('service', 'elevenlabs')
      .gte('created_at', thisMonthStart.toISOString());

    const elevenLabsTotal = {
      totalCharacters: elevenLabsLogs?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0,
      totalCost: elevenLabsLogs?.reduce((sum, l) => sum + parseFloat(l.estimated_cost || 0), 0) || 0,
      topUsers: [],
    };

    // Group by user
    const elevenLabsByUser = {};
    (elevenLabsLogs || []).forEach(log => {
      if (!log.user_id) return;
      if (!elevenLabsByUser[log.user_id]) {
        elevenLabsByUser[log.user_id] = { chars: 0, cost: 0 };
      }
      elevenLabsByUser[log.user_id].chars += log.units_consumed || 0;
      elevenLabsByUser[log.user_id].cost += parseFloat(log.estimated_cost || 0);
    });

    const elevenLabsUserArray = await Promise.all(
      Object.entries(elevenLabsByUser).map(async ([userId, data]) => {
        const { data: profile } = await supabase
          .from('profiles')
          .select('name, email')
          .eq('id', userId)
          .single();
        return {
          name: profile?.name || 'Unknown',
          email: profile?.email || 'Unknown',
          chars: data.chars,
          cost: data.cost.toFixed(2),
        };
      })
    );

    elevenLabsTotal.topUsers = elevenLabsUserArray
      .sort((a, b) => parseFloat(b.cost) - parseFloat(a.cost))
      .slice(0, 5);

    // Anthropic
    const { data: anthropicLogs } = await supabase
      .from('usage_logs')
      .select('user_id, usage_type, units_consumed, estimated_cost, metadata')
      .eq('service', 'anthropic')
      .gte('created_at', thisMonthStart.toISOString());

    const anthropicTotal = {
      totalTokens: anthropicLogs?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0,
      totalCost: anthropicLogs?.reduce((sum, l) => sum + parseFloat(l.estimated_cost || 0), 0) || 0,
      byEndpoint: { chat: 0, scan: 0 },
      topUsers: [],
    };

    // Breakdown by endpoint
    (anthropicLogs || []).forEach(log => {
      if (log.usage_type === 'chat') {
        anthropicTotal.byEndpoint.chat += parseFloat(log.estimated_cost || 0);
      } else if (log.usage_type === 'scan') {
        anthropicTotal.byEndpoint.scan += parseFloat(log.estimated_cost || 0);
      }
    });

    // Group by user
    const anthropicByUser = {};
    (anthropicLogs || []).forEach(log => {
      if (!log.user_id) return;
      if (!anthropicByUser[log.user_id]) {
        anthropicByUser[log.user_id] = { tokens: 0, cost: 0 };
      }
      anthropicByUser[log.user_id].tokens += log.units_consumed || 0;
      anthropicByUser[log.user_id].cost += parseFloat(log.estimated_cost || 0);
    });

    const anthropicUserArray = await Promise.all(
      Object.entries(anthropicByUser).map(async ([userId, data]) => {
        const { data: profile } = await supabase
          .from('profiles')
          .select('name, email')
          .eq('id', userId)
          .single();
        return {
          name: profile?.name || 'Unknown',
          email: profile?.email || 'Unknown',
          tokens: data.tokens,
          cost: data.cost.toFixed(2),
        };
      })
    );

    anthropicTotal.topUsers = anthropicUserArray
      .sort((a, b) => parseFloat(b.cost) - parseFloat(a.cost))
      .slice(0, 5);

    // Resend
    const { data: resendLogs } = await supabase
      .from('usage_logs')
      .select('user_id, units_consumed, estimated_cost')
      .eq('service', 'resend')
      .gte('created_at', thisMonthStart.toISOString());

    const resendTotal = {
      totalEmails: resendLogs?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0,
      totalCost: resendLogs?.reduce((sum, l) => sum + parseFloat(l.estimated_cost || 0), 0) || 0,
      topUsers: [],
    };

    // Group by user
    const resendByUser = {};
    (resendLogs || []).forEach(log => {
      if (!log.user_id) return;
      if (!resendByUser[log.user_id]) {
        resendByUser[log.user_id] = { emails: 0, cost: 0 };
      }
      resendByUser[log.user_id].emails += log.units_consumed || 0;
      resendByUser[log.user_id].cost += parseFloat(log.estimated_cost || 0);
    });

    const resendUserArray = await Promise.all(
      Object.entries(resendByUser).map(async ([userId, data]) => {
        const { data: profile } = await supabase
          .from('profiles')
          .select('name, email')
          .eq('id', userId)
          .single();
        return {
          name: profile?.name || 'Unknown',
          email: profile?.email || 'Unknown',
          emails: data.emails,
          cost: data.cost.toFixed(2),
        };
      })
    );

    resendTotal.topUsers = resendUserArray
      .sort((a, b) => parseFloat(b.cost) - parseFloat(a.cost))
      .slice(0, 5);

    // Creatomate
    const { data: creatomateCount } = await supabase
      .from('usage_logs')
      .select('units_consumed', { count: 'exact' })
      .eq('service', 'creatomate')
      .gte('created_at', thisMonthStart.toISOString());

    const creatomateTotal = {
      renderCount: creatomateCount?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0,
    };

    // HCTI
    const { data: hctiCount } = await supabase
      .from('usage_logs')
      .select('units_consumed', { count: 'exact' })
      .eq('service', 'hcti')
      .gte('created_at', thisMonthStart.toISOString());

    const hctiTotal = {
      renderCount: hctiCount?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0,
      exceededFree: (hctiCount?.reduce((sum, l) => sum + (l.units_consumed || 0), 0) || 0) > PRICING.hcti_monthly_free,
    };

    // ===== PER-USER TABLE =====
    const { data: allProfiles } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('is_demo', false)
      .order('name');

    const userCostBreakdown = await Promise.all(
      (allProfiles || []).map(async (profile) => {
        // Get all logs for this user this month
        const { data: userLogs } = await supabase
          .from('usage_logs')
          .select('service, usage_type, estimated_cost, created_at')
          .eq('user_id', profile.id)
          .gte('created_at', thisMonthStart.toISOString());

        const costs = {
          voice: 0,
          chat: 0,
          scan: 0,
          email: 0,
          total: 0,
        };

        (userLogs || []).forEach(log => {
          const cost = parseFloat(log.estimated_cost || 0);
          costs.total += cost;

          if (log.service === 'elevenlabs') costs.voice += cost;
          if (log.service === 'anthropic' && log.usage_type === 'chat') costs.chat += cost;
          if (log.service === 'anthropic' && log.usage_type === 'scan') costs.scan += cost;
          if (log.service === 'resend') costs.email += cost;
        });

        // Get last activity
        const lastActivity = userLogs && userLogs.length > 0
          ? new Date(Math.max(...userLogs.map(l => new Date(l.created_at).getTime())))
          : null;

        return {
          name: profile.name || 'Unknown',
          email: profile.email,
          voice: costs.voice.toFixed(2),
          chat: costs.chat.toFixed(2),
          scan: costs.scan.toFixed(2),
          email: costs.email.toFixed(2),
          total: costs.total.toFixed(2),
          lastActivity: lastActivity ? lastActivity.toISOString() : null,
        };
      })
    );

    // Sort by total cost descending
    userCostBreakdown.sort((a, b) => parseFloat(b.total) - parseFloat(a.total));

    // ===== ALERTS =====
    const alerts = {
      usersOver10: userCostBreakdown.filter(u => parseFloat(u.total) > 10),
      hctiApproachingLimit: hctiTotal.renderCount > 40, // 80% of free tier
      hctiExceededLimit: hctiTotal.exceededFree,
    };

    // ===== TOP 5 COSTLIEST USERS =====
    const topCostliestUsers = userCostBreakdown.slice(0, 5);

    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      overview: {
        totalCost: totalCost.toFixed(2),
        serviceBreakdown: Object.fromEntries(
          Object.entries(serviceBreakdown).map(([k, v]) => [k, v.toFixed(2)])
        ),
        topCostliestUsers,
      },
      services: {
        elevenLabs: {
          totalCharacters: elevenLabsTotal.totalCharacters,
          totalCost: elevenLabsTotal.totalCost.toFixed(2),
          topUsers: elevenLabsTotal.topUsers,
        },
        anthropic: {
          totalTokens: anthropicTotal.totalTokens,
          totalCost: anthropicTotal.totalCost.toFixed(2),
          byEndpoint: {
            chat: anthropicTotal.byEndpoint.chat.toFixed(2),
            scan: anthropicTotal.byEndpoint.scan.toFixed(2),
          },
          topUsers: anthropicTotal.topUsers,
        },
        resend: {
          totalEmails: resendTotal.totalEmails,
          totalCost: resendTotal.totalCost.toFixed(2),
          topUsers: resendTotal.topUsers,
        },
        creatomate: {
          renderCount: creatomateTotal.renderCount,
        },
        hcti: {
          renderCount: hctiTotal.renderCount,
          exceededFree: hctiTotal.exceededFree,
        },
      },
      userCostBreakdown,
      alerts,
    });

  } catch (error) {
    console.error('Cost analytics error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
