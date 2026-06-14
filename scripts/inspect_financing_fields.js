const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function inspectFinancingFields() {
  try {
    const base64Data = require('../api/_assets/trec-financing-base64.js');
    const pdfBytes = Buffer.from(base64Data, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    console.log(`\n=== TREC 40 Financing Addendum - ${fields.length} fields ===\n`);

    fields.forEach((field) => {
      const name = field.getName();
      const type = field.constructor.name;
      const isTextField = type === 'PDFTextField';
      const isCheckBox = type === 'PDFCheckBox';
      const isRadioGroup = type === 'PDFRadioGroup';

      if (isTextField || isCheckBox || isRadioGroup) {
        console.log(`  [${type.replace('PDF', '')}] "${name}"`);
      }
    });

    console.log(`\nTotal fields: ${fields.length}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

inspectFinancingFields();
