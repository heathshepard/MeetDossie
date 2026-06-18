const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

// Load fixture
const fixture = JSON.parse(fs.readFileSync('scripts/.trec-20-18-fixture.json', 'utf8'));

(async () => {
  console.log('Phase 2: Realistic Render');
  console.log('===========================\n');
  
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  // Build a field map: field name -> business data
  // This is the critical mapping that must be verified visually
  
  const fieldMap = {
    // PARTIES
    "1 PARTIES The parties to this contract are": fixture.buyer_names[0],
    "Seller and": fixture.seller_names[0],
    
    // PROPERTY
    "A LAND Lot": fixture.lot,
    "Block": fixture.block,
    "Addition City of": fixture.addition,
    "County of": fixture.county,
    "Texas known as": fixture.legal_description.substring(0, 50),
    
    // PRICE
    "earnest money of": fixture.earnest_money.toString(),
    
    // DATES
    "A The closing of the sale will be on or before": fixture.closing_date,
    "20": fixture.closing_date.split('-')[0].substring(2),  // year last 2 digits
    
    // ADDRESSES
    "Address of Property": fixture.property_address_line1,
    "City": fixture.city,
    "State": "TX",
    "Zip": "78201",
    
    // CHECKBOXES - set deterministically
    "2Within": true,  // financing checkbox
    "1 Buyer accepts the Property As Is": false,
    "2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the": true,
  };
  
  let fillCount = 0;
  let errorCount = 0;
  
  fields.forEach((field, idx) => {
    const name = field.getName();
    const value = fieldMap[name];
    
    if (value !== undefined) {
      try {
        const type = field.constructor.name;
        
        if (type === 'PDFCheckBox') {
          // Set checkbox state
          if (value === true) {
            field.check();
          } else if (value === false) {
            field.uncheck();
          }
        } else if (type === 'PDFTextField') {
          // Truncate to field max length if needed
          const strVal = String(value);
          field.setText(strVal.substring(0, 100));
        }
        fillCount++;
      } catch (e) {
        console.log(`[ERROR] Field "${name}": ${e.message}`);
        errorCount++;
      }
    }
  });
  
  console.log(`Filled ${fillCount} fields from fixture`);
  console.log(`${errorCount} errors during fill`);
  console.log(`${fields.length - fillCount - errorCount} fields not mapped\n`);
  
  // Flatten and save
  form.flatten();
  const pdfBytes2 = await pdf.save();
  fs.writeFileSync('.tmp-20-18-realistic.pdf', pdfBytes2);
  
  console.log('Saved realistic render to: .tmp-20-18-realistic.pdf');
  console.log('\nNext: Convert to PNG and verify by eye');
})().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
