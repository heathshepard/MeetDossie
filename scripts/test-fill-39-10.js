// Test fill TREC 39-10 for each of the three amendment types Dossie supports.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'trec-forms', '39-10.pdf');

async function fillClosingDate() {
  const doc = await PDFDocument.load(fs.readFileSync(SRC));
  const form = doc.getForm();
  form.getTextField('Street Address and City').setText('1847 Vintage Way, Boerne, TX 78006');
  form.getCheckBox('3 The date in Paragraph 9 of the contract is changed to').check();
  // Closing date field row (y=506 / 505): `date 5` and `20_25`
  form.getTextField('date 5').setText('June 30, 2026');
  // `20_25` is the 2-digit year sometimes printed after "20__" — leave blank if "date 5" already includes year
  form.getTextField('DATE OF FINAL ACCEPTANCE').setText(new Date().toLocaleDateString('en-US'));
  fs.writeFileSync(path.join(__dirname, 'trec-forms', 'TEST-closing-date.pdf'), await doc.save());
}

async function fillOptionExtension() {
  const doc = await PDFDocument.load(fs.readFileSync(SRC));
  const form = doc.getForm();
  form.getTextField('Street Address and City').setText('1847 Vintage Way, Boerne, TX 78006');
  form.getCheckBox('6 Buyer has paid Seller an additional Option Fee of').check();
  form.getTextField('as follows').setText('$200');
  form.getTextField('for an extension of the').setText('7 days');
  form.getTextField('contract').setText('Option period');
  form.getCheckBox('Fee').check(); // "will be credited"
  form.getTextField('DATE OF FINAL ACCEPTANCE').setText(new Date().toLocaleDateString('en-US'));
  fs.writeFileSync(path.join(__dirname, 'trec-forms', 'TEST-option-extension.pdf'), await doc.save());
}

async function fillPriceChange() {
  const doc = await PDFDocument.load(fs.readFileSync(SRC));
  const form = doc.getForm();
  form.getTextField('Street Address and City').setText('1847 Vintage Way, Boerne, TX 78006');
  form.getCheckBox('1 The Sales Price in Paragraph 3 of the contract is').check();
  // Sales price has 3 numbered components — fill the total in 'undefined_3' (last/bottom row)
  form.getTextField('undefined').setText('$60,000');     // cash
  form.getTextField('undefined_2').setText('$240,000');  // financing
  form.getTextField('undefined_3').setText('$300,000');  // total
  form.getTextField('DATE OF FINAL ACCEPTANCE').setText(new Date().toLocaleDateString('en-US'));
  fs.writeFileSync(path.join(__dirname, 'trec-forms', 'TEST-price-change.pdf'), await doc.save());
}

(async () => {
  await fillClosingDate();
  await fillOptionExtension();
  await fillPriceChange();
  console.log('Wrote TEST-closing-date.pdf, TEST-option-extension.pdf, TEST-price-change.pdf');
})();
