const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  console.log('Phase 1: Diagnostic Render');
  console.log('============================\n');
  
  // Load the PDF
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  console.log(`Loaded PDF with ${fields.length} fields\n`);
  
  // For each field, set its value = its own field name (diagnostic mode)
  let setCount = 0;
  let skipCount = 0;
  
  fields.forEach((field, idx) => {
    try {
      const name = field.getName();
      if (name) {
        // Try to set the field value to its own name
        try {
          if (field.getType && field.getType().includes('Check')) {
            // Checkbox: set to false (unchecked) for visibility
            field.updateAppearances();
          } else {
            // Text field: set value to field name itself
            field.setText(name);
          }
          setCount++;
        } catch (e) {
          console.log(`[SKIP] Field ${idx} "${name}": ${e.message}`);
          skipCount++;
        }
      }
    } catch (e) {
      // Field name extraction failed
    }
  });
  
  console.log(`Set ${setCount} fields to their own names`);
  console.log(`Skipped ${skipCount} fields\n`);
  
  // Flatten and save
  form.flatten();
  const pdfBytes2 = await pdf.save();
  fs.writeFileSync('.tmp-20-18-diagnostic.pdf', pdfBytes2);
  
  console.log('Saved diagnostic render to: .tmp-20-18-diagnostic.pdf');
  console.log('\nNext: Convert to PNG and view each page');
})().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
