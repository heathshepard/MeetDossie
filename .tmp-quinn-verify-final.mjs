#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import https from "https";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const RESULTS_FILE = path.join(process.cwd(), ".tmp-quinn-fill-results-final.json");
const OUT_DIR = path.join(process.cwd(), ".tmp-quinn-pdfs-final");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (resp) => {
      if (resp.statusCode !== 200) { reject(new Error(`HTTP ${resp.statusCode}`)); return; }
      resp.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function extractCombined(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
  let combined = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    combined += content.items.map(it => it.str).join(" ") + " ";
  }
  return combined;
}

let raw = fs.readFileSync(RESULTS_FILE, "utf8");
let parsed = JSON.parse(raw);
if (typeof parsed === "string") parsed = JSON.parse(parsed);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const FORM_CHECKS = {
  "resale-contract": [
    { label: "buyer Jane Doe", any: ["Jane", "Doe"] },
    { label: "seller John Smith", any: ["John Smith"] },
    { label: "property 1247 Sample Way", any: ["1247 Sample"] },
    { label: "sale price $400,000", any: ["400,000", "400000"] },
    { label: "earnest $5,000", any: ["5,000", " 5000 "] },
    { label: "option fee $250", any: ["$250", " 250 "] },
    { label: "option days 7", any: [" 7 "] },
    { label: "closing 2026-07-15", any: ["07/15/2026", "7/15/2026"] },
    { label: "loan $320,000", any: ["320,000"] },
    { label: "title Stewart Title", any: ["Stewart"] },
  ],
  "financing-addendum": [
    { label: "buyer Jane Doe", any: ["Jane", "Doe"] },
    { label: "property 1247 Sample", any: ["1247 Sample"] },
    { label: "loan amount $320,000", any: ["320,000", "320000"] },
    { label: "interest rate 7.5", any: ["7.5"] },
  ],
  "termination-notice": [
    { label: "buyer Kim Paqueo", any: ["Kim", "Paqueo"] },
    { label: "seller Melinda Sanchez", any: ["Melinda", "Sanchez"] },
    { label: "property 311 Rilla Vista", any: ["311 Rilla", "Rilla Vista"] },
    { label: "contract effective 2026-05-15", any: ["05/15/2026", "5/15/2026"] },
    { label: "termination reason Paragraph 23", any: ["Paragraph 23"] },
  ],
  "new-home-incomplete": [
    { label: "buyer Brian Nguyen", any: ["Brian", "Nguyen"] },
    { label: "seller Sunshine Builders", any: ["Sunshine"] },
    { label: "property 456 Builder Blvd", any: ["456 Builder"] },
    { label: "sale price $525,000", any: ["525,000", "525000"] },
    { label: "earnest $7,500", any: ["7,500", "7500"] },
    { label: "option fee $300", any: ["$300", " 300 "] },
    { label: "option days 10", any: [" 10 "] },
    { label: "closing 2026-09-30", any: ["09/30/2026", "9/30/2026"] },
    { label: "loan $420,000", any: ["420,000", "420000"] },
  ],
  "new-home-complete": [
    { label: "buyer Mark Castillo", any: ["Mark", "Castillo"] },
    { label: "seller Hill Country Homes", any: ["Hill Country"] },
    { label: "property 789 Ranch Rd", any: ["789 Ranch"] },
    { label: "sale price $625,000", any: ["625,000", "625000"] },
    { label: "earnest $10,000", any: ["10,000", "10000"] },
    { label: "option fee $500", any: ["$500", " 500 "] },
    { label: "option days 7", any: [" 7 "] },
    { label: "closing 2026-08-15", any: ["08/15/2026", "8/15/2026"] },
    { label: "loan $500,000", any: ["500,000", "500000"] },
  ],
  "farm-ranch": [
    { label: "buyer Kevin Holt", any: ["Kevin", "Holt"] },
    { label: "seller Texas Land Holdings", any: ["Texas Land Holdings"] },
    { label: "county Blanco", any: ["Blanco"] },
    { label: "sale price $850,000", any: ["850,000", "850000"] },
    { label: "earnest $15,000", any: ["15,000", "15000"] },
    { label: "option fee $750", any: ["$750", " 750 "] },
    { label: "option days 14", any: [" 14 "] },
    { label: "closing 2026-10-01", any: ["10/01/2026", "10/1/2026"] },
    { label: "acreage 47.5", any: ["47.5"] },
    { label: "property 5402 Sample Park", any: ["5402"] },
  ],
};

const summary = [];
for (const r of parsed) {
  const pdfPath = path.join(OUT_DIR, `${r.formType}.pdf`);
  await download(r.pdfUrl, pdfPath);
  const combined = await extractCombined(pdfPath);
  const norm = combined.replace(/\s+/g, " ");
  const nospace = combined.replace(/\s+/g, "");

  function look(needle) { return norm.includes(needle) || nospace.includes(needle.replace(/\s+/g, "")); }

  const checks = FORM_CHECKS[r.formType] || [];
  let pass = 0;
  const detail = [];
  for (const c of checks) {
    const found = c.any.some(look);
    detail.push({ label: c.label, found });
    if (found) pass++;
  }
  summary.push({ name: r.name, formType: r.formType, pdfPath, pass, total: checks.length, allOk: pass === checks.length, detail });
  console.log(`\n=== ${r.name} (${r.formType}) ===`);
  for (const d of detail) console.log(`  ${d.found ? "OK " : "-- "} ${d.label}`);
  console.log(`  -> ${pass}/${checks.length} ${pass === checks.length ? "PASS" : "PARTIAL"}`);
}

fs.writeFileSync(
  path.join(process.cwd(), ".tmp-quinn-verify-final-report.json"),
  JSON.stringify(summary, null, 2)
);

console.log("\n=== OVERALL ===");
const overallPass = summary.filter(s => s.allOk).length;
console.log(`${overallPass}/${summary.length} forms 100% visual-verified`);
for (const s of summary) {
  const partial = s.pass < s.total ? " (partial " + s.pass + "/" + s.total + ")" : "";
  console.log(`  ${s.allOk ? "PASS" : "PARTIAL"} ${s.formType}${partial}`);
}
