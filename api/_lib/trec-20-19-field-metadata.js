// api/_lib/trec-20-19-field-metadata.js
//
// Field-metadata layer for TREC 20-19 (One to Four Family Residential
// Contract, Resale). Source of truth for label / tooltip / type / party /
// paragraph group used by the Phase 1 Interactive Form Editor.
//
// Data pipeline:
//   1) Fable5 auto-mapped 219 fields on TREC-Resale-Contract-*.pdf
//      (dossiesign_auto_map_runs, id='8e3bc446-eb01-43b9-8447-6da9de22bcc7').
//      Each row already has { name, type, page, x/y/w/h_pct, party, required,
//      paragraph, rationale }.
//   2) This module *enriches* each Fable5 row with a plain-English label and
//      TREC-paragraph-aware tooltip, then groups it into an editor section.
//
// We deliberately DO NOT ship the 219 rows inline — the API pulls them fresh
// from the cached run so the coord data stays in one place. This module only
// transforms + groups.
//
// CARTER draft 2026-07-11.

// Cached Fable5 run id for TREC 20-19. If Heath re-runs Fable5 on the newer
// 20-19 PDF, update this constant.
const TREC_20_19_FABLE5_RUN_ID = '8e3bc446-eb01-43b9-8447-6da9de22bcc7';

// DocuSeal template id for TREC 20-19.
const TREC_20_19_TEMPLATE_ID = '4996863';

// Field types the Phase 1 editor supports. Anything else is dropped (signature
// + initial live on the DocuSeal template, agent doesn't fill them).
const EDITOR_TYPES = new Set(['text', 'currency', 'number', 'date', 'checkbox', 'radio', 'phone', 'email']);
const SIGNER_TYPES = new Set(['signature', 'initial']);

// Type coercion from Fable5's raw type to the editor's canonical types.
function coerceType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (t === 'currency' || t === 'money') return 'currency';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'date') return 'date';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'phone') return 'phone';
  if (t === 'email') return 'email';
  return 'text';
}

// TREC paragraph groups → editor sections. Progressive disclosure order: first
// two sections open by default, rest collapsed. Anything routed to an unknown
// paragraph lands in the 'other' catch-all — reported to Heath, never silently
// hidden per behavioral rule #5.
const SECTION_ORDER = [
  'parties',
  'sales_price',
  'property',
  'financing',
  'earnest_money',
  'title',
  'survey',
  'poa',
  'notices',
  'disclosure',
  'property_condition',
  'closing_and_possession',
  'broker_disclosure',
  'expenses',
  'special_provisions',
  'notices_and_delivery',
  'agreement_of_parties',
  'consult_attorney',
  'execution',
  'broker_information',
  'receipts',
  'other',
];

const DEFAULT_OPEN_SECTIONS = new Set(['parties', 'sales_price']);

