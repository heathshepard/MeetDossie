// api/_lib/seller-intake-fields.js
//
// THE SELLER INTAKE SPEC — one source of truth for what we ask a seller at the
// listing appointment, and how each answer becomes a net sheet line.
//
// Why this file exists
// --------------------
// 2026-09-16, 23 Nopalito: a full-price offer ($999,000) landed and the seller
// net sheet had to go out the same day. Four numbers on it were guesses:
//
//   1. Title policy        — $5,221, off the Texas promulgated rate table.
//   2. HOA resale cert     — $300. The addendum says seller pays. No figure.
//   3. Escrow + tax cert
//      + deed prep         — $450, "standard Bexar County figures." Not a quote
//                            from the actual title company. Not sourced at all.
//   4. Property taxes      — the bad one. The sellers' current bill is $0.00
//                            (homestead + disabled veteran + DV4). They had
//                            ALREADY MOVED OUT, so those exemptions no longer
//                            belong to that house, and TREC 20-19 ¶13 lets the
//                            title company prorate on what the tax WOULD be
//                            without them. The email to the sellers had to say
//                            "somewhere between nothing and $15,000-20,000,
//                            confirm with the title company."
//
// Every one of those was knowable in April when the listing was signed. The
// sellers instead got a net sheet with a $20,000 question mark on the day a
// full-price offer arrived.
//
// So: ask at the listing appointment, store it against the transaction, and
// let the net sheet NARROW its estimate instead of shrugging at it.
//
// What this does and does not buy you
// -----------------------------------
// A seller's net sheet is an estimate in its entirety, always, no matter how
// good the inputs are. The real figures are set by the title company on the
// settlement statement at closing. Intake does not make a net sheet certain —
// it makes it NARROW. "Somewhere between nothing and $15,000-20,000, confirm
// with the title company" becomes "expect roughly $X, confirm with the title
// company." That is a big improvement and it is still an estimate. See
// api/_lib/net-sheet-disclaimer.js, which every render path must carry.
//
// Because of that, this file deliberately does NOT sort figures into
// "confirmed" and "estimated" buckets. That vocabulary invites a seller to
// treat the first bucket as guaranteed. Instead every figure carries its
// PROVENANCE and a DATE — "from your Apr 12 intake", "quoted by Alamo Title on
// Apr 12", "not yet confirmed" — so the reader judges reliability themselves.
// Where a value is genuinely missing it stays visibly missing and the bottom
// line becomes a range. See FIGURE_SOURCES below.
//
// Every field in FIELDS traces to something that actually bites. If you add
// one, put the reason in `why`. A field with no `why` is a field nobody will
// fill in.
//
// Owner: 2026-09-20.

// ---------------------------------------------------------------------------
// Provenance taxonomy. These describe WHERE a number came from, not how much
// to trust it. None of them means "final" — see the module header.
// ---------------------------------------------------------------------------
const FIGURE_SOURCES = {
  // The seller answered it at the listing table. Carries the intake date.
  SELLER_INTAKE: 'seller_intake',
  // The title company or HOA management company quoted it. Carries quote date.
  THIRD_PARTY_QUOTE: 'third_party_quote',
  // Extracted from the scanned contract / listing agreement. Existing behavior.
  CONTRACT: 'contract',
  // The agent typed it into the net sheet form for this one calculation.
  AGENT_ENTRY: 'agent_entry',
  // Derived from a published schedule (e.g. a promulgated rate), not a person.
  RATE_TABLE: 'rate_table',
  // Computed from other captured values (e.g. a ¶13 proration off an annual
  // tax figure). Only as good as what it was computed from, so it names that.
  DERIVED: 'derived',
  // Nobody has confirmed this. MUST render as a visible line reading "not yet
  // confirmed" with no amount, and MUST be excluded from the total — which
  // then becomes the top of a range, not a number. Never silently zero.
  NOT_CONFIRMED: 'not_confirmed',
};

const UNKNOWN_IS_NOT_ZERO =
  'A missing value is not $0.00. It is a hole in the net sheet, and it has to look like one.';

