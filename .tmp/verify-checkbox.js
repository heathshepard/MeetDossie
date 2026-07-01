const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  // Check the state of the "does not require" checkbox
  const doesNotField = form.getField('does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at');
  const doesField = form.getField('does');
  
  try {
    console.log('Resale cert checkboxes status:');
    console.log(`  "does": ${doesField.getValue()}`);
  } catch (e) {
    console.log(`  "does": not found or unchecked`);
  }
  
  try {
    console.log(`  "does not": ${doesNotField.getValue()}`);
  } catch (e) {
    console.log(`  "does not": not found or unchecked`);
  }
  
  // List all fields with 'does' in the name
  const fields = form.getFields();
  console.log('\nAll fields containing "does" or "require":');
  fields.forEach(f => {
    const name = f.getName();
    if (name.toLowerCase().includes('does') || name.toLowerCase().includes('require')) {
      console.log(`  - ${name}`);
    }
  });
})();