const SECTION_META = {
  parties:              { title: 'Parties',                 heading: '§1. PARTIES',                                description: 'Full legal names of Buyer and Seller.' },
  property:             { title: 'Property',                heading: '§2. PROPERTY',                               description: 'Legal description, address, exclusions.' },
  sales_price:          { title: 'Sales price',             heading: '§3. SALES PRICE',                            description: 'Cash portion, financed amount, total.' },
  financing:            { title: 'Leases + financing',      heading: '§4. LEASES / §5. FINANCING',                 description: 'Residential and natural resource leases, financing terms.' },
  earnest_money:        { title: 'Earnest money + option',  heading: '§5. EARNEST MONEY & TERMINATION OPTION',     description: 'Earnest money, additional earnest money, option fee + days.' },
  title:                { title: 'Title policy',            heading: '§6. TITLE POLICY & SURVEY',                  description: 'Title policy, exceptions, HOA membership.' },
  survey:               { title: 'Survey',                  heading: '§6C. SURVEY',                                description: 'Who provides survey and by when.' },
  poa:                  { title: 'Property owner association', heading: '§6E. MEMBERSHIP IN POA/HOA',              description: 'HOA membership disclosure.' },
  notices:              { title: 'Required notices',        heading: '§6E(11) REQUIRED NOTICES',                   description: 'Statutory notices attached to the contract.' },
  disclosure:           { title: 'Seller disclosure',       heading: '§7B. SELLER\'S DISCLOSURE NOTICE',           description: 'Delivery of the seller\'s disclosure notice.' },
  property_condition:   { title: 'Property condition',      heading: '§7D. ACCEPTANCE OF PROPERTY CONDITION',      description: 'Buyer\'s acceptance and repairs.' },
  closing_and_possession: { title: 'Closing + possession',  heading: '§9. CLOSING / §10. POSSESSION',              description: 'Closing date and possession terms.' },
  broker_disclosure:    { title: 'Broker disclosure',       heading: '§8A. BROKER OR SALES AGENT DISCLOSURE',      description: 'Broker relationship disclosure.' },
  expenses:             { title: 'Settlement expenses',     heading: '§12. SETTLEMENT AND OTHER EXPENSES',         description: 'Who pays what at closing.' },
  special_provisions:   { title: 'Special provisions',      heading: '§11. SPECIAL PROVISIONS',                    description: 'Non-boilerplate terms specific to this deal.' },
  notices_and_delivery: { title: 'Notices',                 heading: '§21. NOTICES',                               description: 'Delivery addresses for notices to Buyer and Seller.' },
  agreement_of_parties: { title: 'Agreement of parties',    heading: '§22. AGREEMENT OF PARTIES',                  description: 'Addenda attached to the contract.' },
  consult_attorney:     { title: 'Consult an attorney',     heading: '§23. CONSULT AN ATTORNEY',                   description: 'Attorney contact info for each party.' },
  execution:            { title: 'Effective date',          heading: 'EXECUTED (EFFECTIVE DATE)',                  description: 'Effective date recorded when both parties sign.' },
  broker_information:   { title: 'Broker information',      heading: 'BROKER INFORMATION',                         description: 'Broker license numbers, addresses, contact info, compensation.' },
  receipts:             { title: 'Receipts',                heading: 'OPTION / EARNEST MONEY / CONTRACT RECEIPTS', description: 'Title-company-only. Blank at contract origination.' },
  other:                { title: 'Other',                   heading: 'UNGROUPED FIELDS',                           description: 'Fields the auto-grouper could not place — report to Carter.' },
};

// Map a Fable5 paragraph string to an editor section id.
function paragraphToSection(paragraph) {
  const p = String(paragraph || '').trim().toUpperCase();
  if (!p) return 'other';

  if (/^1\.?\s*PARTIES/.test(p) || p === '1. PARTIES') return 'parties';

  // §2. PROPERTY subsections (2A land, 2D exclusions, etc.)
  if (/^2[A-D]\b/.test(p) || /^2\.\s*PROPERTY/.test(p) || p.includes('LAND') || p.includes('EXCLUSIONS')) return 'property';

  // §3. SALES PRICE + subsections (3A/3B/3C).
  if (/^3[A-C]?\.?\s*SALES/.test(p) || /^3[A-C]\b/.test(p)) return 'sales_price';

  // §4A residential leases, §4C natural resource leases.
  if (/^4[A-D]?\b/.test(p) || p.includes('LEASES')) return 'financing';

  // §5. EARNEST MONEY & TERMINATION OPTION.
  if (/^5A?\b/.test(p) || /^5B\.?\s*TERMINATION/.test(p) || p.includes('EARNEST') || p.includes('TERMINATION OPTION')) return 'earnest_money';

  // §6A title, §6C survey, §6D objections, §6E POA, §6E(11) notices.
  if (/^6E\(11\)/.test(p) || p.includes('REQUIRED NOTICES')) return 'notices';
  if (/^6E/.test(p) || p.includes('POA') || p.includes('MEMBERSHIP')) return 'poa';
  if (/^6C/.test(p) || p.includes('SURVEY')) return 'survey';
  if (/^6[ABD]/.test(p) || p.includes('TITLE POLICY') || p.includes('OBJECTIONS')) return 'title';

  // §7B seller disclosure, §7D property condition, §7H residential service.
  if (/^7B/.test(p) || p.includes('SELLER') && p.includes('DISCLOSURE')) return 'disclosure';
  if (/^7D/.test(p) || p.includes('PROPERTY CONDITION') || p.includes('ACCEPTANCE')) return 'property_condition';
  if (/^7[EH]/.test(p) || p.includes('SERVICE CONTRACT')) return 'property_condition';

  // §8. Broker disclosure.
  if (/^8A/.test(p) || p.includes('BROKER') && p.includes('DISCLOSURE') && !p.includes('COMPENSATION')) return 'broker_disclosure';

  // §9. CLOSING + §10. POSSESSION.
  if (/^9A/.test(p) || /^10A/.test(p) || p.includes('CLOSING') || p.includes('POSSESSION')) return 'closing_and_possession';

  // §11. Special provisions.
  if (/^11\b/.test(p) || p.includes('SPECIAL PROVISIONS')) return 'special_provisions';

  // §12. Settlement expenses.
  if (/^12/.test(p) || p.includes('SETTLEMENT') || p.includes('EXPENSES')) return 'expenses';

  // §21. Notices.
  if (/^21/.test(p) || p.includes('NOTICES') && !p.includes('REQUIRED NOTICES')) return 'notices_and_delivery';

  // §22. Agreement of parties (addenda).
  if (/^22/.test(p) || p.includes('AGREEMENT OF PARTIES')) return 'agreement_of_parties';

  // §23. Consult attorney.
  if (/^23/.test(p) || p.includes('CONSULT') || p.includes('ATTORNEY')) return 'consult_attorney';

  // Execution / signature block / effective date.
  if (p.includes('EFFECTIVE DATE') || p.includes('EXECUTED') || p === 'SIGNATURE BLOCK') return 'execution';

  // Broker information + compensation.
  if (p.includes('BROKER INFORMATION') || p.includes('BROKER COMPENSATION')) return 'broker_information';

  // All receipts (option, earnest money, contract, additional earnest money).
  if (p.includes('RECEIPT')) return 'receipts';

  // Page headers/footers we skip below in shouldIncludeField; safe fallback.
  return 'other';
}

