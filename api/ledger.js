/**
 * Ledger API
 * GET /api/ledger — fetch entries, summary, runway calc
 * POST /api/ledger — log new expense (manual entry)
 * Auth: Heath only
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user || user.email !== 'heath.shepard@kw.com') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    if (req.method === 'GET') {
      const { month, entity = 'shepard_ventures' } = req.query;

      let query = supabase
        .from('ledger_entries')
        .select('*');

      if (month) {
        const [year, monthNum] = month.split('-');
        const start = `${year}-${monthNum}-01`;
        const end = new Date(parseInt(year), parseInt(monthNum), 0).toISOString().split('T')[0];
        query = query.gte('date', start).lte('date', end);
      }

      if (entity) {
        query = query.eq('entity', entity);
      }

      const { data: entries, error: selectError } = await query.order('date', { ascending: false });

      if (selectError) throw selectError;

      // Calculate monthly summary
      const monthlyData = {};
      let totalIncome = 0;
      let totalExpenses = 0;

      entries?.forEach(entry => {
        const yearMonth = entry.date.substring(0, 7); // YYYY-MM
        if (!monthlyData[yearMonth]) {
          monthlyData[yearMonth] = { income: 0, expenses: 0 };
        }

        if (entry.type === 'income') {
          monthlyData[yearMonth].income += parseFloat(entry.amount);
          totalIncome += parseFloat(entry.amount);
        } else if (entry.type === 'expense') {
          monthlyData[yearMonth].expenses += Math.abs(parseFloat(entry.amount));
          totalExpenses += Math.abs(parseFloat(entry.amount));
        }
      });

      // Category breakdown (expenses only)
      const categoryBreakdown = {};
      entries?.forEach(entry => {
        if (entry.type === 'expense') {
          const cat = entry.category || 'Other';
          categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + Math.abs(parseFloat(entry.amount));
        }
      });

      // Runway calc: assume current MRR continues, estimate months until $0
      // Get current MRR from subscriptions
      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('plan, status')
        .eq('status', 'active');

      const founding = subscriptions?.filter(s => s.plan === 'founding').length || 0;
      const solo = subscriptions?.filter(s => s.plan === 'solo').length || 0;
      const team = subscriptions?.filter(s => s.plan === 'team').length || 0;
      const mrr = (founding * 29) + (solo * 79) + (team * 199);

      // Get current monthly expenses
      const thisMonthStart = new Date();
      thisMonthStart.setDate(1);
      const thisMonthEnd = new Date();
      const thisMonth = thisMonthStart.toISOString().split('T')[0].substring(0, 7);
      const currentMonthExpenses = monthlyData[thisMonth]?.expenses || 0;

      const monthlyNet = mrr - currentMonthExpenses;
      const runwayCash = 5000; // assume ~$5k in bank (placeholder, should come from Mercury API)
      const runway = monthlyNet > 0 ? (runwayCash / monthlyNet).toFixed(1) : 'infinite';

      // Get recurring subscriptions
      const { data: recurring } = await supabase
        .from('recurring_subscriptions')
        .select('*')
        .eq('status', 'active')
        .eq('entity', entity);

      return res.status(200).json({
        entries: entries || [],
        summary: {
          totalIncome: totalIncome.toFixed(2),
          totalExpenses: totalExpenses.toFixed(2),
          netProfit: (totalIncome - totalExpenses).toFixed(2),
          monthlyData,
          categoryBreakdown,
          currentMRR: mrr,
          currentMonthExpenses: currentMonthExpenses.toFixed(2),
          monthlyNetProfit: monthlyNet.toFixed(2),
          runwayMonths: runway,
        },
        recurringSubscriptions: recurring || [],
      });
    }

    if (req.method === 'POST') {
      const { date, type, amount, category, vendor, description, entity, source, notes, evidence_url } = req.body;

      if (!date || !type || !amount || !category) {
        return res.status(400).json({ error: 'Missing required fields: date, type, amount, category' });
      }

      const { data: entry, error: insertError } = await supabase
        .from('ledger_entries')
        .insert({
          date,
          type,
          amount: type === 'expense' ? Math.abs(amount) * -1 : Math.abs(amount),
          category,
          vendor: vendor || null,
          description: description || null,
          entity: entity || 'shepard_ventures',
          source: source || 'manual',
          notes: notes || null,
          evidence_url: evidence_url || null,
          created_by: user.id,
        })
        .select();

      if (insertError) throw insertError;

      return res.status(201).json({ success: true, entry: entry?.[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Ledger error:', error);
    return res.status(500).json({ error: error.message });
  }
}
