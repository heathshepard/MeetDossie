const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  console.log('Building TREC 20-18 Field Map');
  console.log('==============================\n');
  
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  // Create a mapping of awkward PDF field names to semantic keys
  // This is for TREC 20-18 specifically
  
  const fieldMap = [];
  
  fields.forEach((field, idx) => {
    const name = field.getName();
    const type = field.constructor.name;
    
    let semanticKey = null;
    let category = null;
    let isCheckbox = type === 'PDFCheckBox';
    
    // Parse the form field name to infer semantic meaning
    // This is the critical mapping step
    
    // PARTIES section (Page 1)
    if (name.includes('PARTIES The parties to this contract are')) {
      semanticKey = 'buyer_name_1';
      category = 'parties';
    } else if (name === 'Seller and' || name.match(/^Seller and/)) {
      semanticKey = 'seller_name_1';
      category = 'parties';
    }
    
    // PROPERTY section (Page 1-2)
    else if (name === 'A LAND Lot') {
      semanticKey = 'lot_number';
      category = 'property';
    } else if (name === 'Block') {
      semanticKey = 'block_number';
      category = 'property';
    } else if (name === 'Addition City of') {
      semanticKey = 'addition_name';
      category = 'property';
    } else if (name === 'County of') {
      semanticKey = 'county_name';
      category = 'property';
    } else if (name === 'Texas known as') {
      semanticKey = 'legal_description';
      category = 'property';
    }
    
    // PURCHASE PRICE / EARNEST MONEY (Page 2)
    else if (name === 'earnest money of') {
      semanticKey = 'earnest_money_amount';
      category = 'consideration';
    }
    
    // FINANCING (Page 2)
    else if (name === 'B Sum of all financing described in the attached') {
      semanticKey = 'financing_checkbox';
      category = 'financing';
    } else if (name === '2Within' && isCheckbox) {
      semanticKey = 'financing_type_conventional';
      category = 'financing';
    }
    
    // CLOSING DATE (Page 3)
    else if (name === 'A The closing of the sale will be on or before') {
      semanticKey = 'closing_date';
      category = 'dates';
    } else if (name === '20' && !isCheckbox) {
      semanticKey = 'closing_year_short';
      category = 'dates';
    }
    
    // POSSESSION
    else if (name === 'possession date' || name.includes('possession')) {
      semanticKey = 'possession_date';
      category = 'dates';
    }
    
    // PROPERTY ADDRESS (Page 7)
    else if (name === 'Address of Property') {
      semanticKey = 'property_address';
      category = 'address';
    } else if (name === 'City' && !name.includes('City_')) {
      semanticKey = 'property_city';
      category = 'address';
    } else if (name === 'State' && !name.includes('State_')) {
      semanticKey = 'property_state';
      category = 'address';
    } else if (name === 'Zip' && !name.includes('Zip_')) {
      semanticKey = 'property_zip';
      category = 'address';
    }
    
    // BROKER INFO (Pages 7-9)
    else if (name === 'Listing Broker Firm') {
      semanticKey = 'listing_broker_name';
      category = 'broker';
    } else if (name === 'Listing Associates Name') {
      semanticKey = 'listing_agent_name';
      category = 'broker';
    } else if (name === 'Associates Name numb 1') {
      semanticKey = 'selling_agent_name';
      category = 'broker';
    }
    
    // ADDENDUM CHECKBOXES (Page 9)
    else if (name === 'Third Party Financing Addendum' && isCheckbox) {
      semanticKey = 'has_financing_addendum';
      category = 'addenda';
    } else if (name === 'Addendum for Property Subject to' && isCheckbox) {
      semanticKey = 'has_hoa_addendum';
      category = 'addenda';
    } else if (name === 'Addendum for Sellers Disclos' && isCheckbox) {
      semanticKey = 'has_sellers_disclosure';
      category = 'addenda';
    }
    
    // PROPERTY CONDITION (Page 4)
    else if (name === '1 Buyer accepts the Property As Is' && isCheckbox) {
      semanticKey = 'property_as_is';
      category = 'condition';
    } else if (name === '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the' && isCheckbox) {
      semanticKey = 'property_as_is_except';
      category = 'condition';
    }
    
    const entry = {
      index: idx,
      pdf_field_name: name,
      semantic_key: semanticKey,
      category: category,
      type: type
    };
    
    fieldMap.push(entry);
  });
  
  // Stats
  const mapped = fieldMap.filter(f => f.semantic_key).length;
  const unmapped = fieldMap.filter(f => !f.semantic_key).length;
  
  console.log(`Total fields: ${fieldMap.length}`);
  console.log(`Mapped: ${mapped}`);
  console.log(`Unmapped: ${unmapped}`);
  console.log(`Mapping coverage: ${((mapped / fieldMap.length) * 100).toFixed(1)}%`);
  
  // Save
  fs.writeFileSync('api/_assets/trec-20-18-fieldmap.json', JSON.stringify(fieldMap, null, 2));
  
  // Save summary by category
  const bycategory = {};
  fieldMap.forEach(f => {
    if (f.category) {
      if (!bycategory[f.category]) bycategory[f.category] = [];
      bycategory[f.category].push(f);
    }
  });
  
  console.log('\n=== BY CATEGORY ===');
  Object.keys(bycategory).sort().forEach(cat => {
    console.log(`${cat}: ${bycategory[cat].length} fields`);
  });
  
  console.log('\nField map saved to: api/_assets/trec-20-18-fieldmap.json');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