// Skip page-header / page-footer / signature-block fields — the agent doesn't
// fill these. Also skips DocuSeal-managed signature + initial widgets.
function shouldIncludeField(fable5Field) {
  if (!fable5Field) return false;
  const rawType = String(fable5Field.type || '').toLowerCase();
  if (SIGNER_TYPES.has(rawType)) return false;
  if (!EDITOR_TYPES.has(rawType)) return false;

  const p = String(fable5Field.paragraph || '').toLowerCase();
  if (p.includes('header') || p.includes('footer')) return false;

  const name = String(fable5Field.name || '').toLowerCase();
  if (!name) return false;
  if (/^footer_/.test(name) || /^header_/.test(name)) return false;
  if (/_signature$|_initial$|_initials$/.test(name)) return false;

  return true;
}

// Snake_case → sentence-case-ish label. Only used when no override exists.
function humanizeName(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bhoa\b/gi, 'HOA')
    .replace(/\btrec\b/gi, 'TREC')
    .replace(/\bpoa\b/gi, 'POA')
    .replace(/\bmls\b/gi, 'MLS')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

// Overrides for the fields agents fill most often. Editor gets a
// plain-English label + a TREC-paragraph-derived tooltip. `hint` is optional
// helper text under the label. Anything not overridden gets humanizeName +
// paragraph as tooltip.
const FIELD_OVERRIDES = {
  buyer_name: {
    label: "Buyer's full legal name",
    hint: 'As it appears on their ID.',
    tooltip: '§1. PARTIES — Enter the Buyer\'s full legal name. Multiple buyers can be entered separated by commas; use "Buyer 2" on the co-buyer signature line.',
  },
  seller_name: {
    label: "Seller's full legal name",
    hint: 'As it appears on title.',
    tooltip: '§1. PARTIES — Enter the Seller\'s full legal name exactly as it appears on the current deed / title.',
  },
  property_address: {
    label: 'Property street address',
    tooltip: '§2A. LAND — The physical street address of the property being sold.',
  },
  legal_lot: {
    label: 'Lot',
    tooltip: '§2A. LAND — Lot number from the recorded plat.',
  },
  legal_block: {
    label: 'Block',
    tooltip: '§2A. LAND — Block number from the recorded plat.',
  },
  addition_name: {
    label: 'Subdivision / Addition',
    tooltip: '§2A. LAND — Recorded subdivision or addition name.',
  },
  county: {
    label: 'County',
    tooltip: '§2A. LAND — Texas county where the property is located.',
  },
  city_state_zip: {
    label: 'City, State, ZIP',
    tooltip: '§2A. LAND — City, state, and ZIP code of the property.',
  },
  exclusions: {
    label: 'Exclusions from sale',
    hint: 'Items the seller is keeping (e.g. curtains, mounted TVs).',
    tooltip: '§2D. EXCLUSIONS — Items that would normally convey with the property but are being excluded from the sale.',
  },
  sale_price: {
    label: 'Total sales price',
    tooltip: '§3C. SALES PRICE — Sum of cash portion + financed portion. Auto-calculated when both parts are entered.',
  },
  down_payment: {
    label: 'Cash portion (down payment)',
    tooltip: '§3A. SALES PRICE — Cash the Buyer will bring at closing.',
  },
  down_payment_amt: {
    label: 'Cash portion (down payment)',
    tooltip: '§3A. SALES PRICE — Cash the Buyer will bring at closing.',
  },
  loan_amount: {
    label: 'Financed portion',
    tooltip: '§3B. SALES PRICE — Amount the Buyer is financing.',
  },
  earnest_money: {
    label: 'Earnest money',
    tooltip: '§5A. Earnest money the Buyer will deposit with the title company after the effective date.',
  },
  earnest_money_form: {
    label: 'Earnest money form',
    hint: 'Wire, check, or cashier\'s check.',
    tooltip: '§5A. Method of delivering earnest money.',
  },
  option_fee: {
    label: 'Option fee',
    tooltip: '§5B. TERMINATION OPTION — Non-refundable fee that gives the Buyer the unrestricted right to terminate.',
  },
  option_days: {
    label: 'Option period (days)',
    tooltip: '§5B. TERMINATION OPTION — Number of days the Buyer has to inspect and terminate for any reason.',
  },
  closing_date: {
    label: 'Closing date',
    tooltip: '§9A. CLOSING — Target closing date.',
  },
  possession_date: {
    label: 'Possession date',
    tooltip: '§10A. BUYER\'S POSSESSION — Date the Buyer takes possession (typically at closing/funding).',
  },
  contract_effective_date: {
    label: 'Contract effective date',
    tooltip: 'EXECUTED (EFFECTIVE DATE) — Auto-populated when both parties sign; leave blank at contract origination.',
  },
  title_company: {
    label: 'Title company',
    tooltip: '§6A. TITLE POLICY — Title company issuing the owner policy of title insurance.',
  },
  title_company_address: {
    label: 'Title company address',
    tooltip: '§6A. TITLE POLICY — Address of the title company.',
  },
  title_officer_name: {
    label: 'Title officer / escrow agent name',
    tooltip: '§6A. TITLE POLICY — Person handling escrow at the title company.',
  },
  title_officer_email: {
    label: 'Title officer email',
    tooltip: '§6A. TITLE POLICY — Email for the escrow officer.',
  },
  title_officer_phone: {
    label: 'Title officer phone',
    tooltip: '§6A. TITLE POLICY — Phone for the escrow officer.',
  },
  hoa_exists: {
    label: 'Property is subject to mandatory HOA membership',
    tooltip: '§6E. MEMBERSHIP IN POA/HOA — Check if the property is in an HOA that requires mandatory membership. If checked, attach the HOA Addendum (36-11).',
  },
  hoa_name: {
    label: 'HOA name',
    tooltip: '§6E. MEMBERSHIP IN POA/HOA — Name of the mandatory HOA.',
  },
  hoa_description: {
    label: 'HOA description / notes',
    tooltip: '§6E. MEMBERSHIP IN POA/HOA — Any additional notes about the HOA (e.g. multiple associations).',
  },
  legal_description: {
    label: 'Full legal description',
    tooltip: '§2A. LAND — The property\'s full legal description as shown on title.',
  },
  funding_notice_days: {
    label: 'Funding notice period (days)',
    tooltip: 'Number of days after closing that funding will be delayed if required. Rare — leave blank for most deals.',
  },
  closing_statement_days: {
    label: 'Days to deliver closing statement',
    tooltip: '§9A. CLOSING — Days before closing the title company must deliver the settlement statement.',
  },
  possession: {
    label: 'Possession',
    tooltip: '§10A. BUYER\'S POSSESSION — When and how the Buyer takes possession.',
  },
  financing_days: {
    label: 'Financing contingency period (days)',
    tooltip: '§4B. THIRD PARTY FINANCING — Days after effective date to obtain financing approval.',
  },
  financing_type: {
    label: 'Financing type',
    tooltip: 'Overall financing structure: cash, conventional, VA, FHA, USDA, or seller financing.',
  },
  notes: {
    label: 'Title policy paid by / notes',
    tooltip: '§6A. TITLE POLICY — Who pays for the owner\'s title policy (Buyer or Seller). Also used for miscellaneous notes.',
  },
};

