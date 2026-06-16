// Test script: verify new coordinate calculation
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

const TREC_RESALE_B64 = require('./api/_assets/trec-resale-20-19-base64.js');
const FIELD_MAP_DOCUSEAL = require('./api/_assets/field-map-resale-docuseal.js');

async function main() {
  try {
    const raw = TREC_RESALE_B64;
    const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
    const pdfBytes = Buffer.from(base64, 'base64');
    
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    
    console.log(`Loaded PDF with ${pages.length} pages`);
    
    const testFv = {
      buyer_name: 'John Smith',
      seller_name: 'Jane Doe',
      property_address: '123 Oak Street',
      sale_price: '500000',
      earnest_money: '10000',
      option_days: '10',
      closing_date: '2026-07-15',
      title_company: 'Texas Title Company',
      county: 'Bexar',
    };
    
    function translateCanonicalToDocuSeal(fieldValues) {
      const docusealFields = { ...fieldValues };
      const translations = {
        'sale_price': 'sales_price',
        'earnest_money': 'earnest_money_amount',
        'option_days': 'option_period_days',
        'title_company': 'title_company_name',
      };
      for (const [canonical, docuseal] of Object.entries(translations)) {
        if (canonical in fieldValues && fieldValues[canonical] != null && fieldValues[canonical] !== '') {
          docusealFields[docuseal] = fieldValues[canonical];
          delete docusealFields[canonical];
        }
      }
      if ('title_company_name' in docusealFields && docusealFields.title_company_name) {
        docusealFields['escrow_agent_name'] = docusealFields['title_company_name'];
      }
      return docusealFields;
    }
    
    const translatedFv = translateCanonicalToDocuSeal(testFv);
    
    const page0 = pages[0];
    const { StandardFonts } = require('pdf-lib');
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    const X_OVERRIDES = {
      'seller_name': 10,  // placeholder — Heath will tune
    };

    const fieldsToTest = ['sales_price', 'earnest_money_amount', 'option_period_days', 'title_company_name', 'buyer_name', 'seller_name'];

    for (const fieldName of fieldsToTest) {
      const coord = FIELD_MAP_DOCUSEAL[fieldName];
      const value = translatedFv[fieldName];

      if (!coord || !value) {
        console.log(`SKIP: ${fieldName}`);
        continue;
      }

      const pageHeight = page0.getHeight();
      const pageWidth = page0.getWidth();

      // F4a calibration formula (2026-06-16)
      const fontSize = 10;
      const xOverride = X_OVERRIDES[fieldName] || 0;
      const x = (coord.x * pageWidth) + 5 + xOverride;
      const y_from_bottom = pageHeight - ((coord.y + coord.h / 2) * pageHeight) - fontSize / 4 + 3;

      page0.drawText(String(value), {
        x,
        y: y_from_bottom,
        size: fontSize,
        color: require('pdf-lib').rgb(0, 0, 0),
        font: helvetica,
      });

      const y_normalized_pdf = y_from_bottom / pageHeight;
      console.log(`DREW: ${fieldName} = "${value}" at x=${(x/pageWidth).toFixed(3)}, docuseal_y=${coord.y.toFixed(3)}, pdf_y=${y_normalized_pdf.toFixed(3)}`);
    }
    
    const pdfOutput = await pdfDoc.save();
    fs.writeFileSync('.tmp-carter-fix-r3-test-newformula.pdf', pdfOutput);
    console.log('Wrote .tmp-carter-fix-r3-test-newformula.pdf');
    
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
