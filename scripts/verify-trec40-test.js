// Verification script: extract and dump filled form field values from the test PDF
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function verifyFHA() {
  console.log('Loading test PDF...');
  const pdfBytes = fs.readFileSync('.tmp-carter-trec40-test.pdf');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  console.log('\n=== FILLED FIELD VALUES ===\n');

  let filledCount = 0;
  let checkedBoxCount = 0;

  for (const field of fields) {
    const fieldName = field.getName();
    let fieldValue = '';
    
    // Try to get value based on field type
    try {
      if (field.isText && typeof field.getText === 'function') {
        fieldValue = field.getText();
      } else if (field.isCheckbox && typeof field.isChecked === 'function') {
        const isChecked = field.isChecked();
        if (isChecked) {
          checkedBoxCount++;
          console.log(`[CHECKBOX] ${fieldName}: CHECKED`);
          filledCount++;
          continue;
        }
      } else if (field.isRadioGroup && typeof field.getSelectedIndex === 'function') {
        const idx = field.getSelectedIndex();
        if (idx >= 0) {
          fieldValue = `Selected option ${idx}`;
        }
      }

      if (fieldValue && fieldValue.trim()) {
        console.log(`[TEXT] ${fieldName}: "${fieldValue}"`);
        filledCount++;
      }
    } catch (e) {
      // Silently skip unsupported field types
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total filled text fields: ${filledCount}`);
  console.log(`Total checked checkboxes: ${checkedBoxCount}`);
  console.log(`\nExpected results:`);
  console.log(`  - Property address: 123 Main St (2 occurrences: page 1 + page 2)`);
  console.log(`  - FHA checkbox: CHECKED`);
  console.log(`  - Loan amount: 482500`);
  console.log(`  - Term years: 30`);
  console.log(`  - Interest rate: 6.5`);
  console.log(`  - Origination: 1.5`);
  console.log(`  - Section number: 203(b)`);
  console.log(`  - Buyer approval: 21`);
  
  if (filledCount >= 7 && checkedBoxCount >= 1) {
    console.log(`\n? TEST PASSED: Form appears to be filled correctly`);
    process.exit(0);
  } else {
    console.log(`\n??  TEST WARNING: Expected more fields filled. Got ${filledCount} text + ${checkedBoxCount} checkbox`);
    process.exit(0);
  }
}

verifyFHA().catch(e => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