// Party normalization from the Fable5 label to editor party keys.
function normalizePartyForEditor(fable5Party) {
  const p = String(fable5Party || '').toLowerCase();
  if (p === 'buyer' || p === 'buyer_1') return 'buyer_1';
  if (p === 'buyer_2') return 'buyer_2';
  if (p === 'seller' || p === 'seller_1') return 'seller_1';
  if (p === 'seller_2') return 'seller_2';
  if (p === 'buyer_agent' || p === 'agent') return 'agent';
  if (p === 'title' || p === 'title_company') return 'title';
  if (p === 'either') return 'either';
  return 'either';
}

/**
 * Enrich a single Fable5 row into the editor's field object.
 * Returns null if the row should be excluded (headers, signatures, etc.).
 */
function enrichFable5Field(fable5Field, currentValue) {
  if (!shouldIncludeField(fable5Field)) return null;

  const name = fable5Field.name;
  const type = coerceType(fable5Field.type);
  const paragraph = fable5Field.paragraph || null;
  const section = paragraphToSection(paragraph);
  const override = FIELD_OVERRIDES[name] || null;

  const label = (override && override.label) || humanizeName(name);
  const tooltip = (override && override.tooltip)
    || (paragraph
      ? `${paragraph} — ${fable5Field.rationale || ''}`.trim()
      : (fable5Field.rationale || ''));
  const hint = override && override.hint ? override.hint : null;

  return {
    id: `20-19:${name}`,
    key: name,
    label,
    hint,
    tooltip,
    trec_paragraph: paragraph,
    section,
    type,
    party: normalizePartyForEditor(fable5Field.party),
    required: Boolean(fable5Field.required),
    page: fable5Field.page || null,
    x_pct: fable5Field.x_pct != null ? Number(fable5Field.x_pct) : null,
    y_pct: fable5Field.y_pct != null ? Number(fable5Field.y_pct) : null,
    w_pct: fable5Field.w_pct != null ? Number(fable5Field.w_pct) : null,
    h_pct: fable5Field.h_pct != null ? Number(fable5Field.h_pct) : null,
    value: currentValue == null ? '' : String(currentValue),
    autoFilledValue: currentValue == null ? null : String(currentValue),
    source: currentValue == null || currentValue === '' ? 'blank' : 'auto',
  };
}

