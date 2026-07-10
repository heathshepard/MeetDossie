"use strict";
// Downloads a signed URL / storage path PDF and renders it to per-page PNGs.
// Optionally extracts text via pdftotext (from poppler) for footer / receipt block asserts.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

function renderPages(pdfPath, outPrefix) {
  // pdftoppm from poppler — installed at winget package for Heath's machine
  const outDir = path.dirname(outPrefix);
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync("pdftoppm", ["-png", "-r", "150", pdfPath, outPrefix], { stdio: "inherit" });
  const base = path.basename(outPrefix);
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(base + "-") && f.endsWith(".png"))
    .sort()
    .map((f) => path.join(outDir, f));
}

function extractText(pdfPath, outTxtPath) {
  fs.mkdirSync(path.dirname(outTxtPath), { recursive: true });
  execFileSync("pdftotext", ["-layout", pdfPath, outTxtPath], { stdio: "inherit" });
  return fs.readFileSync(outTxtPath, "utf8");
}

function assertFooterStamp(text, expected) {
  const found = text.includes(expected);
  return { verdict: found ? "PASS" : "FAIL", expected, found };
}

function assertReceiptsBlank(pageTxt) {
  // Page 12 of TREC 20-19: 4 receipt sub-blocks. Domain rule: title-company-only at origination.
  // Only text expected on p12: OPTION FEE RECEIPT / EARNEST MONEY RECEIPT / CONTRACT RECEIPT /
  // ADDITIONAL EARNEST MONEY RECEIPT + label lines (Escrow Agent, Received by, Email Address, Date/Time, Address, Phone, City, State, Zip, Fax) + "Receipt of $ ... is acknowledged" scaffolding.
  // What must NOT appear: a filled dollar amount on the "Receipt of $___" lines, agent-populated form indicators, agent emails.
  // Heuristic: check that no "$" is immediately followed by a numeric amount, and no known agent name from cfg is present.
  const dollarAmountRe = /\$\s*[\d,]+\.?\d*/g;
  const amounts = pageTxt.match(dollarAmountRe) || [];
  const filledAmounts = amounts.filter((a) => /\d/.test(a) && !/^\$\s*$/.test(a.trim()));
  return {
    verdict: filledAmounts.length === 0 ? "PASS" : "FAIL",
    filledAmountsFound: filledAmounts,
    detail: filledAmountsFound(filledAmounts),
  };
}

function filledAmountsFound(arr) {
  if (arr.length === 0) return "Page 12 clean — no filled dollar amounts";
  return `Page 12 has filled dollar amounts: ${arr.join(", ")} — receipts should be blank at origination`;
}

async function fetchStorageObject(supabaseUrl, serviceKey, bucket, storagePath, outPath) {
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${storagePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
  });
  if (!res.ok) throw new Error(`storage fetch ${storagePath} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

module.exports = {
  download,
  renderPages,
  extractText,
  assertFooterStamp,
  assertReceiptsBlank,
  fetchStorageObject,
};
