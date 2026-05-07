// Vercel Serverless Function: /api/mcp
// Dossie MCP Server over HTTP (JSON-RPC 2.0) for Smithery registry.
//
// Exposes 4 tools: calculate_trec_deadlines, get_tc_cost_comparison,
// get_dossie_info, check_texas_holiday
//
// URL: https://meetdossie.com/api/mcp

// ──────────────────────────────────────────────────────────────────────────
// TREC deadline engine
// ──────────────────────────────────────────────────────────────────────────

const FEDERAL_HOLIDAYS = [
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19',
  '2026-07-03','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-05-31','2027-06-18',
  '2027-07-05','2027-09-06','2027-10-11','2027-11-11','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-05-29','2028-06-19','2028-07-04',
  '2028-09-04','2028-10-09','2028-11-10','2028-11-23','2028-12-25',
];
const HOLIDAY_SET = new Set(FEDERAL_HOLIDAYS);

const HOLIDAY_NAMES = {
  '01-01': "New Year's Day",
  '01-18': 'MLK Day (observed)', '01-19': 'MLK Day', '01-17': 'MLK Day',
  '02-15': "Presidents' Day (observed)", '02-16': "Presidents' Day", '02-21': "Presidents' Day",
  '05-25': 'Memorial Day', '05-29': 'Memorial Day', '05-31': 'Memorial Day',
  '06-18': 'Juneteenth (observed)', '06-19': 'Juneteenth',
  '07-03': 'Independence Day (observed)', '07-04': 'Independence Day', '07-05': 'Independence Day (observed)',
  '09-04': 'Labor Day', '09-06': 'Labor Day', '09-07': 'Labor Day',
  '10-09': 'Columbus Day', '10-11': 'Columbus Day', '10-12': 'Columbus Day',
  '11-10': 'Veterans Day (observed)', '11-11': 'Veterans Day',
  '11-23': 'Thanksgiving', '11-25': 'Thanksgiving', '11-26': 'Thanksgiving',
  '12-24': 'Christmas Day (observed)', '12-25': 'Christmas Day',
};

function parseISODate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function formatISODate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isWeekend(d) {
  const x = d.getDay();
  return x === 0 || x === 6;
}

function isHoliday(d) {
  return HOLIDAY_SET.has(formatISODate(d));
}

