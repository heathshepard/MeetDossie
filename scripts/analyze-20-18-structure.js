const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  console.log('Analyzing TREC 20-18 structure in detail...\n');
  
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  const form = pdf.getForm();
  const fields = form.getFields();
  
  const analysis = {
    total_fields: fields.length,
    text_fields: [],
    checkbox_fields: [],
    signature_fields: [],
    other_fields: []
  };
  
  fields.forEach((field, idx) => {
    const name = field.getName();
    const type = field.constructor.name;
    const fieldType = field.getType ? field.getType() : 'unknown';
    
    const info = {
      index: idx,
      name: name,
      type: type,
      fieldType: fieldType
    };
    
    if (type === 'PDFTextField') {
      analysis.text_fields.push(info);
    } else if (type === 'PDFCheckBox') {
      analysis.checkbox_fields.push(info);
    } else if (type === 'PDFSignature') {
      analysis.signature_fields.push(info);
    } else {
      analysis.other_fields.push(info);
    }
  });
  
  console.log(`Total fields: ${analysis.total_fields}`);
  console.log(`Text fields: ${analysis.text_fields.length}`);
  console.log(`Checkbox fields: ${analysis.checkbox_fields.length}`);
  console.log(`Signature fields: ${analysis.signature_fields.length}`);
  console.log(`Other fields: ${analysis.other_fields.length}`);
  
  fs.writeFileSync('scripts/.trec-20-18-structure.json', JSON.stringify(analysis, null, 2));
  
  // Print checkbox fields (these are the ones that failed in diagnostic)
  console.log('\n=== CHECKBOX FIELDS ===');
  analysis.checkbox_fields.forEach(cb => {
    console.log(`[${cb.index}] ${cb.name}`);
  });
  
  console.log('\n=== TEXT FIELDS WITH MAX LENGTH < 5 ===');
  analysis.text_fields.slice(0, 100).forEach(tf => {
    if (tf.name && tf.name.length >= 3) {
      console.log(`[${tf.index}] "${tf.name}" (len=${tf.name.length})`);
    }
  });
  
  console.log('\nAnalysis saved to: scripts/.trec-20-18-structure.json');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