/**
 * Group enriched fields into the editor section structure. Returns:
 *   [{ id, title, heading, description, defaultOpen, fields: [...] }, ...]
 * Sections are ordered per SECTION_ORDER. Empty sections are dropped.
 * Any field routed to 'other' is preserved so nothing is silently hidden.
 */
function groupFieldsIntoSections(fields) {
  const bySection = new Map();
  for (const f of fields) {
    if (!f) continue;
    const s = f.section || 'other';
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(f);
  }

  const sections = [];
  for (const sectionId of SECTION_ORDER) {
    const list = bySection.get(sectionId);
    if (!list || list.length === 0) continue;
    const meta = SECTION_META[sectionId] || { title: sectionId, heading: sectionId, description: '' };
    // Sort fields inside a section by page then y_pct so they appear in the
    // order they land on the paper form.
    list.sort((a, b) => {
      if ((a.page || 0) !== (b.page || 0)) return (a.page || 0) - (b.page || 0);
      return (a.y_pct || 0) - (b.y_pct || 0);
    });
    sections.push({
      id: sectionId,
      title: meta.title,
      heading: meta.heading,
      description: meta.description,
      defaultOpen: DEFAULT_OPEN_SECTIONS.has(sectionId),
      fields: list,
    });
  }
  return sections;
}

module.exports = {
  TREC_20_19_FABLE5_RUN_ID,
  TREC_20_19_TEMPLATE_ID,
  enrichFable5Field,
  groupFieldsIntoSections,
  paragraphToSection,
  SECTION_ORDER,
  SECTION_META,
  DEFAULT_OPEN_SECTIONS,
  FIELD_OVERRIDES,
};
