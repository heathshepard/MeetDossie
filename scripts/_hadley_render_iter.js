// Hadley gate harness — render the 4 v3-FHA PDFs using fill-form.js handlers DIRECTLY.
// Bypasses auth/Supabase. Produces 4 PDFs into C:\tmp\hadley-gate\iterN\
// Then prints AcroForm /V dump (before flatten) for verification.

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// Pull handlers from fill-form.js by re-requiring its module-scoped state.
// fill-form.js doesn't export individual fillers — we'll inline the call by
// requiring the module and invoking via fillForm() composition. Easier:
// duplicate the fillForm dispatcher here in test mode (no flatten so we can dump /V).

const ITER = parseInt(process.argv[2] || '1', 10);
const OUTDIR = path.join('C:\\tmp\\hadley-gate', 'iter' + ITER);
fs.mkdirSync(OUTDIR, { recursive: true });

// v3-FHA canonical field_values, computed from master prompt
// Today = 2026-06-27, 30 days out = 2026-07-27
const today = new Date('2026-06-27T00:00:00Z');
const closing = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
const closingISO = closing.toISOString().slice(0, 10);

const FV = {
  // Parties
  buyer_name: 'Heath Shepard',
  seller_name: 'Josh Sissam',

  // Property
  property_address: '123 Main St',
  city_state_zip: 'Boerne, TX 78006',
  county: 'Kendall',

  // §3 Sales price / financing
  sale_price: 500000,
  down_payment_amt: 17500,
  down_payment_pct: 3.5,
  loan_amount: 482500,
  financing_type: 'fha',
  financing_fha: true,

  // §5 Earnest money + option
  earnest_money: 5000,
  option_fee: 100,
  option_days: 10,
  option_period_days: 10,

  // §6 Title
  title_company: 'Kendall County Abstract',
  // address: 204 E San Antonio Ave, Boerne, TX 78006
  escrow_agent_name: 'Ashley Phiffer',
  title_seller_pays: true,

  // §9 Closing
  closing_date: closingISO,
  contract_effective_date: '2026-06-27',

  // §10 Possession
  // at closing

  // §22 Addendums
  financing_addendum: true,
  addendum_lead_paint: true,
  hoa_exists: true,
  hoa_name: 'Cibolo Canyons',
  hoa_phone: '',

  // §11 Special provisions (blank)

  // §12 Settlement / Home warranty
  service_contract_amount: 500,

  // §22 financing-type-driven flags
  // (handled by ft='fha')

  // Seller concessions
  seller_concessions: 5000,

  // Brokerage / agents
  listing_agent_name: 'Bizzy Darling',
  listing_agent_license: '123964',
  listing_broker_firm: 'Phyllis Browning Company',
  listing_broker_city: 'Boerne',
  // Heath as buyer's agent + buyer (self)
  selling_agent_name: 'Heath Shepard',
  other_broker_firm: '',
  buyer_only_agent: true,

  // Year built (drives lead paint trigger upstream — here just metadata)
  year_built: 1972,

  // HOA addendum data
  hoa_transfer_fee: 200,

  // Lead paint addendum
  lead_paint_date: '2026-06-27',
};

// Resale-specific FHA-required fields (since financing-addendum has FHA box)
const FV_FINANCING = Object.assign({}, FV, {
  fha_loan_section: '',
});

const FV_HOA = Object.assign({}, FV, {
  hoa_transfer_fee: 200,
});

const FV_LEAD = Object.assign({}, FV);

// Now load each base64 asset and call its filler.
// We replicate the dispatcher but DO NOT flatten — so we can dump /V.
const ASSETS = {
  'resale-contract':     { file: 'trec-resale-base64.js', fv: FV },
  'financing-addendum':  { file: 'trec-financing-base64.js', fv: FV_FINANCING },
  'hoa-addendum':        { file: 'trec-hoa-addendum-base64.js', fv: FV_HOA },
  'lead-paint-addendum': { file: 'trec-lead-paint-base64.js', fv: FV_LEAD },
};

