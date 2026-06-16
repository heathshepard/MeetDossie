#!/usr/bin/env node
// Quinn — verify the 6 staging-filled PDFs by downloading them and
// inspecting text content using pdfjs-dist (ESM).
"use strict";

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
  let allText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(" ");
    allText += `\n=== PAGE ${i} (${pageText.length} chars) ===\n` + pageText + "\n";
  }
  return { text: allText, pages: doc.numPages };
}

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
  let textResult = { text: "", pages: 0 };
  try { textResult = await extractText(pdfPath); }
  catch (e) { textResult = { text: `[pdfjs error: ${e.message}]`, pages: 0 }; }
  const text = textResult.text;

  // Normalize text: collapse whitespace and also build a no-space version
  // (PDFs frequently split adjacent glyphs into separate text items, so
  // "Jane Doe" may render as "Jane" + "Doe" split by a space OR with no
  // space if drawn back-to-back).
  const textNorm = text.replace(/\s+/g, " ");
  const textNoSpace = text.replace(/\s+/g, "");

  function inText(needle) {
    if (!needle) return false;
    const s = String(needle);
    return textNorm.includes(s) || textNoSpace.includes(s.replace(/\s+/g, ""));
  }

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
    // For multi-word values, also try just the first word and a no-space variant
    if (v.length > 6) {
      candidates.push(v.split(/\s+/)[0]);
      candidates.push(v.replace(/\s+/g, ""));
    }
    const found = candidates.some(c => inText(c));
    checks.push({ field: k, value: v, found });
  }
  const foundCount = checks.filter(c => c.found).length;
  report.push({
    name: r.name,
    formType: r.formType,
    downloaded: true,
    pdfPath,
    pdfSize: sz,
    pages: textResult.pages,
    textLen: text.length,
    textPreview: text.replace(/\s+/g, " ").slice(0, 800).trim(),
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
  console.log(`  PDF size: ${r.pdfSize} bytes, ${r.pages} pages, text len: ${r.textLen}`);
  console.log(`  Fields verified in PDF text: ${r.fieldsFound}/${r.fieldsTotal}`);
  for (const c of r.checks) {
    console.log(`    ${c.found ? "OK " : "-- "} ${c.field}: ${String(c.value).slice(0,50)}`);
  }
}
