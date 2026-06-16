// Test script: fill a resale contract PDF and render to PNG for visual inspection
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Load the base64 asset
const TREC_RESALE_B64 = require('./api/_assets/trec-resale-20-19-base64.js');
const FIELD_MAP_DOCUSEAL = require('./api/_assets/field-map-resale-docuseal.js');

async function main() {
  try {
    // Load PDF from base64
    const raw = TREC_RESALE_B64;
    const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
    const pdfBytes = Buffer.from(base64, 'base64');
    
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    
    console.log(`Loaded PDF with ${pages.length} pages`);
    
    // Create a test field values object (canonical names, as extract-form-fields would emit)
    const testFv = {
      buyer_name: 'John Smith',
      seller_name: 'Jane Doe',
      property_address: '123 Oak Street',
      sale_price: '500000',  // canonical name
      earnest_money: '10000',  // canonical name
      option_days: '10',  // canonical name
      closing_date: '2026-07-15',
      title_company: 'Texas Title Company',  // canonical name
      down_payment_amt: '100000',
      loan_amount: '400000',
      county: 'Bexar',
    };
    
    // Apply field translation (this is what our fix does)
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
    console.log('Translated field values:', Object.keys(translatedFv).filter(k => translatedFv[k]).slice(0, 10));
    
    // Draw on page 0
    const page0 = pages[0];
    const { StandardFonts } = require('pdf-lib');
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    const fieldsToTest = ['sales_price', 'earnest_money_amount', 'option_period_days', 'title_company_name', 'buyer_name', 'seller_name'];
    
    for (const fieldName of fieldsToTest) {
      const coord = FIELD_MAP_DOCUSEAL[fieldName];
      const value = translatedFv[fieldName];
      
      if (!coord || !value) {
        console.log(`SKIP: ${fieldName} (no coord or value)`);
        continue;
      }
      
      const pageHeight = page0.getHeight();
      const pageWidth = page0.getWidth();
      
      // OLD BUGGY FORMULA:
      // const y_old = pageHeight - (coord.y * pageHeight);
      
      // NEW FIXED FORMULA:
      const fontSize = 10;
      const fieldHeightPts = coord.h * pageHeight;
      const y_top_of_box = pageHeight - (coord.y * pageHeight);
      const y_baseline = y_top_of_box - fieldHeightPts + (fontSize * 0.3);
      
      const x = coord.x * pageWidth;
      
      page0.drawText(String(value), {
        x,
        y: y_baseline,
        size: fontSize,
        color: require('pdf-lib').rgb(0, 0, 0),
        font: helvetica,
      });
      
      console.log(`DREW: ${fieldName} = "${value}" at x=${(x/pageWidth).toFixed(3)}, y_box=${(coord.y).toFixed(3)}, y_drawn=${(y_baseline/pageHeight).toFixed(3)}`);
    }
    
    // Save the test PDF
    const pdfOutput = await pdfDoc.save();
    fs.writeFileSync('.tmp-carter-fix-r3-test.pdf', pdfOutput);
    console.log('Wrote .tmp-carter-fix-r3-test.pdf');
    
  } catch (e) {
    console.error('Error:', e.message, e.stack);
    process.exit(1);
  }
}

main();
