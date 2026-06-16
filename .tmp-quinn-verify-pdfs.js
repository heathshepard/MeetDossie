#!/usr/bin/env node
// Quinn — verify the 6 staging-filled PDFs by downloading them and
// inspecting text content using pdfjs-dist.
//
// Usage: node .tmp-quinn-verify-pdfs.js
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const RESULTS_FILE = path.join(process.cwd(), ".tmp-quinn-fill-results.json");
const OUT_DIR = path.join(process.cwd(), ".tmp-quinn-pdfs");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (resp) => {
      if (resp.statusCode !== 200) {
        reject(new Error(`HTTP ${resp.statusCode} for ${url.slice(0,80)}`));
        return;
      }
      resp.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function extractText(pdfPath) {
  const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  let allText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(" ");
    allText += `\n=== PAGE ${i} ===\n` + pageText + "\n";
  }
  return allText;
}

(async () => {
  let raw = fs.readFileSync(RESULTS_FILE, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch (e) {
    console.error("Failed to parse results:", e.message);
    process.exit(1);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const report = [];
  for (const r of parsed) {
    const slug = r.formType;
    const pdfPath = path.join(OUT_DIR, `${slug}.pdf`);
    try {
      await download(r.pdfUrl, pdfPath);
    } catch (e) {
      report.push({ name: r.name, formType: r.formType, downloaded: false, error: e.message });
      continue;
    }
    const sz = fs.statSync(pdfPath).size;
    let text = "";
    try { text = await extractText(pdfPath); }
    catch (e) { text = `[pdfjs error: ${e.message}]`; }

    const checks = [];
    const ext = r.extracted || {};
    const candidateKeys = [
      "buyer_name", "seller_name", "property_address", "city_state_zip",
      "sale_price", "earnest_money", "option_fee", "option_days",
      "closing_date", "loan_amount", "down_payment_amt",
      "termination_reason", "contract_effective_date", "land_acreage",
      "builder_name", "title_company",
    ];
    for (const k of candidateKeys) {
      if (ext[k] == null) continue;
      const v = String(ext[k]);
      const candidates = [v, v.replace(/[,$]/g, "")];
      if (/^\d+(\.\d+)?$/.test(v)) candidates.push(Number(v).toLocaleString("en-US"));
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split("-");
        candidates.push(`${m}/${d}/${y}`);
        candidates.push(`${parseInt(m)}/${parseInt(d)}/${y}`);
      }
      // For names with multiple words, allow partial match (first 20 chars)
      if (v.length > 6) candidates.push(v.split(/\s+/)[0]);
      const found = candidates.some(c => c && text.includes(c));
      checks.push({ field: k, value: v, found });
    }
    const foundCount = checks.filter(c => c.found).length;
    report.push({
      name: r.name,
      formType: r.formType,
      downloaded: true,
      pdfPath,
      pdfSize: sz,
      textLen: text.length,
      textPreview: text.replace(/\s+/g, " ").slice(0, 500).trim(),
      fieldsTotal: checks.length,
      fieldsFound: foundCount,
      checks,
    });
  }

  fs.writeFileSync(
    path.join(process.cwd(), ".tmp-quinn-verify-report.json"),
    JSON.stringify(report, null, 2)
  );

  console.log("\n== QUINN PDF VERIFY REPORT ==");
  for (const r of report) {
    const ok = r.downloaded && r.fieldsFound > 0;
    console.log(`\n${ok ? "PASS" : "FAIL"} ${r.name} (${r.formType})`);
    if (!r.downloaded) { console.log(`  download error: ${r.error}`); continue; }
    console.log(`  PDF size: ${r.pdfSize} bytes, text len: ${r.textLen}`);
    console.log(`  Fields verified in PDF text: ${r.fieldsFound}/${r.fieldsTotal}`);
    for (const c of r.checks) {
      console.log(`    ${c.found ? "OK " : "-- "} ${c.field}: ${String(c.value).slice(0,50)}`);
    }
  }
})().catch(e => { console.error("fatal:", e.stack || e.message); process.exit(2); });