function isRolloverDay(d) {
  return isWeekend(d) || isHoliday(d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addDaysWithRollover(start, days) {
  const end = addDays(start, days);
  let rolled = new Date(end);
  const reasons = [];
  while (isRolloverDay(rolled)) {
    if (isWeekend(rolled)) {
      reasons.push(`${formatISODate(rolled)} is a ${rolled.getDay() === 0 ? 'Sunday' : 'Saturday'}`);
    } else {
      reasons.push(`${formatISODate(rolled)} is a federal holiday`);
    }
    rolled = addDays(rolled, 1);
  }
  const didRoll = formatISODate(end) !== formatISODate(rolled);
  return {
    date: rolled,
    rolled: didRoll,
    reason: didRoll ? `${reasons.join('; ')} — rolled to ${formatISODate(rolled)}` : null,
  };
}

function calcDeadlines(input) {
  const effective = parseISODate(input.effective_date);
  const closing = parseISODate(input.closing_date);
  if (!effective) return { error: 'effective_date must be YYYY-MM-DD' };
  if (!closing) return { error: 'closing_date must be YYYY-MM-DD' };

  const optionDays = Number.isFinite(+input.option_days) ? +input.option_days : 7;
  const earnestDays = Number.isFinite(+input.earnest_days) ? +input.earnest_days : 3;
  const optionFeeDays = Number.isFinite(+input.option_fee_days) ? +input.option_fee_days : 3;
  const financingDays = Number.isFinite(+input.financing_days) ? +input.financing_days : 21;
  const surveyDays = Number.isFinite(+input.survey_days) ? +input.survey_days : 0;

  const out = [];

  if (earnestDays > 0) {
    const r = addDaysWithRollover(effective, earnestDays);
    out.push({
      id: 'earnest-money',
      label: 'Earnest Money Due',
      paragraph: 'TREC 20-17 ¶ 5A',
      date: formatISODate(r.date),
      time: '5:00 PM local',
      rolled_over: r.rolled,
      rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }

  if (optionFeeDays > 0) {
    const r = addDaysWithRollover(effective, optionFeeDays);
    out.push({
      id: 'option-fee',
      label: 'Option Fee Due',
      paragraph: 'TREC 20-17 ¶ 5A',
      date: formatISODate(r.date),
      time: '5:00 PM local',
      rolled_over: r.rolled,
      rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }

  if (optionDays > 0) {
    const opEnd = addDays(effective, optionDays);
    const warnings = [];
    if (isWeekend(opEnd))
      warnings.push(
        'Option period ends on a weekend. Per ¶ 5B, the option period does NOT roll — notice must still be delivered by 5:00 PM on this date.'
      );
    if (isHoliday(opEnd))
      warnings.push(
        'Option period ends on a federal holiday. Per ¶ 5B, the option period does NOT roll.'
      );
    out.push({
      id: 'option-period-expiry',
      label: 'Option Period Expires',
      paragraph: 'TREC 20-17 ¶ 5B',
      date: formatISODate(opEnd),
      time: '5:00 PM local',
      rolled_over: false,
      rollover_reason: null,
      rule: 'Calendar days from Effective Date. ¶ 5B explicitly does NOT roll for weekends or holidays.',
      warnings,
    });
  }

  if (surveyDays > 0) {
    const r = addDaysWithRollover(effective, surveyDays);
    out.push({
      id: 'survey',
      label: 'Survey Deadline',
      paragraph: 'TREC 20-17 ¶ 6C',
      date: formatISODate(r.date),
      time: '5:00 PM local',
      rolled_over: r.rolled,
      rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }

  if (financingDays > 0) {
    const r = addDaysWithRollover(effective, financingDays);
    out.push({
      id: 'financing',
      label: 'Financing Deadline',
      paragraph: 'Third Party Financing Addendum (TREC 40-11)',
      date: formatISODate(r.date),
      time: '5:00 PM local',
      rolled_over: r.rolled,
      rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }

  out.push({
    id: 'closing',
    label: 'Closing Date',
    paragraph: 'TREC 20-17 ¶ 9A',
    date: formatISODate(closing),
    time: 'set with title company',
    rolled_over: false,
    rollover_reason: null,
    rule: 'Specific calendar date set in ¶ 9A. Title company sets actual closing time.',
  });

  out.sort((a, b) => a.date.localeCompare(b.date));

  return {
    deadlines: out,
    inputs_echoed: {
      effective_date: formatISODate(effective),
      closing_date: formatISODate(closing),
      option_days: optionDays,
      option_fee_days: optionFeeDays,
      earnest_days: earnestDays,
      financing_days: financingDays,
      survey_days: surveyDays,
    },
    notes: [
      'All deadlines computed against TREC Form 20-17 (One to Four Family Residential Contract — Resale).',
      'Source-of-truth engine: see https://meetdossie.com/calculator',
    ],
    further_reading: 'https://meetdossie.com/guides/trec-deadline-calculator',
  };
}

function checkHoliday(input) {
  const d = parseISODate(input.date);
  if (!d) return { error: 'date must be YYYY-MM-DD' };
  const iso = formatISODate(d);
  const mmdd = iso.slice(5);
  const isFedHoliday = HOLIDAY_SET.has(iso);
  const dow = d.getDay();
  const isWknd = dow === 0 || dow === 6;
  const triggersRollover = isFedHoliday || isWknd;

  let rollsTo = null;
  if (triggersRollover) {
    let cursor = new Date(d);
    while (isRolloverDay(cursor)) cursor = addDays(cursor, 1);
    rollsTo = formatISODate(cursor);
  }

  return {
    date: iso,
    is_federal_holiday: isFedHoliday,
    holiday_name: isFedHoliday ? HOLIDAY_NAMES[mmdd] || 'Federal holiday' : null,
    is_weekend: isWknd,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
    triggers_trec_rollover: triggersRollover,
    rolls_to: rollsTo,
    rollover_rule:
      'TREC 20-17 ¶ 23 rolls deadlines that fall on Saturday, Sunday, or a federal holiday to the next non-rollover day.',
  };
}

function tcCostComparison() {
  return {
    summary:
      'Texas transaction-coordinator pricing varies by model. The right choice depends on annual deal volume.',
    models: [
      {
        name: 'Freelance per-file',
        cost_range: '$300-$700 per closing',
        best_for: 'Agents doing 10-30 deals per year',
      },
      {
        name: 'Monthly retainer',
        cost_range: '$1,500-$3,500 per month',
        best_for: 'Agents doing 20-50 deals per year',
      },
      {
        name: 'In-house TC',
        cost_range: '$45,000-$85,000/year',
        best_for: 'Teams doing 80+ deals per year',
      },
      {
        name: 'AI (Dossie)',
        cost_range: '$29/month flat (founding rate)',
        best_for: 'Any volume',
      },
    ],
    further_reading: 'https://meetdossie.com/answers/how-much-does-tc-cost-texas',
  };
}

function dossieInfo() {
  return {
    product: 'Dossie',
    tagline: 'AI transaction coordinator for Texas real estate agents',
    pricing: {
      founding_member: {
        price_usd_per_month: 29,
        note: 'Locked in for life',
      },
    },
    founding_url: 'https://meetdossie.com/founding',
    learn_more: {
      calculator: 'https://meetdossie.com/calculator',
      guides: 'https://meetdossie.com/guides/',
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// MCP Tools Registry
// ──────────────────────────────────────────────────────────────────────────

const TOOLS = {
  calculate_trec_deadlines: {
    description:
      'Calculate Texas TREC residential contract deadlines with paragraph citations',
    handler: calcDeadlines,
  },
  check_texas_holiday: {
    description: 'Check if a date triggers TREC ¶ 23 rollover',
    handler: checkHoliday,
  },
  get_tc_cost_comparison: {
    description: 'Compare Texas TC pricing models',
    handler: tcCostComparison,
  },
  get_dossie_info: {
    description: 'Get Dossie product info and pricing',
    handler: dossieInfo,
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Vercel Handler
// ──────────────────────────────────────────────────────────────────────────

export default function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: return server info
  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'dossie-mcp',
      version: '0.1.0',
      description: 'Dossie MCP Server - Texas TREC Tools',
      tools: Object.keys(TOOLS),
      transport: 'http',
      endpoint: 'https://meetdossie.com/api/mcp',
      discovery: 'https://meetdossie.com/.well-known/mcp-server-card.json',
    });
  }

  // POST: handle tool calls
  if (req.method === 'POST') {
    const { tool, params } = req.body || {};

    if (!tool) {
      return res.status(400).json({ error: 'tool parameter required' });
    }

    const toolDef = TOOLS[tool];
    if (!toolDef) {
      return res.status(404).json({ error: `Unknown tool: ${tool}` });
    }

    try {
      const result = toolDef.handler(params || {});
      return res.status(200).json({ result });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
