const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

const fixture = JSON.parse(fs.readFileSync('scripts/.trec-20-18-fixture.json', 'utf8'));

(async () => {
  console.log('Building comprehensive TREC 20-18 field mapping and fill plan\n');
  
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  // COMPREHENSIVE FIELD MAP
  // Manually map every TREC 20-18 field to its business data
  // These names are taken directly from the extracted field list
  
  const fieldFillMap = [
    // PAGE 1 - PARTIES & PROPERTY
    { pdf_name: '1 PARTIES The parties to this contract are', value: fixture.buyer_names[0], category: 'buyer1' },
    { pdf_name: 'Seller and', value: fixture.seller_names[0], category: 'seller1' },
    
    // PAGE 1 - PROPERTY DESCRIPTION
    { pdf_name: 'A LAND Lot', value: fixture.lot, category: 'property' },
    { pdf_name: 'Block', value: fixture.block, category: 'property' },
    { pdf_name: 'Addition City of', value: fixture.addition, category: 'property' },
    { pdf_name: 'County of', value: fixture.county, category: 'property' },
    { pdf_name: 'Texas known as', value: fixture.legal_description, category: 'property' },
    
    // PAGE 2 - EARNEST MONEY
    { pdf_name: 'earnest money of', value: fixture.earnest_money.toString(), category: 'earnest' },
    
    // PAGE 3 - CLOSING DATE
    { pdf_name: 'A The closing of the sale will be on or before', value: fixture.closing_date, category: 'dates' },
    { pdf_name: '20', value: '26', category: 'dates', note: 'year portion' },
    
    // PAGE 7 - PROPERTY ADDRESS BLOCK
    { pdf_name: 'Address of Property', value: fixture.property_address_line1, category: 'address' },
    { pdf_name: 'City', value: fixture.property_city || 'San Antonio', category: 'address' },
    { pdf_name: 'State', value: 'TX', category: 'address' },
    { pdf_name: 'Zip', value: '78201', category: 'address' },
    
    // PAGE 8 - BROKER INFORMATION
    { pdf_name: 'Listing Broker Firm', value: fixture.listing_broker_firm, category: 'broker' },
    { pdf_name: 'Listing Associates Name', value: fixture.listing_agent_name, category: 'broker' },
    { pdf_name: 'Selling Associates Name', value: fixture.selling_agent_name, category: 'broker' },
  ];
  
  // CHECKBOX MAP
  const checkboxMap = [
    { pdf_name: '2Within', checked: fixture.financing_type === 'conventional', category: 'financing' },
    { pdf_name: '1 Buyer accepts the Property As Is', checked: false, category: 'condition', note: 'normally false for repairs' },
    { pdf_name: '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the', checked: !fixture.repairs_required, category: 'condition' },
    { pdf_name: 'Third Party Financing Addendum', checked: fixture.third_party_financing_addendum, category: 'addenda' },
    { pdf_name: 'Addendum for Property Subject to', checked: fixture.hoa_addendum, category: 'addenda' },
  ];
  
  // Generate fill plan document
  const fillPlan = {
    total_fields: fields.length,
    planned_text_fills: fieldFillMap.length,
    planned_checkbox_sets: checkboxMap.length,
    text_fields: fieldFillMap,
    checkbox_fields: checkboxMap,
    critical_fields: [
      { name: '1 PARTIES The parties to this contract are', reason: 'buyer identity', expected: fixture.buyer_names[0] },
      { name: 'Seller and', reason: 'seller identity', expected: fixture.seller_names[0] },
      { name: 'A LAND Lot', reason: 'property location', expected: fixture.lot },
      { name: 'earnest money of', reason: 'consideration', expected: fixture.earnest_money.toString() },
      { name: 'A The closing of the sale will be on or before', reason: 'critical date', expected: fixture.closing_date },
    ]
  };
  
  fs.writeFileSync('scripts/.trec-20-18-fillplan.json', JSON.stringify(fillPlan, null, 2));
  
  console.log('Fill plan generated:');
  console.log(`  Text fields to fill: ${fieldFillMap.length}`);
  console.log(`  Checkboxes to set: ${checkboxMap.length}`);
  console.log(`  Total mapped: ${fieldFillMap.length + checkboxMap.length} of ${fields.length}`);
  console.log(`  Coverage: ${(((fieldFillMap.length + checkboxMap.length) / fields.length) * 100).toFixed(1)}%`);
  
  console.log('\nCritical fields to verify visually:');
  fillPlan.critical_fields.forEach(f => {
    console.log(`  - ${f.name} (${f.reason})`);
    console.log(`    Expected value: "${f.expected}"`);
  });
  
  console.log('\nFill plan saved to: scripts/.trec-20-18-fillplan.json');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
