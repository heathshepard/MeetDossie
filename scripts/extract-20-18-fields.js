const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const pdfBytes = fs.readFileSync('api/_assets/trec-20-18-raw.pdf');
  const pdf = await PDFDocument.load(pdfBytes);
  
  const form = pdf.getForm();
  const fields = form.getFields();
  
  console.log(`Total fields: ${fields.length}`);
  console.log('\n=== NAMED FIELDS ===');
  
  const named = [];
  fields.forEach((field, idx) => {
    try {
      const name = field.getName();
      if (name) {
        named.push({ index: idx, name, type: field.constructor.name });
      }
    } catch (e) {
      // unnamed
    }
  });
  
  named.forEach(f => {
    console.log(`[${f.index}] ${f.name} (${f.type})`);
  });
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Named fields: ${named.length}`);
  console.log(`Unnamed fields: ${fields.length - named.length}`);
  
  // Save to JSON for processing
  fs.writeFileSync('scripts/.trec-20-18-field-names.json', JSON.stringify({
    total: fields.length,
    named: named.length,
    unnamed: fields.length - named.length,
    fields: named
  }, null, 2));
  
  console.log('\nSaved to scripts/.trec-20-18-field-names.json');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
