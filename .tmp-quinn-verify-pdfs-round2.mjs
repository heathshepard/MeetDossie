#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import https from "https";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const RESULTS_FILE = path.join(process.cwd(), ".tmp-quinn-fill-results-round2.json");
const OUT_DIR = path.join(process.cwd(), ".tmp-quinn-pdfs-round2");

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

for (const r of parsed) {
  const pdfPath = path.join(OUT_DIR, `${r.formType}.pdf`);
  await download(r.pdfUrl, pdfPath);
  const combined = await extractCombined(pdfPath);
  const norm = combined.replace(/\s+/g, " ");
  const nospace = combined.replace(/\s+/g, "");

  function look(needle) {
    return norm.includes(needle) || nospace.includes(needle.replace(/\s+/g, ""));
  }

  console.log(`\n=== ${r.name} ===`);
  const ext = r.extracted;
  const checks = r.formType === "farm-ranch"
    ? [
      { label: "buyer Kevin Holt", any: ["Kevin", "Holt"] },
      { label: "seller Texas Land Holdings", any: ["Texas Land Holdings"] },
      { label: "county Blanco", any: ["Blanco"] },
      { label: "sale price $850,000", any: ["850,000", "850000"] },
      { label: "earnest money $15,000", any: ["15,000", "15000"] },
      { label: "option fee $750", any: ["$750", " 750 "] },
      { label: "option days 14", any: ["14"] },
      { label: "closing 2026-10-01", any: ["10/01/2026", "10/1/2026"] },
      { label: "acreage 47.5", any: ["47.5"] },
      { label: "property/address 5402 Sample Park", any: ["5402 Sample", "5402"] },
    ]
    : [
      { label: "buyer Mark Castillo", any: ["Mark", "Castillo"] },
      { label: "seller Hill Country Homes", any: ["Hill Country"] },
      { label: "property 789 Ranch Rd", any: ["789 Ranch"] },
      { label: "sale price $625,000", any: ["625,000", "625000"] },
      { label: "earnest money $10,000", any: ["10,000", "10000"] },
      { label: "option fee $500", any: ["$500", " 500 "] },
      { label: "option days 7", any: [" 7 "] },
      { label: "closing 2026-08-15", any: ["08/15/2026", "8/15/2026"] },
      { label: "loan amount $500,000", any: ["500,000", "500000"] },
    ];
  let pass = 0;
  for (const c of checks) {
    const found = c.any.some(look);
    console.log(`  ${found ? "OK " : "-- "} ${c.label}`);
    if (found) pass++;
  }
  console.log(`  -> ${pass}/${checks.length} checks passed`);
}