// Short human labels rendered next to each line. Deliberately factual about
// origin and silent about certainty — there is one disclaimer, at the top, and
// it covers the whole document.
function whenLabel(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).length === 10 ? dateStr + 'T12:00:00Z' : dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function sourceLabel(kind, opts) {
  const o = opts || {};
  const when = whenLabel(o.date);
  switch (kind) {
    case FIGURE_SOURCES.SELLER_INTAKE:
      return when ? 'from your ' + when + ' intake' : 'from your seller intake';
    case FIGURE_SOURCES.THIRD_PARTY_QUOTE:
      return 'quoted by ' + (o.who || 'a third party') + (when ? ' on ' + when : '');
    case FIGURE_SOURCES.CONTRACT:
      return 'from the contract';
    case FIGURE_SOURCES.AGENT_ENTRY:
      return 'entered by your agent';
    case FIGURE_SOURCES.RATE_TABLE:
      return o.who ? 'from the ' + o.who : 'from a published rate schedule';
    case FIGURE_SOURCES.DERIVED:
      return o.who ? 'calculated from ' + o.who : 'calculated';
    case FIGURE_SOURCES.NOT_CONFIRMED:
      return 'not yet confirmed';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

// Texas property tax exemptions that materially change a tax bill and that a
// listing agent can reasonably ask about. Not exhaustive of the tax code —
// these are the ones that produce the Nopalito failure mode, where the CURRENT
// bill tells you nothing about the PRORATED bill.
const TAX_EXEMPTIONS = [
  'homestead',            // Tex. Tax Code §11.13
  'over_65',              // §11.13(c) — also carries a ceiling
  'disabled_person',      // §11.13(c)
  'disabled_veteran',     // §11.22 — partial, by VA rating
  'dv4_100_percent',      // §11.131 — TOTAL exemption. This is why Nopalito billed $0.00.
  'surviving_spouse',     // §11.131(c)/(d), §11.133
  'ag_timber',            // §23.51 productivity valuation — carries ROLLBACK tax on change of use
  'none',
];

const OCCUPANCY = [
  'seller_occupies',      // exemptions are defensible for the current year
  'seller_moved_out',     // THE Nopalito answer — exemptions no longer belong here
  'tenant_occupied',      // no homestead; also a lease that may survive closing
  'vacant_never_occupied', // investor/flip — never had a homestead to lose
];

const PAYER = ['seller', 'buyer', 'split', 'per_contract', 'unknown'];

const YES_NO_UNSURE = ['yes', 'no', 'unsure'];

// TREC 20-19 ¶4.B "Leased Items" — the contract makes the seller disclose
// these, and every one of them is also a potential payoff line on the net
// sheet. Solar routinely runs five figures and routinely surfaces the week of
// closing.
const LEASED_ITEM_TYPES = [
  'solar_panels',
  'propane_tank',
  'water_softener',
  'security_system',
  'alarm_monitoring',
  'pool_equipment',
  'hvac',
  'generator',
  'other',
];

// ---------------------------------------------------------------------------
// FIELDS
//
// `key`        column on seller_intake
// `label`      what the agent reads out loud at the kitchen table
// `type`       text | money | date | bool | enum | enum[] | json | int
// `group`      capture-form section
// `why`        the thing that bites if this is blank. Required.
// `feeds`      which net sheet line this answer resolves, if any
// ---------------------------------------------------------------------------
const FIELDS = [
  // -- PAYOFF -------------------------------------------------------------
  {
    key: 'payoff_status', type: 'enum', group: 'payoff',
    options: ['owns_outright', 'has_mortgage', 'unsure'],
    label: 'Is there a loan on the property, or do you own it free and clear?',
    why: 'The Whytes own 23 Nopalito outright. That fact lived only in Heath\'s head — nowhere in the file. "Owns outright" is an affirmative captured fact, not an absent mortgage field, and only the affirmative version lets the net sheet drop the payoff line honestly.',
    feeds: 'mortgage_payoff',
  },
  {
    key: 'payoff_lender_name', type: 'text', group: 'payoff',
    label: 'Who is the lender?',
    why: 'You cannot order a payoff statement without it, and the payoff is usually the largest single line on the sheet.',
  },
  {
    key: 'payoff_balance_approx', type: 'money', group: 'payoff',
    label: 'Roughly what is the balance?',
    why: 'Gets the net sheet inside a few thousand dollars months before an offer exists.',
    feeds: 'mortgage_payoff',
  },
  {
    key: 'payoff_balance_as_of', type: 'date', group: 'payoff',
    label: 'As of when?',
    why: 'A payoff balance is stale the day after it is quoted (per-diem interest). The as-of date is what lets the net sheet label this ESTIMATED rather than pass it off as the closing figure.',
  },
  {
    key: 'has_second_lien', type: 'bool', group: 'payoff',
    label: 'Any second lien — HELOC, home equity loan, solar lien?',
    why: 'A HELOC with a zero balance is still a lien that has to be released at closing, and a drawn one is a payoff nobody budgeted for. Sellers routinely do not volunteer this because they do not think of it as a mortgage.',
    feeds: 'mortgage_payoff',
  },
  { key: 'second_lien_details', type: 'text', group: 'payoff', label: 'Second lien — lender and balance', why: 'Names the second payoff so it can be ordered.' },
  {
    key: 'has_other_liens', type: 'bool', group: 'payoff',
    label: 'Any unpaid contractor bills, judgments, tax liens, or past-due HOA assessments?',
    why: 'These surface on the title commitment (Schedule C) weeks after the contract, and every one of them is a seller-side payoff. Asking in April costs nothing; finding out in option period costs the deal.',
    feeds: 'other_liens_payoff',
  },
  { key: 'other_liens_details', type: 'text', group: 'payoff', label: 'Liens — describe', why: 'Detail needed to price it.' },
  { key: 'other_liens_amount', type: 'money', group: 'payoff', label: 'Approximate total', why: 'Makes it a computable line instead of a footnote.', feeds: 'other_liens_payoff' },

  // -- PROPERTY TAX — the $20,000 line ------------------------------------
  {
    key: 'tax_annual_amount', type: 'money', group: 'tax',
    label: 'What did you pay in property taxes last year, as billed?',
    why: 'The base for the TREC ¶13 proration. On its own it is NOT sufficient — see tax_exemptions.',
    feeds: 'property_tax_proration',
  },
  { key: 'tax_year', type: 'int', group: 'tax', label: 'For which tax year?', why: 'A three-year-old bill is not this year\'s bill. Rates and valuations move.' },
  { key: 'tax_account_number', type: 'text', group: 'tax', label: 'Appraisal district account number', why: 'Lets the figure be verified against the county rather than taken on memory.' },
  {
    key: 'tax_exemptions', type: 'enum[]', group: 'tax', options: TAX_EXEMPTIONS,
    label: 'Which exemptions are on file — homestead, over-65, disabled veteran, ag?',
    why: 'THE Nopalito field. The Whytes\' bill reads $0.00 because homestead + disabled veteran + DV4 are on file. A net sheet that prorates $0.00 outputs $0.00 and looks like a fact. Exemptions follow the person, not the house: the buyer does not inherit them, and ¶13 lets the title company prorate on the un-exempt amount.',
    feeds: 'property_tax_proration',
  },
  {
    key: 'occupancy_status', type: 'enum', group: 'tax', options: OCCUPANCY,
    label: 'Do you still live here?',
    why: 'The question that makes the exemption answer mean anything. The Whytes had already moved out, so the homestead had already stopped belonging to that house — which is exactly when ¶13 exposure becomes real rather than theoretical. Without this field, "homestead: yes" reads as reassurance instead of a warning.',
    feeds: 'property_tax_proration',
  },
  { key: 'moved_out_date', type: 'date', group: 'tax', label: 'When did you move out?', why: 'Fixes which tax year the exemption was still validly claimed.' },
  {
    key: 'tax_amount_without_exemptions', type: 'money', group: 'tax',
    label: 'What would the tax be WITHOUT the exemptions? (ask the appraisal district or title company)',
    why: 'The single number that would have removed the $20,000 question mark from the Nopalito email. It is a phone call to the appraisal district in April. It is a crisis in September. If this is blank and exemptions exist, the net sheet must say UNKNOWN — it may not fall back to the exempt figure, because that is how you print $0.00 and call it a proration.',
    feeds: 'property_tax_proration',
  },
  {
    key: 'ag_rollback_risk', type: 'enum', group: 'tax', options: YES_NO_UNSURE,
    label: 'If ag/timber valuation: will the buyer change the use?',
    why: 'Tex. Tax Code §23.55 rollback — up to 3 prior years of tax difference plus interest, triggered at change of use. Six figures on acreage. TREC ¶13.B assigns it, and it is never on anyone\'s net sheet until it is.',
  },

  // -- HOA ----------------------------------------------------------------
  { key: 'hoa_exists', type: 'bool', group: 'hoa', label: 'Is there an HOA?', why: 'Gates the whole section, and a "no" is an affirmative fact that lets the net sheet drop four lines cleanly.', feeds: 'hoa_fees' },
  { key: 'hoa_name', type: 'text', group: 'hoa', label: 'Association name', why: 'Needed to order the resale certificate at all.' },
  { key: 'hoa_management_company', type: 'text', group: 'hoa', label: 'Management company', why: 'The association rarely answers the phone; the management company sets and collects the fees. Without it nobody can get a real number.' },
  { key: 'hoa_contact', type: 'text', group: 'hoa', label: 'Management contact (email / phone)', why: 'Turns "call the HOA" into a task someone can actually finish.' },
  { key: 'hoa_dues_amount', type: 'money', group: 'hoa', label: 'Dues amount', why: 'Prorated at closing under ¶13, and a buyer-qualification input.', feeds: 'hoa_dues_proration' },
  { key: 'hoa_dues_frequency', type: 'enum', group: 'hoa', options: ['monthly', 'quarterly', 'semiannual', 'annual'], label: 'How often?', why: '$400 monthly and $400 annually are not the same property.' },
  {
    key: 'hoa_resale_certificate_fee', type: 'money', group: 'hoa',
    label: 'Resale certificate fee',
    why: 'Nopalito guess #2 — $300, invented, on an addendum that says the seller pays but names no figure. Texas Property Code §207.003 lets the association set this; in Bexar/Kendall it ranges from under a hundred to several hundred dollars. It is one call to the management company.',
    feeds: 'hoa_fees',
  },
  { key: 'hoa_resale_certificate_payer', type: 'enum', group: 'hoa', options: PAYER, label: 'Who pays the resale certificate?', why: 'A captured amount charged to the wrong party is still a wrong net sheet.' },
  { key: 'hoa_transfer_fee', type: 'money', group: 'hoa', label: 'Transfer fee', why: 'Separate charge from the resale certificate and frequently larger. Already a net sheet input with nothing populating it.', feeds: 'hoa_fees' },
  { key: 'hoa_transfer_fee_payer', type: 'enum', group: 'hoa', options: PAYER, label: 'Who pays the transfer fee?', why: 'Same reason.' },
  { key: 'hoa_capital_contribution', type: 'money', group: 'hoa', label: 'Capital contribution / working capital fee', why: 'A one-time charge at closing that is not the transfer fee and not the resale certificate. Commonly assigned to the buyer, but not always — and when it lands on the seller it is a line nobody forecast.', feeds: 'hoa_fees' },
  { key: 'hoa_second_association', type: 'bool', group: 'hoa', label: 'Is there a second (master) association?', why: 'Master + sub-association means two resale certificates and two sets of fees. Common in San Antonio and Boerne developments, and the second one is always the one that gets missed.', feeds: 'hoa_fees' },
  { key: 'hoa_unpaid_assessments', type: 'money', group: 'hoa', label: 'Anything currently owed to the HOA?', why: 'Paid off the seller\'s proceeds at closing, and a special assessment can be thousands.', feeds: 'hoa_fees' },

  // -- TITLE / ESCROW -----------------------------------------------------
  {
    key: 'preferred_title_company', type: 'text', group: 'title',
    label: 'Which title company do you want to use?',
    why: 'Escrow, tax certificate and deed prep are that company\'s published fees. Nopalito guess #3 was $450 of "standard Bexar County figures" precisely because no title company was named on the file — there was no one to ask.',
  },
  { key: 'title_closer_name', type: 'text', group: 'title', label: 'Closer / escrow officer', why: 'A company name cannot quote you a fee; a person can.' },
  { key: 'title_closer_contact', type: 'text', group: 'title', label: 'Closer email / phone', why: 'Same — this is what converts three estimated lines into three quoted ones.' },
  { key: 'title_policy_cost_quoted', type: 'money', group: 'title', label: 'Owner\'s title policy premium (quoted)', why: 'Texas promulgates this rate, so it is genuinely calculable — but a quote from the issuing company beats a table lookup, and Dossie deliberately does not carry a hardcoded rate table (see NOT_CAPTURED_ON_PURPOSE).', feeds: 'title_policy_cost' },
  { key: 'title_policy_payer', type: 'enum', group: 'title', options: PAYER, label: 'Who pays the owner\'s policy?', why: 'TREC ¶6.A is an election, not a default. Customarily seller in most of Texas, and customarily is not always.' },
  { key: 'escrow_fee_quoted', type: 'money', group: 'title', label: 'Escrow / closing fee (quoted)', why: 'Part of the $450 guess.', feeds: 'escrow_fee' },
  { key: 'tax_certificate_fee_quoted', type: 'money', group: 'title', label: 'Tax certificate fee (quoted)', why: 'Part of the $450 guess.', feeds: 'escrow_fee' },
  { key: 'deed_prep_fee_quoted', type: 'money', group: 'title', label: 'Deed preparation fee (quoted)', why: 'Part of the $450 guess.', feeds: 'escrow_fee' },
  { key: 'recording_fees_quoted', type: 'money', group: 'title', label: 'Recording fees (quoted)', why: 'Small, but it was inside the $450 lump nobody could source.', feeds: 'escrow_fee' },
  { key: 'title_quote_date', type: 'date', group: 'title', label: 'Date of the title quote', why: 'A quote with no date is an estimate wearing a quote\'s clothes.' },

  // -- SURVEY (¶6.C) ------------------------------------------------------
  { key: 'has_existing_survey', type: 'bool', group: 'survey', label: 'Do you have an existing survey?', why: 'Decides whether a new survey is a seller cost at all.', feeds: 'survey_cost' },
  { key: 'survey_date', type: 'date', group: 'survey', label: 'Survey date', why: 'Age is what the title company and lender actually judge; an old survey with no changes still passes.' },
  {
    key: 'will_sign_t47', type: 'enum', group: 'survey', options: YES_NO_UNSURE,
    label: 'Will you sign a T-47 affidavit saying nothing has changed?',
    why: 'An existing survey without a T-47 is not usable. A seller who will not swear to it turns a $0 line into a new survey at seller cost under ¶6.C — a several-hundred-dollar swing that is knowable in April and discovered in option period.',
    feeds: 'survey_cost',
  },
  { key: 'survey_changes_since', type: 'text', group: 'survey', label: 'Anything built/added since the survey? (pool, deck, shed, fence)', why: 'This is what makes a T-47 false. Improvements added after the survey are exactly what forces a new one.' },
  { key: 'new_survey_cost_quoted', type: 'money', group: 'survey', label: 'New survey cost (quoted)', why: 'Turns the fallback into a computable line instead of a shrug.', feeds: 'survey_cost' },

  // -- LEASED ITEMS (¶4.B) -------------------------------------------------
  {
    key: 'leased_items', type: 'json', group: 'leased', itemShape: LEASED_ITEM_TYPES,
    label: 'Anything leased or financed that stays with the house — solar, propane tank, water softener, security system?',
    why: 'TREC ¶4.B requires the disclosure, and every entry is also a money line: a solar lease is either assumed by the buyer or paid off by the seller, and the payoff is routinely five figures. These surface late by default because sellers think of them as utilities, not as debt.',
    feeds: 'leased_item_payoff',
  },
  { key: 'leased_items_payoff_total', type: 'money', group: 'leased', label: 'Total payoff if they do not transfer', why: 'The net sheet number. Separate from the disclosure, because "there is solar" and "solar costs you $31,000 at closing" are different sentences.', feeds: 'leased_item_payoff' },

  // -- HOME WARRANTY ------------------------------------------------------
  { key: 'will_offer_home_warranty', type: 'enum', group: 'concessions', options: YES_NO_UNSURE, label: 'Will you offer a home warranty?', why: 'Decided at listing, not when an offer is on the table with a clock running.', feeds: 'home_warranty_cap' },
  { key: 'home_warranty_cap', type: 'money', group: 'concessions', label: 'Up to what amount?', why: 'Already a net sheet input with nothing populating it.', feeds: 'home_warranty_cap' },

  // -- OCCUPANCY / LEASE ---------------------------------------------------
  { key: 'is_tenant_occupied', type: 'bool', group: 'occupancy', label: 'Is there a tenant in place?', why: 'A lease that survives closing changes what can be sold and to whom, kills the homestead exemption (feeding the tax question above), and puts a security deposit on the settlement statement.' },
  { key: 'lease_end_date', type: 'date', group: 'occupancy', label: 'Lease end date', why: 'Determines whether the buyer inherits a tenant.' },
  { key: 'security_deposit_held', type: 'money', group: 'occupancy', label: 'Security deposit held', why: 'Transfers to the buyer at closing — a real debit on the seller side that no one puts on a net sheet.', feeds: 'other_credits' },
  { key: 'needs_leaseback', type: 'enum', group: 'occupancy', options: YES_NO_UNSURE, label: 'Will you need to stay after closing?', why: 'A leaseback is a contract term negotiated best before an offer exists, and a daily rate is a net sheet credit.' },

  // -- SPECIAL DISTRICTS ---------------------------------------------------
  { key: 'in_mud_district', type: 'enum', group: 'districts', options: YES_NO_UNSURE, label: 'Is the property in a MUD?', why: 'Tex. Water Code §49.452 requires the seller to deliver the MUD notice BEFORE the contract is executed. Missing it gives the buyer a termination right. Not a net sheet line — a contract-validity line, captured here because this is the only conversation where anyone asks.' },
  { key: 'in_pid_district', type: 'enum', group: 'districts', options: YES_NO_UNSURE, label: 'Is there a PID assessment?', why: 'Public Improvement District assessments carry their own §5.014 notice AND an outstanding balance that is often paid off at closing.' },
  { key: 'pid_assessment_balance', type: 'money', group: 'districts', label: 'PID balance outstanding', why: 'A payoff line when it exists.', feeds: 'other_liens_payoff' },

  // -- FIRPTA --------------------------------------------------------------
  {
    key: 'seller_is_us_person', type: 'enum', group: 'firpta', options: YES_NO_UNSURE,
    label: 'Is every seller a U.S. citizen or resident alien for tax purposes?',
    why: 'FIRPTA (26 U.S.C. §1445) withholding is up to 15% of the GROSS sale price. On a $999,000 sale that is $149,850 — an order of magnitude larger than every other guess on the Nopalito sheet combined. A net sheet that silently assumes a U.S. seller is the single worst thing this table could get wrong, so it is asked explicitly and an "unsure" is treated as unknown.',
    feeds: 'firpta_withholding',
  },
];

// ---------------------------------------------------------------------------
// Deliberate omissions. Recorded so nobody "helpfully" adds them back.
// ---------------------------------------------------------------------------
const NOT_CAPTURED_ON_PURPOSE = [
  {
    item: 'A hardcoded Texas promulgated title premium rate table',
    reason:
      'It would make title policy computable without a quote, and the Nopalito title figure ($5,221) was in fact the one defensible estimate of the four. But a rate table typed from memory is exactly the "plausible number" this feature exists to eliminate, and the table changes by TDI order. Until the real schedule is loaded from a cited source, title policy is a captured quote or it is UNKNOWN.',
  },
  {
    item: 'Septic / well / pool condition questions',
    reason: 'Real seller-disclosure obligations, but they drive addenda and inspections, not the net sheet. They belong in a disclosure intake, not this one. Scope discipline: a 60-field form that nobody finishes captures less than a 50-field form that gets done at the table.',
  },
  {
    item: 'Mineral / water rights reservation',
    reason: 'A contract term negotiated per offer, not a standing fact about the property with a dollar value on the settlement statement.',
  },
  {
    item: 'Commission split and listing side percentage',
    reason: 'Already on the transaction (commission_rate, off the scanned listing agreement) and already feeding the net sheet. Duplicating it here would create two sources of truth for the largest line on the sheet.',
  },
];

// ---------------------------------------------------------------------------
// Net sheet resolution
// ---------------------------------------------------------------------------

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function sum(parts) {
  const present = parts.filter((p) => p != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

const MEANINGFUL_EXEMPTIONS = TAX_EXEMPTIONS.filter((e) => e !== 'none');

// Enum values are for the database. These notes are read by a seller, and
// "dv4_100_percent" is not a thing anyone says out loud.
const EXEMPTION_NAMES = {
  homestead: 'homestead',
  over_65: 'over-65',
  disabled_person: 'disabled person',
  disabled_veteran: 'disabled veteran',
  dv4_100_percent: '100% disabled veteran (DV4)',
  surviving_spouse: 'surviving spouse',
  ag_timber: 'agricultural / timber',
  none: 'none',
};

function exemptionList(intake) {
  const ex = Array.isArray(intake && intake.tax_exemptions) ? intake.tax_exemptions : [];
  return ex.map((e) => EXEMPTION_NAMES[e] || e).join(', ');
}

function hasExemptions(intake) {
  const ex = Array.isArray(intake.tax_exemptions) ? intake.tax_exemptions : [];
  return ex.some((e) => MEANINGFUL_EXEMPTIONS.includes(e));
}

// Days from Jan 1 of the closing year through the closing date, inclusive —
// the seller's share under TREC 20-19 ¶13 ("prorated through the Closing
// Date"). Returns null on an unusable date rather than guessing a year.
function sellerTaxDays(closingDate) {
  if (!closingDate) return null;
  const d = new Date(closingDate + (String(closingDate).length === 10 ? 'T12:00:00Z' : ''));
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const days = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - jan1) / 86400000) + 1;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return { sellerDays: days, daysInYear: isLeap ? 366 : 365 };
}

// THE ¶13 DECISION. Returns { amount, source, label, note }.
//
// The one rule: if exemptions are on file and the seller has moved out, the
// current bill is NOT the proration base, and we do not have the real base
// unless tax_amount_without_exemptions was answered. In that case the answer is
// NOT_CONFIRMED with the reason attached. It is never the exempt figure, and it
// is never zero.
//
// Note what this does NOT claim even in the best case: a ¶13 proration off a
// real non-exempt figure is still an estimate, because the current year's tax
// statement usually has not issued at closing and ¶13 itself contemplates the
// parties re-prorating when it does. The `label` says where the number came
// from; the document-level disclaimer says it is an estimate.
function resolvePropertyTaxProration(intake, closingDate) {
  const exemptions = hasExemptions(intake);
  const movedOut = intake.occupancy_status === 'seller_moved_out'
    || intake.occupancy_status === 'tenant_occupied'
    || intake.occupancy_status === 'vacant_never_occupied';
  const unExempt = num(intake.tax_amount_without_exemptions);
  const billed = num(intake.tax_annual_amount);
  const timing = sellerTaxDays(closingDate);
  const intakeDate = intake.captured_at || null;
  const exList = exemptionList(intake);

  const prorate = (annual) => {
    if (annual == null || !timing) return null;
    return Math.round((annual * timing.sellerDays / timing.daysInYear) * 100) / 100;
  };
  const notConfirmed = (note) => ({
    amount: null,
    source: FIGURE_SOURCES.NOT_CONFIRMED,
    label: sourceLabel(FIGURE_SOURCES.NOT_CONFIRMED),
    note,
  });

  if (!timing) {
    return notConfirmed('No closing date yet, so taxes cannot be prorated. TREC ¶13 prorates through the Closing Date.');
  }

  // Exempt + seller gone: the Nopalito case.
  if (exemptions && movedOut) {
    if (unExempt != null) {
      return {
        amount: prorate(unExempt),
        source: FIGURE_SOURCES.DERIVED,
        label: sourceLabel(FIGURE_SOURCES.DERIVED, { who: 'the non-exempt tax figure in your intake' }),
        note: 'Prorated on the NON-exempt tax amount, ' + timing.sellerDays + ' of ' + timing.daysInYear +
          ' days. The exemptions on file (' + exList + ') do not follow the property to the buyer, and you no ' +
          'longer occupy it, so TREC ¶13 prorates on what the tax is without them. The title company sets the ' +
          'final proration and may re-prorate when the actual statement issues.',
      };
    }
    return notConfirmed(
      'NOT COMPUTABLE: exemptions (' + exList + ') are on file but the seller no longer occupies the property. ' +
      'Under TREC ¶13 the title company may prorate on the tax WITHOUT those exemptions, which is not the billed amount' +
      (billed != null ? ' of $' + billed.toFixed(2) : '') +
      '. Get the non-exempt figure from the appraisal district or the title company and enter it as ' +
      '"tax without exemptions." Dossie will not guess this number.'
    );
  }

  // Exempt but seller still lives there: the current-year bill is a defensible
  // base for this year, but the exemption still does not transfer.
  if (exemptions) {
    if (billed == null) return notConfirmed('No annual tax amount on file.');
    return {
      amount: prorate(billed),
      source: FIGURE_SOURCES.DERIVED,
      label: sourceLabel(FIGURE_SOURCES.DERIVED, {
        who: 'your current tax bill' + (intakeDate ? ', ' + whenLabel(intakeDate) + ' intake' : ''),
      }),
      note: 'Prorated on the CURRENT billed amount, ' + timing.sellerDays + ' of ' + timing.daysInYear +
        ' days. That bill reflects exemptions (' + exList + ') the buyer does not inherit, so the figure the ' +
        'title company uses may be higher. TREC ¶13 lets the parties re-prorate when the actual statement issues.',
    };
  }

  if (billed == null) return notConfirmed('No annual property tax amount on file.');
  return {
    amount: prorate(billed),
    source: FIGURE_SOURCES.DERIVED,
    label: sourceLabel(FIGURE_SOURCES.DERIVED, {
      who: 'your annual tax bill' + (intakeDate ? ', ' + whenLabel(intakeDate) + ' intake' : ''),
    }),
    note: 'Prorated from January 1 through the closing date (' + timing.sellerDays + ' of ' +
      timing.daysInYear + ' days), TREC ¶13. No exemptions on file.',
  };
}

// Build the full set of net sheet inputs from a seller_intake row.
// Returns { values, sources, labels, notes } keyed by net sheet line.
//
// A key whose source is NOT_CONFIRMED has value null. Callers must NOT coerce
// that to 0 — that is the entire bug this module exists to prevent.
//
// `labels` is what a seller reads next to the number: where it came from and
// when. It never says "confirmed" or "final". The document-level disclaimer in
// api/_lib/net-sheet-disclaimer.js carries the estimate warning for the whole
// sheet, so individual lines do not have to hedge and must not imply certainty.
function deriveNetSheetInputs(intake, opts) {
  const options = opts || {};
  const closingDate = options.closingDate || null;
  const values = {};
  const sources = {};
  const labels = {};
  const notes = {};

  const set = (key, amount, source, label, note) => {
    values[key] = amount;
    sources[key] = source;
    labels[key] = label || sourceLabel(source);
    if (note) notes[key] = note;
  };
  const unconfirmed = (key, note) =>
    set(key, null, FIGURE_SOURCES.NOT_CONFIRMED, sourceLabel(FIGURE_SOURCES.NOT_CONFIRMED), note);

  if (!intake) return { values, sources, labels, notes };

  const intakeOn = intake.captured_at || null;
  const fromIntake = sourceLabel(FIGURE_SOURCES.SELLER_INTAKE, { date: intakeOn });
  const titleCo = intake.preferred_title_company || null;
  const quoteLabel = (who) => sourceLabel(FIGURE_SOURCES.THIRD_PARTY_QUOTE, {
    who: who || 'the title company', date: intake.title_quote_date,
  });

  // --- payoff ---
  if (intake.payoff_status === 'owns_outright') {
    set('mortgage_payoff', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'You told us the property is owned free and clear — no lien to pay off.');
  } else if (intake.payoff_status === 'has_mortgage') {
    const first = num(intake.payoff_balance_approx);
    if (first == null) {
      unconfirmed('mortgage_payoff',
        'A loan was disclosed but no balance is on file. Order a payoff statement from ' +
        (intake.payoff_lender_name || 'the lender') + '.');
    } else {
      set('mortgage_payoff', first, FIGURE_SOURCES.SELLER_INTAKE,
        sourceLabel(FIGURE_SOURCES.SELLER_INTAKE, { date: intake.payoff_balance_as_of || intakeOn }),
        'Balance you reported' + (intake.payoff_balance_as_of ? ' as of ' + intake.payoff_balance_as_of : '') +
        '. Interest accrues daily until funding, so the lender\'s payoff statement will be higher than this.' +
        (intake.has_second_lien ? ' A second lien was disclosed and is NOT included in this figure.' : ''));
    }
  } else {
    unconfirmed('mortgage_payoff', 'Nobody has asked whether there is a loan on this property.');
  }

  // --- other liens ---
  if (intake.has_other_liens === true || num(intake.pid_assessment_balance) != null) {
    const total = sum([num(intake.other_liens_amount), num(intake.pid_assessment_balance)]);
    if (total == null) {
      unconfirmed('other_liens_payoff',
        'Liens or claims were disclosed but not priced: ' + (intake.other_liens_details || 'no detail on file') + '.');
    } else {
      set('other_liens_payoff', total, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
        intake.other_liens_details || null);
    }
  } else if (intake.has_other_liens === false) {
    set('other_liens_payoff', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'You told us there are no other liens or claims. The title commitment is what proves it.');
  }

  // --- property tax (¶13) ---
  const tax = resolvePropertyTaxProration(intake, closingDate);
  set('property_tax_proration', tax.amount, tax.source, tax.label, tax.note);

  // --- HOA ---
  if (intake.hoa_exists === false) {
    set('hoa_fees', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake, 'You told us there is no HOA.');
  } else if (intake.hoa_exists === true) {
    const sellerPays = (payer) => payer === 'seller' || payer === 'split';
    const parts = [];
    const missing = [];
    if (sellerPays(intake.hoa_resale_certificate_payer)) {
      const v = num(intake.hoa_resale_certificate_fee);
      if (v == null) missing.push('resale certificate fee');
      else parts.push(intake.hoa_resale_certificate_payer === 'split' ? v / 2 : v);
    }
    if (sellerPays(intake.hoa_transfer_fee_payer)) {
      const v = num(intake.hoa_transfer_fee);
      if (v == null) missing.push('transfer fee');
      else parts.push(intake.hoa_transfer_fee_payer === 'split' ? v / 2 : v);
    }
    const unpaid = num(intake.hoa_unpaid_assessments);
    if (unpaid != null) parts.push(unpaid);
    const capital = num(intake.hoa_capital_contribution);
    if (capital != null) parts.push(capital);

    if (intake.hoa_second_association === true) {
      missing.push('second (master) association fees — a separate resale certificate and transfer fee');
    }
    if (intake.hoa_resale_certificate_payer == null) missing.push('who pays the resale certificate');
    if (intake.hoa_transfer_fee_payer == null) missing.push('who pays the transfer fee');

    if (missing.length) {
      unconfirmed('hoa_fees',
        'HOA charges are not all on file — missing: ' + missing.join('; ') + '. Call ' +
        (intake.hoa_management_company || intake.hoa_name || 'the management company') + '.');
    } else {
      const who = intake.hoa_management_company || intake.hoa_name;
      set('hoa_fees', sum(parts) || 0, FIGURE_SOURCES.THIRD_PARTY_QUOTE,
        sourceLabel(FIGURE_SOURCES.THIRD_PARTY_QUOTE, { who: who || 'the association', date: intakeOn }),
        'The association sets these and can change them before closing.');
    }
  } else {
    unconfirmed('hoa_fees', 'Nobody has asked whether there is an HOA.');
  }

  // --- title / escrow ---
  const titleQuoted = num(intake.title_policy_cost_quoted);
  if (intake.title_policy_payer === 'buyer') {
    set('title_policy_cost', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'Buyer pays the owner\'s policy under the agreed terms (TREC ¶6.A).');
  } else if (titleQuoted != null) {
    set('title_policy_cost', intake.title_policy_payer === 'split' ? titleQuoted / 2 : titleQuoted,
      FIGURE_SOURCES.THIRD_PARTY_QUOTE, quoteLabel(titleCo),
      'Texas promulgates this premium by sale price, so it moves if the price moves.');
  } else {
    unconfirmed('title_policy_cost',
      'No owner\'s title policy premium on file. Texas promulgates the rate — ' +
      (titleCo || 'the title company') + ' can quote it exactly.');
  }

  const escrowParts = [
    num(intake.escrow_fee_quoted),
    num(intake.tax_certificate_fee_quoted),
    num(intake.deed_prep_fee_quoted),
    num(intake.recording_fees_quoted),
  ];
  const escrowNames = ['escrow fee', 'tax certificate', 'deed prep', 'recording'];
  if (escrowParts.every((p) => p == null)) {
    unconfirmed('escrow_fee',
      'No escrow, tax certificate, deed prep or recording fees on file' +
      (titleCo ? ' from ' + titleCo : ' — and no title company has been named') + '.');
  } else if (escrowParts.some((p) => p == null)) {
    // Deliberately NOT presented as a total. A partial sum shown as a total is
    // the $450 problem in a new outfit.
    unconfirmed('escrow_fee',
      'PARTIAL — only some closing fees have been quoted (missing ' +
      escrowNames.filter((_, i) => escrowParts[i] == null).join(', ') +
      '), so the total is not yet known. Quoted so far: $' + (sum(escrowParts) || 0).toFixed(2) +
      '. The real total is higher.');
  } else {
    set('escrow_fee', sum(escrowParts), FIGURE_SOURCES.THIRD_PARTY_QUOTE, quoteLabel(titleCo),
      'Escrow, tax certificate, deed prep and recording, as quoted.');
  }

  // --- survey (¶6.C) ---
  const newSurvey = num(intake.new_survey_cost_quoted);
  if (intake.has_existing_survey === true && intake.will_sign_t47 === 'yes') {
    set('survey_cost', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'You have an existing survey' + (intake.survey_date ? ' dated ' + intake.survey_date : '') +
      ' and will sign a T-47, so no new survey is expected. The buyer\'s lender can still require one.');
  } else if (intake.has_existing_survey === true && intake.will_sign_t47 === 'no') {
    if (newSurvey == null) {
      unconfirmed('survey_cost',
        'You will not sign a T-47, so the existing survey cannot be used and a new one is required under ¶6.C. No quote on file.');
    } else {
      set('survey_cost', newSurvey, FIGURE_SOURCES.THIRD_PARTY_QUOTE,
        sourceLabel(FIGURE_SOURCES.THIRD_PARTY_QUOTE, { who: 'a surveyor', date: intakeOn }),
        'New survey required under ¶6.C because the existing one cannot be certified with a T-47.');
    }
  } else if (intake.has_existing_survey === false) {
    if (newSurvey == null) unconfirmed('survey_cost', 'No existing survey and no new-survey quote on file.');
    else {
      set('survey_cost', newSurvey, FIGURE_SOURCES.THIRD_PARTY_QUOTE,
        sourceLabel(FIGURE_SOURCES.THIRD_PARTY_QUOTE, { who: 'a surveyor', date: intakeOn }),
        'No existing survey, so a new one is required under ¶6.C.');
    }
  } else {
    unconfirmed('survey_cost', 'Survey status has not been asked.');
  }

  // --- leased items (¶4.B) ---
  const leased = Array.isArray(intake.leased_items) ? intake.leased_items : [];
  const leasedTotal = num(intake.leased_items_payoff_total);
  if (leased.length === 0 && intake.leased_items != null) {
    set('leased_item_payoff', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'You told us nothing on the property is leased or financed (TREC ¶4.B).');
  } else if (leased.length > 0) {
    if (leasedTotal == null) {
      unconfirmed('leased_item_payoff',
        'Leased items disclosed (' + leased.map((l) => l && l.type).filter(Boolean).join(', ') +
        ') but no payoff total on file. A solar lease payoff is routinely five figures.');
    } else {
      set('leased_item_payoff', leasedTotal, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
        'Payoff for: ' + leased.map((l) => l && l.type).filter(Boolean).join(', ') +
        '. The lessor sets the final figure.');
    }
  }

  // --- home warranty ---
  if (intake.will_offer_home_warranty === 'no') {
    set('home_warranty_cap', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'You chose not to offer a home warranty. A buyer can still ask for one.');
  } else if (intake.will_offer_home_warranty === 'yes') {
    const cap = num(intake.home_warranty_cap);
    if (cap == null) unconfirmed('home_warranty_cap', 'You will offer a warranty but no cap has been set.');
    else {
      set('home_warranty_cap', cap, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
        'The cap you set. The actual reimbursement is whatever the buyer\'s policy costs, up to this.');
    }
  }

  // --- security deposit transfer ---
  const deposit = num(intake.security_deposit_held);
  if (intake.is_tenant_occupied === true) {
    if (deposit == null) {
      unconfirmed('other_credits',
        'Tenant-occupied but no security deposit amount on file — it transfers to the buyer at closing.');
    } else {
      set('other_credits', deposit, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
        'Security deposit transferred to the buyer at closing.');
    }
  }

  // --- FIRPTA ---
  if (intake.seller_is_us_person === 'no') {
    unconfirmed('firpta_withholding',
      'FIRPTA APPLIES: at least one seller is a foreign person. Withholding under 26 U.S.C. §1445 runs up to 15% of the ' +
      'GROSS sale price and is remitted at closing. The exact amount depends on the price, the buyer\'s intended use and ' +
      'any withholding certificate — that is a question for the title company and your CPA. Dossie will not estimate it.');
  } else if (intake.seller_is_us_person === 'yes') {
    set('firpta_withholding', 0, FIGURE_SOURCES.SELLER_INTAKE, fromIntake,
      'All sellers confirmed U.S. persons — no FIRPTA withholding.');
  } else {
    unconfirmed('firpta_withholding',
      'FIRPTA status has not been confirmed. If any seller is a foreign person, withholding can reach 15% of the gross sale price.');
  }

  return { values, sources, labels, notes };
}

// Completeness, for nudging at the listing appointment and for the dossier
// health strip. Counts the net-sheet-blocking answers only — not every field.
// Every key here gates a net sheet line: leave it blank and that line renders
// "not yet confirmed". Keep this list and the lines deriveNetSheetInputs() can
// mark NOT_CONFIRMED in agreement — a net sheet that flags a cost the intake
// checklist never asks about sends the agent looking for a question that does
// not exist. (has_other_liens was missing from this list and did exactly that.)
const BLOCKING_KEYS = [
  'payoff_status', 'has_other_liens', 'tax_annual_amount', 'tax_exemptions',
  'occupancy_status', 'hoa_exists', 'preferred_title_company',
  'has_existing_survey', 'will_offer_home_warranty', 'seller_is_us_person',
];

function intakeCompleteness(intake) {
  if (!intake) return { captured: 0, total: BLOCKING_KEYS.length, missing: BLOCKING_KEYS.slice() };
  const missing = BLOCKING_KEYS.filter((k) => {
    const v = intake[k];
    if (v == null || v === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
  return { captured: BLOCKING_KEYS.length - missing.length, total: BLOCKING_KEYS.length, missing };
}

const FIELD_KEYS = FIELDS.map((f) => f.key);
const FIELDS_BY_KEY = FIELDS.reduce((acc, f) => { acc[f.key] = f; return acc; }, {});

module.exports = {
  FIELDS,
  FIELD_KEYS,
  FIELDS_BY_KEY,
  FIGURE_SOURCES,
  sourceLabel,
  whenLabel,
  UNKNOWN_IS_NOT_ZERO,
  TAX_EXEMPTIONS,
  EXEMPTION_NAMES,
  exemptionList,
  OCCUPANCY,
  PAYER,
  LEASED_ITEM_TYPES,
  NOT_CAPTURED_ON_PURPOSE,
  BLOCKING_KEYS,
  deriveNetSheetInputs,
  resolvePropertyTaxProration,
  sellerTaxDays,
  intakeCompleteness,
};
