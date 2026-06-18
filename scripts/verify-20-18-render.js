const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  console.log('VERIFICATION: Checking rendered PDF values\n');
  
  // Load the realistic render
  const pdfBytes = fs.readFileSync('.tmp-20-18-realistic.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  const fixture = JSON.parse(fs.readFileSync('scripts/.trec-20-18-fixture.json', 'utf8'));
  
  // Build expected values map
  const expectedValues = {
    "1 PARTIES The parties to this contract are": fixture.buyer_names[0],
    "Seller and": fixture.seller_names[0],
    "A LAND Lot": fixture.lot,
    "Block": fixture.block,
    "Addition City of": fixture.addition,
    "County of": fixture.county,
    "Texas known as": fixture.legal_description.substring(0, 50),
    "earnest money of": fixture.earnest_money.toString(),
    "A The closing of the sale will be on or before": fixture.closing_date,
    "Address of Property": fixture.property_address_line1,
    "City": fixture.city,
  };
  
  console.log('Checking filled values...\n');
  
  const report = {
    checked: [],
    mismatches: [],
    blanks: [],
    total: 0
  };
  
  fields.forEach((field, idx) => {
    const name = field.getName();
    const type = field.constructor.name;
    
    if (expectedValues[name] !== undefined) {
      report.total++;
      
      try {
        let actual = null;
        
        if (type === 'PDFTextField') {
          actual = field.getText();
        } else if (type === 'PDFCheckBox') {
          actual = field.isChecked() ? 'CHECKED' : 'UNCHECKED';
        }
        
        const expected = expectedValues[name];
        const matches = String(actual) === String(expected);
        
        if (matches) {
          report.checked.push({
            field: name,
            value: actual
          });
        } else {
          report.mismatches.push({
            field: name,
            expected: expected,
            actual: actual
          });
        }
      } catch (e) {
        report.blanks.push({
          field: name,
          error: e.message
        });
      }
    }
  });
  
  console.log(`Checked: ${report.checked.length}`);
  console.log(`Mismatches: ${report.mismatches.length}`);
  console.log(`Blank/Error: ${report.blanks.length}`);
  
  if (report.mismatches.length > 0) {
    console.log('\n=== MISMATCHES ===');
    report.mismatches.forEach(m => {
      console.log(`FIELD: "${m.field}"`);
      console.log(`  Expected: ${m.expected}`);
      console.log(`  Actual: ${m.actual}`);
    });
  }
  
  if (report.blanks.length > 0) {
    console.log('\n=== BLANKS/ERRORS ===');
    report.blanks.forEach(b => {
      console.log(`FIELD: "${b.field}"\n  Error: ${b.error}`);
    });
  }
  
  fs.writeFileSync('scripts/.trec-20-18-verification-report.json', JSON.stringify(report, null, 2));
  
  console.log('\nVerification report saved to: scripts/.trec-20-18-verification-report.json');
  console.log('Status:', report.mismatches.length === 0 && report.blanks.length === 0 ? 'PASS' : 'FAIL');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
