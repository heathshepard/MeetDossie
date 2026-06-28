const fs = require("fs");
const { validate } = require("./trec-validator");
const rules = JSON.parse(fs.readFileSync("./trec-20-18-field-rules.json", "utf8"));

const goldenFiles = [
  "golden-case-conventional.json",
  "golden-case-cash.json",
  "golden-case-fha.json",
  "golden-case-va.json",
  "golden-case-seller.json",
  "golden-case-assumption.json",
];

let allPass = true;
console.log("=== GOLDEN CASES (each must PASS) ===");
for (const fn of goldenFiles) {
  const g = JSON.parse(fs.readFileSync("./" + fn, "utf8"));
  const r = validate(rules, g.assignments, g.intake);
  const issues = r.report.filter(x => x.status === "FAIL" || x.status === "UNMATCHED");
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${fn}  (filled ${Object.keys(r.fillable).length})`);
  if (!r.pass) { allPass = false; issues.forEach(i => console.log(`     ${i.status} ${i.fieldId} :: ${i.reason}`)); }
}

console.log("\n=== BROKEN CASE (must FAIL on each injected error) ===");
const broken = JSON.parse(fs.readFileSync("./golden-case-conventional.json", "utf8"));
broken.assignments.sales_price_total.value = "999,999.00";
broken.assignments.option_period_days.value = "seven";
broken.assignments.earnest_money_amount.value = "lots";
broken.assignments.accept_as_is_with_repairs = { value: true, confidence: 0.9 };
broken.assignments.add_seller_financing = { value: true, confidence: 0.9 };
broken.assignments.notice_buyer_email.confidence = 0.4;
const b = validate(rules, broken.assignments, broken.intake);
console.log("PASS:", b.pass, "(expected false)");
b.report.filter(x => x.status === "FAIL" || x.status === "UNMATCHED")
  .forEach(f => console.log(`  ${f.status}  ${f.fieldId} :: ${f.reason}`));

console.log("\n" + (allPass && !b.pass ? "ALL GOOD" : "REGRESSION - do not deploy"));
process.exit(allPass && !b.pass ? 0 : 1);
