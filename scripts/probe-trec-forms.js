// scripts/probe-trec-forms.js
// Downloads (or reads locally) each TREC form PDF and reports AcroForm fields.
// Run: node scripts/probe-trec-forms.js

const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const FORMS = [
  {
    name: 'TREC 20-16 (1-4 Family Contract)',
    // Use local copy if available (we already have the field list from inspect_resale_fields.py)
    localPath: path.join(__dirname, 'trec-forms', '20-17.pdf'),
    url: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/20-16.pdf',
    trec_number: '20-16',
  },
  {
    name: 'TREC 40-9 (Third Party Financing Addendum)',
    localPath: path.join(__dirname, 'trec-forms', '40-9.pdf'),
    url: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/40-9.pdf',
    trec_number: '40-9',
  },
  {
    name: 'TREC 36-8 (HOA Addendum)',
    localPath: null,
    url: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/36-8.pdf',
    trec_number: '36-8',
  },
  {
    name: 'TREC 38-7 (Buyer Rep Agreement)',
    localPath: null,
    url: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/38-7.pdf',
    trec_number: '38-7',
  },
  {
    name: 'TREC OP-K (Info About Brokerage Services)',
    localPath: path.join(__dirname, 'trec-forms', 'OP-H.pdf'),
    url: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/OP-K.pdf',
    trec_number: 'OP-K',
  },
  {
    name: 'HUD Lead-Based Paint Disclosure',
    localPath: null,
    url: 'https://www.hud.gov/sites/documents/DOC_11704.PDF',
    trec_number: 'HUD-LBP',
  },
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const chunks = [];
    proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DossieBot/1.0)',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function probeForm(form) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FORM: ${form.name} (${form.trec_number})`);
  console.log('='.repeat(60));

  let pdfBytes;
  if (form.localPath && fs.existsSync(form.localPath)) {
    console.log(`Using local: ${form.localPath}`);
    pdfBytes = fs.readFileSync(form.localPath);
  } else {
    console.log(`Fetching: ${form.url}`);
    try {
      pdfBytes = await fetchUrl(form.url);
      console.log(`Downloaded: ${pdfBytes.length} bytes`);
    } catch (e) {
      console.log(`FETCH FAILED: ${e.message}`);
      return { name: form.name, trec_number: form.trec_number, error: e.message };
    }
  }

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e) {
    console.log(`PDF LOAD FAILED: ${e.message}`);
    return { name: form.name, trec_number: form.trec_number, error: `load failed: ${e.message}` };
  }

  const pageCount = pdfDoc.getPageCount();
  const page0 = pdfDoc.getPage(0);
  const { width, height } = page0.getSize();
  console.log(`Pages: ${pageCount}, Page0 size: ${width.toFixed(1)} x ${height.toFixed(1)} pts`);

  let pdfForm;
  let fields = [];
  try {
    pdfForm = pdfDoc.getForm();
    fields = pdfForm.getFields();
    console.log(`AcroForm: YES — ${fields.length} fields`);
  } catch (e) {
    console.log(`AcroForm: NO — ${e.message}`);
    return {
      name: form.name,
      trec_number: form.trec_number,
      acroform: false,
      pageCount,
      width: width.toFixed(1),
      height: height.toFixed(1),
    };
  }

  const fieldList = fields.map((f) => {
    const type = f.constructor.name;
    const name = f.getName();
    return { name, type };
  });

  fieldList.forEach(({ name, type }) => {
    console.log(`  [${type.padEnd(18)}] ${name}`);
  });

  return {
    name: form.name,
    trec_number: form.trec_number,
    acroform: true,
    pageCount,
    width: width.toFixed(1),
    height: height.toFixed(1),
    fieldCount: fieldList.length,
    fields: fieldList,
  };
}


async function main() {
  const results = [];
  for (const form of FORMS) {
    try {
      const result = await probeForm(form);
      results.push(result);
    } catch (e) {
      console.log(`UNEXPECTED ERROR for ${form.name}: ${e.message}`);
      results.push({ name: form.name, trec_number: form.trec_number, error: e.message });
    }
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name}: ERROR — ${r.error}`);
    } else if (r.acroform) {
      console.log(`${r.name}: AcroForm YES — ${r.fieldCount} fields`);
    } else {
      console.log(`${r.name}: FLAT PDF — ${r.pageCount} pages, ${r.width}x${r.height}pts`);
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
