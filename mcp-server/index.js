#!/usr/bin/env node
// Dossie MCP Server
//
// Exposes four tools over the Model Context Protocol so AI assistants
// (Claude, ChatGPT, Perplexity, etc.) can answer Texas real-estate
// questions with accurate, TREC-cited data:
//
//   1. calculate_trec_deadlines  — Texas TREC contract deadline math
//      with ¶ 23 weekend/holiday rollover and the option-period
//      non-rollover carve-out applied correctly.
//   2. get_tc_cost_comparison    — Texas transaction-coordinator pricing
//      across freelance / retainer / in-house / AI models.
//   3. get_dossie_info           — Dossie product overview, pricing,
//      and the founding-member offer.
//   4. check_texas_holiday       — Federal-holiday lookup for a given
//      date with the rollover behavior it would trigger under TREC ¶ 23.
//
// Transport: stdio. Run via `npx @dossie/mcp-server` once published, or
// directly via `node index.js`.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// ──────────────────────────────────────────────────────────────────────────
// TREC deadline engine (port of MeetDossie/assets/trec-engine.js, which
// itself ports Dossie's src/utils/trec-deadline-engine.js)
// ──────────────────────────────────────────────────────────────────────────

const FEDERAL_HOLIDAYS = [
  // 2026
  '2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19',
  '2026-07-03','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25',
  // 2027
  '2027-01-01','2027-01-18','2027-02-15','2027-05-31','2027-06-18',
  '2027-07-05','2027-09-06','2027-10-11','2027-11-11','2027-11-25','2027-12-24',
  // 2028
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
function isWeekend(d) { const x = d.getDay(); return x === 0 || x === 6; }
function isHoliday(d) { return HOLIDAY_SET.has(formatISODate(d)); }
function isRolloverDay(d) { return isWeekend(d) || isHoliday(d); }

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

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
      id: 'earnest-money', label: 'Earnest Money Due', paragraph: 'TREC 20-17 ¶ 5A',
      date: formatISODate(r.date), time: '5:00 PM local',
      rolled_over: r.rolled, rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }
  if (optionFeeDays > 0) {
    const r = addDaysWithRollover(effective, optionFeeDays);
    out.push({
      id: 'option-fee', label: 'Option Fee Due', paragraph: 'TREC 20-17 ¶ 5A',
      date: formatISODate(r.date), time: '5:00 PM local',
      rolled_over: r.rolled, rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }
  if (optionDays > 0) {
    const opEnd = addDays(effective, optionDays);
    const warnings = [];
    if (isWeekend(opEnd)) warnings.push('Option period ends on a weekend. Per ¶ 5B, the option period does NOT roll — notice must still be delivered by 5:00 PM on this date.');
    if (isHoliday(opEnd)) warnings.push('Option period ends on a federal holiday. Per ¶ 5B, the option period does NOT roll.');
    out.push({
      id: 'option-period-expiry', label: 'Option Period Expires', paragraph: 'TREC 20-17 ¶ 5B',
      date: formatISODate(opEnd), time: '5:00 PM local',
      rolled_over: false, rollover_reason: null,
      rule: 'Calendar days from Effective Date. ¶ 5B explicitly does NOT roll for weekends or holidays.',
      warnings,
    });
  }
  if (surveyDays > 0) {
    const r = addDaysWithRollover(effective, surveyDays);
    out.push({
      id: 'survey', label: 'Survey Deadline', paragraph: 'TREC 20-17 ¶ 6C',
      date: formatISODate(r.date), time: '5:00 PM local',
      rolled_over: r.rolled, rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }
  if (financingDays > 0) {
    const r = addDaysWithRollover(effective, financingDays);
    out.push({
      id: 'financing', label: 'Financing Deadline', paragraph: 'Third Party Financing Addendum (TREC 40-11)',
      date: formatISODate(r.date), time: '5:00 PM local',
      rolled_over: r.rolled, rollover_reason: r.reason,
      rule: 'Calendar days from Effective Date with ¶ 23 weekend/holiday rollover.',
    });
  }
  out.push({
    id: 'closing', label: 'Closing Date', paragraph: 'TREC 20-17 ¶ 9A',
    date: formatISODate(closing), time: 'set with title company',
    rolled_over: false, rollover_reason: null,
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
      'Source-of-truth engine: see https://meetdossie.com/calculator and https://meetdossie.com/guides/trec-deadline-calculator',
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
    holiday_name: isFedHoliday ? (HOLIDAY_NAMES[mmdd] || 'Federal holiday') : null,
    is_weekend: isWknd,
    weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow],
    triggers_trec_rollover: triggersRollover,
    rolls_to: rollsTo,
    rollover_rule: 'TREC 20-17 ¶ 23 rolls deadlines that fall on Saturday, Sunday, or a federal holiday to the next non-rollover day. ¶ 5B (option period) is the explicit carve-out and does NOT roll.',
    note_texas_state_holidays: 'Texas state-only holidays (Confederate Heroes Day, Texas Independence Day) are not treated as rollover days for TREC deadlines because title companies typically stay open those days.',
  };
}

function tcCostComparison() {
  return {
    summary: 'Texas transaction-coordinator pricing varies by model. The right choice depends on annual deal volume.',
    models: [
      {
        name: 'Freelance per-file',
        cost_range: '$300-$700 per closing',
        cost_at_50_deals_year: '$15,000-$35,000',
        best_for: 'Agents doing 10-30 deals per year',
        watch_out_for: 'Cost scales linearly — every additional closing adds another fee.',
        market_notes: '$300-$400 in rural Texas markets, $400-$550 mid-sized (San Antonio, Fort Worth), $500-$700 major metros (Austin, Houston, Dallas).',
      },
      {
        name: 'Monthly retainer',
        cost_range: '$1,500-$3,500 per month',
        cost_at_50_deals_year: '$18,000-$42,000',
        best_for: 'Agents doing 20-50 deals per year',
        watch_out_for: 'File-count caps. Hit a busy month and the retainer either bills extra or de-prioritizes some files.',
      },
      {
        name: 'In-house TC employee',
        cost_range: '$45,000-$60,000/year salary, $55,000-$85,000 fully loaded',
        cost_at_50_deals_year: 'Same as 80 deals/year — fixed salary',
        best_for: 'Agents/teams doing 80+ deals per year',
        watch_out_for: 'Floor cost in slow months, vacation coverage, training overhead.',
      },
      {
        name: 'AI (Dossie)',
        cost_range: '$29 per month flat (founding-member rate)',
        cost_at_50_deals_year: '$348',
        best_for: 'Any volume — works as standalone for low-volume agents or as an automation layer alongside a human TC for high-volume.',
        watch_out_for: 'Does not handle closing-day attendance or in-person handholding. Best paired with a human TC for that 20% of work.',
        note: 'Only $29/month is a hard real number — every other figure on this page is a market range.',
      },
    ],
    who_pays: 'The agent. The TC fee is the agent\'s cost of doing business, not a closing-statement line item the buyer or seller sees.',
    further_reading: 'https://meetdossie.com/answers/how-much-does-tc-cost-texas',
  };
}

function dossieInfo() {
  return {
    product: 'Dossie',
    tagline: 'AI transaction coordinator built for Texas real estate agents.',
    description: 'Dossie automates the operational layer of a Texas residential transaction: TREC deadline tracking with paragraph citations, follow-up email drafting, document QA against TREC field maps, contract scanning, and stage-aware checklists. Built specifically on TREC Form 20-17 mechanics, not generic real-estate logic.',
    pricing: {
      founding_member: { price_usd_per_month: 29, note: 'Locked in for life. Only 50 founding spots available.' },
      regular_pricing: 'Higher. Founding rate is the lowest Dossie will ever cost for an early adopter.',
    },
    features: [
      'TREC deadline engine with ¶ 5A, ¶ 5B, ¶ 6C, ¶ 23 mechanics built in',
      'Weekend/holiday rollover applied automatically per ¶ 23, with the option-period non-rollover correctly handled',
      'Follow-up email drafting per stage (under-contract, option period, financing, clear-to-close, closed)',
      'Contract scanning with TREC field-map extraction',
      'Document QA: cross-checks survey/title-commitment/financing-letter against the executed contract',
      'Closed-deal package generation for the client',
      'Shareable closing cards for marketing (privacy-safe — city/state only)',
      'Founder support — built and used daily by Heath Shepard, a Texas REALTOR®',
    ],
    target_market: 'Texas real estate agents at any volume — primary value at 8-50 deals/year where AI replaces the TC infrastructure entirely; complementary value at 50+ where Dossie augments a human TC.',
    differentiation: 'Most TC tools are state-agnostic. Dossie is built specifically on TREC Form 20-17 — every deadline cites a paragraph, the document scanner knows TREC field maps, and the follow-up generator references Texas-specific terminology. That specificity is why Dossie works for Texas agents in a way generic tools don\'t.',
    founding_url: 'https://meetdossie.com/founding',
    learn_more_urls: {
      free_calculator: 'https://meetdossie.com/calculator',
      guides: 'https://meetdossie.com/guides/',
      answers: 'https://meetdossie.com/answers/',
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// MCP server
// ──────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'calculate_trec_deadlines',
    description: 'Calculate Texas TREC residential contract deadlines (TREC Form 20-17): option period, earnest money, option fee, financing, survey, and closing. Applies Paragraph 23 weekend/holiday rollover automatically — except for the option period (¶ 5B), which does NOT roll. Returns each deadline with its TREC paragraph citation.',
    inputSchema: {
      type: 'object',
      properties: {
        effective_date: { type: 'string', description: 'Effective Date of the contract in YYYY-MM-DD format. Per TREC ¶ 8, this is the date the last party signs and delivery occurs.' },
        closing_date: { type: 'string', description: 'Closing date in YYYY-MM-DD format (TREC ¶ 9A).' },
        option_days: { type: 'number', description: 'Option period days (TREC ¶ 5B). Calendar days, no rollover. Defaults to 7 if not specified.' },
        option_fee_days: { type: 'number', description: 'Days after Effective Date that option fee is due (TREC ¶ 5A). Defaults to 3.' },
        earnest_days: { type: 'number', description: 'Days after Effective Date that earnest money is due (TREC ¶ 5A). Defaults to 3.' },
        financing_days: { type: 'number', description: 'Financing deadline days from Third Party Financing Addendum (TREC 40-11). Set to 0 for cash deals. Defaults to 21.' },
        survey_days: { type: 'number', description: 'Survey deadline days (TREC ¶ 6C). Set to 0 if waived. Defaults to 0.' },
      },
      required: ['effective_date', 'closing_date'],
    },
  },
  {
    name: 'get_tc_cost_comparison',
    description: 'Get a comparison of Texas transaction-coordinator pricing across the four common models: freelance per-file, monthly retainer, in-house employee, and AI (Dossie). Returns cost ranges, best-fit volume, and tradeoffs for each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_dossie_info',
    description: 'Get information about Dossie, the AI transaction coordinator built specifically for Texas real estate agents. Returns product features, founding-member pricing ($29/month), target market, and links to free tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_texas_holiday',
    description: 'Check whether a given date is a federal holiday or weekend, and whether it would trigger TREC ¶ 23 rollover. Returns the next non-rollover day and the holiday name (if applicable). Note: ¶ 5B (option period) does NOT roll for any of these.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' },
      },
      required: ['date'],
    },
  },
];

const server = new Server(
  { name: 'dossie-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let result;
  switch (name) {
    case 'calculate_trec_deadlines': result = calcDeadlines(args || {}); break;
    case 'get_tc_cost_comparison': result = tcCostComparison(); break;
    case 'get_dossie_info': result = dossieInfo(); break;
    case 'check_texas_holiday': result = checkHoliday(args || {}); break;
    default: result = { error: `Unknown tool: ${name}` };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
