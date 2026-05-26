// Smoke test for the fill logic baked into api/draft-amendment.js — pulls the
// fillTrec39_10 helper by re-importing the asset and replaying the same logic.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const TREC_39_10_BASE64 = require(path.join(__dirname, '..', 'api', '_assets', 'trec-39-10-base64.js'));

function formatLongDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

async function fill(amendmentType, newValue, notes) {
  const doc = await PDFDocument.load(Buffer.from(TREC_39_10_BASE64, 'base64'));
  const form = doc.getForm();
  form.getTextField('Street Address and City').setText('1847 Vintage Way, Boerne, TX 78006');
  form.getTextField('DATE OF FINAL ACCEPTANCE').setText(formatLongDate(new Date().toISOString().slice(0, 10)));
  if (amendmentType === 'closing_date') {
    form.getCheckBox('3 The date in Paragraph 9 of the contract is changed to').check();
    form.getTextField('date 5').setText(formatLongDate(newValue));
  } else if (amendmentType === 'option_extension') {
    form.getCheckBox('6 Buyer has paid Seller an additional Option Fee of').check();
    form.getTextField('for an extension of the').setText(`${newValue} days`);
  } else if (amendmentType === 'price_change') {
    form.getCheckBox('1 The Sales Price in Paragraph 3 of the contract is').check();
    form.getTextField('undefined_3').setText('$' + Number(newValue).toLocaleString('en-US'));
  }
  if (notes) {
    form.getCheckBox('9 Other Modifications Insert only factual statements and business details applicable to this sale').check();
    form.getTextField('Text 8').setText(notes.slice(0, 80));
  }
  form.flatten();
  const out = path.join(__dirname, 'trec-forms', `SMOKE-${amendmentType}.pdf`);
  fs.writeFileSync(out, await doc.save());
  console.log('Wrote', out, '(', fs.statSync(out).size, 'bytes)');
}

(async () => {
  await fill('closing_date', '2026-07-15', 'Closing pushed for buyer loan delay.');
  await fill('option_extension', '7', 'Inspection extension only.');
  await fill('price_change', '325000', 'Price reduced for repair credit.');
})();