// fill-form.js exports a handler, not the per-form fillers. We need direct access.
// Use a require hack: load the module, then evaluate via internal closure access.
// Simpler approach — copy/paste the 4 filler functions inline. But the user wants
// LIVE code. So: pull them out via Function-string parsing.
// Cleanest: re-export them by patching fill-form.js once. But Heath needs the loop
// to test current code, so we patch with a small append that exposes the fillers.

// Strategy: temporarily inject `module.exports.__fillers` by reading the file
// and eval'ing in a sandbox. Better: read fill-form.js, append exports to a tmp
// copy, require the copy.
const fillFormPath = path.join(__dirname, '..', 'api', 'fill-form.js');
let src = fs.readFileSync(fillFormPath, 'utf8');

// Append per-form export
const patch = `

module.exports.__hadleyFillers = {
  'resale-contract':     fillResaleContract,
  'financing-addendum':  fillFinancingAddendum,
  'hoa-addendum':        fillHoaAddendum,
  'lead-paint-addendum': fillLeadPaintAddendum,
};
`;
const tmpPath = path.join(__dirname, '..', 'api', '_hadley_fill_form_export.js');
fs.writeFileSync(tmpPath, src + patch);

// Stub middleware reqs so require doesn't blow up at top-level (it requires env stuff)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
process.env.DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || 'stub';

let fillFormModule;
try {
  fillFormModule = require(tmpPath);
} catch (e) {
  console.error('Failed to load fill-form module:', e.message);
  process.exit(1);
}

const FILLERS = fillFormModule.__hadleyFillers;
if (!FILLERS) {
  console.error('Fillers not exposed');
  process.exit(1);
}

(async () => {
  const report = [];
  for (const [formType, cfg] of Object.entries(ASSETS)) {
    const assetPath = path.join(__dirname, '..', 'api', '_assets', cfg.file);
    const base64 = require(assetPath);
    const pdfBytes = Buffer.from(base64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const filler = FILLERS[formType];
    await filler(pdfDoc, cfg.fv);

    // Dump /V for every field BEFORE flatten (we want raw form data)
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    const dump = [];
    for (const f of fields) {
      const name = f.getName();
      const type = f.constructor.name;
      let v = '';
      try {
        if (type === 'PDFTextField') v = f.getText() || '';
        else if (type === 'PDFCheckBox') v = f.isChecked() ? 'CHECKED' : '';
        else if (type === 'PDFRadioGroup') v = f.getSelected() || '';
        else if (type === 'PDFDropdown') v = (f.getSelected() || []).join(',');
      } catch (e) { v = '<err: ' + e.message + '>'; }
      if (v) dump.push({ name, type, value: v });
    }
    const dumpPath = path.join(OUTDIR, formType + '.fields.json');
    fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));

    // Save unflattened for /V inspection
    const rawOut = await pdfDoc.save({ updateFieldAppearances: true });
    const rawPath = path.join(OUTDIR, formType + '.raw.pdf');
    fs.writeFileSync(rawPath, rawOut);

    // Force regenerate appearance streams: drop pre-baked AP dicts and call
    // updateFieldAppearances() so pdf-lib rebuilds them from current /V values.
    const { PDFName: PDFNameImport } = require('pdf-lib');
    for (const f of fields) {
      try {
        const widgets = f.acroField.getWidgets();
        for (const w of widgets) {
          try { w.dict.delete(PDFNameImport.of('AP')); } catch (e) {}
        }
      } catch (e) {}
    }
    try { form.updateFieldAppearances(); } catch (e) { console.warn('updateFieldAppearances failed:', e.message); }

    // Now FLATTEN (matches production /api/fill-form behavior)
    try { form.flatten(); } catch (e) { console.warn('flatten failed:', e.message); }
    const out = await pdfDoc.save();
    const outPath = path.join(OUTDIR, formType + '.pdf');
    fs.writeFileSync(outPath, out);

    report.push({ formType, pdfPath: outPath, filledFieldCount: dump.length });
    console.log(`[${formType}] filled ${dump.length} fields → ${outPath}`);
  }

  // Cleanup the patched tmp file
  try { fs.unlinkSync(tmpPath); } catch (e) {}

  console.log('\n=== iter' + ITER + ' done ===');
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
