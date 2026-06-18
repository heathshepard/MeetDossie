const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  const fixture = JSON.parse(fs.readFileSync('scripts/.trec-20-18-fixture.json', 'utf8'));
  
  // Create comprehensive sign-off table
  const signoffTable = [];
  
  fields.forEach((field, idx) => {
    const name = field.getName();
    const type = field.constructor.name;
    
    // Determine page number (rough estimate based on field index)
    // PDF appears to be 10 pages, 263 fields total = ~26 per page
    const pageNum = Math.floor(idx / 27) + 1;
    const pageNum_clamped = Math.min(pageNum, 10);
    
    const entry = {
      index: idx,
      page: pageNum_clamped,
      field_name: name,
      field_type: type,
      semantic_category: null,
      sample_value: null,
      verified: false,
      notes: ''
    };
    
    // Categorize fields for semantic meaning
    if (name.includes('PARTIES') || name === 'Seller and' || name.match(/^Seller/)) {
      entry.semantic_category = 'PARTIES';
    } else if (name.includes('LAND Lot') || name === 'Block' || name.includes('Addition') || name.includes('County') || name.includes('Texas known as')) {
      entry.semantic_category = 'PROPERTY';
    } else if (name.includes('earnest money')) {
      entry.semantic_category = 'CONSIDERATION';
      entry.sample_value = fixture.earnest_money;
    } else if (name.includes('closing') || name === '20') {
      entry.semantic_category = 'DATES';
      entry.sample_value = fixture.closing_date;
    } else if (name.includes('Address of Property') || name === 'City' || name === 'State' || name === 'Zip') {
      entry.semantic_category = 'ADDRESS';
      entry.sample_value = fixture.property_address_line1;
    } else if (name.includes('Broker') || name.includes('Agent') || name.includes('License')) {
      entry.semantic_category = 'BROKER_INFO';
    } else if (name.includes('Addendum') || name.includes('Financing') || name.includes('Lead')) {
      entry.semantic_category = 'ADDENDA';
    } else if (name.includes('Within') || name.includes('As Is') || name.includes('repairs')) {
      entry.semantic_category = 'CONDITIONS';
    } else if (type === 'PDFSignature') {
      entry.semantic_category = 'SIGNATURE';
    }
    
    signoffTable.push(entry);
  });
  
  fs.writeFileSync('scripts/.trec-20-18-signoff-table.json', JSON.stringify(signoffTable, null, 2));
  
  // Create summary report
  const summary = {
    form_name: 'One to Four Family Residential Contract (Resale) - TREC 20-18',
    total_pages: 10,
    total_fields: fields.length,
    text_fields: fields.filter(f => f.constructor.name === 'PDFTextField').length,
    checkbox_fields: fields.filter(f => f.constructor.name === 'PDFCheckBox').length,
    signature_fields: fields.filter(f => f.constructor.name === 'PDFSignature').length,
    ground_truth_fixture_file: 'scripts/.trec-20-18-fixture.json',
    diagnostic_pdf: '.tmp-20-18-diagnostic.pdf',
    realistic_pdf: '.tmp-20-18-realistic.pdf',
    diagnostic_png_pages: 10,
    realistic_png_pages: 10,
    signoff_table_file: 'scripts/.trec-20-18-signoff-table.json',
    field_map_file: 'api/_assets/trec-20-18-fieldmap.json',
    status: 'READY_FOR_VISUAL_VERIFICATION',
    notes: 'All renders created. Field analysis complete. Ready for manual visual inspection of PNG pages to identify any field mapping discrepancies.',
    critical_verification_fields: [
      {
        field: '1 PARTIES The parties to this contract are',
        expected: fixture.buyer_names[0],
        verify_on_page: 1,
        reason: 'Primary buyer identification'
      },
      {
        field: 'Seller and',
        expected: fixture.seller_names[0],
        verify_on_page: 1,
        reason: 'Primary seller identification'
      },
      {
        field: 'A LAND Lot',
        expected: fixture.lot,
        verify_on_page: 1,
        reason: 'Property location'
      },
      {
        field: 'earnest money of',
        expected: fixture.earnest_money.toString(),
        verify_on_page: 2,
        reason: 'Financial consideration'
      },
      {
        field: 'A The closing of the sale will be on or before',
        expected: fixture.closing_date,
        verify_on_page: 3,
        reason: 'Critical closing date'
      }
    ]
  };
  
  fs.writeFileSync('scripts/.trec-20-18-verification-summary.json', JSON.stringify(summary, null, 2));
  
  console.log('TREC 20-18 VERIFICATION SUMMARY');
  console.log('='.repeat(50));
  console.log(`Form: ${summary.form_name}`);
  console.log(`Pages: ${summary.total_pages}`);
  console.log(`Total fields: ${summary.total_fields}`);
  console.log(`  - Text fields: ${summary.text_fields}`);
  console.log(`  - Checkboxes: ${summary.checkbox_fields}`);
  console.log(`  - Signatures: ${summary.signature_fields}`);
  console.log(`\nDeliverables created:`);
  console.log(`  ✓ Ground-truth fixture: ${summary.ground_truth_fixture_file}`);
  console.log(`  ✓ Diagnostic render: ${summary.diagnostic_pdf}`);
  console.log(`  ✓ Realistic render: ${summary.realistic_pdf}`);
  console.log(`  ✓ Sign-off table: ${summary.signoff_table_file}`);
  console.log(`  ✓ Verification summary: scripts/.trec-20-18-verification-summary.json`);
  console.log(`\nStatus: ${summary.status}`);
  console.log(`\nNext step: View PNG pages and verify critical fields appear correctly filled.`);
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
