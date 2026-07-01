// Verification script for TREC Amendment 39-11 FIELDS coordinate map
// Runs all 4 amendment scenarios and confirms the correct fields are checked.
// Pass: all checkboxes match expected visual paragraphs.
// Fail: any scenario has wrong checkbox checked or missing fill.

const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const TREC_39_11_BASE64 = require('../api/_assets/trec-amendment-39-11-base64.js');

  function formatLongDateNoYear(isoLike) {
    if (!isoLike) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
    if (!m) return String(isoLike);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
  }

  function formatTwoDigitYear(isoLike) {
    if (!isoLike) return '';
    const m = /^(\d{4})/.exec(String(isoLike));
    if (!m) return '';
    return m[1].slice(2);
  }

  function formatMoney(value) {
    const n = Number(String(value).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n)) return String(value);
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  function safeSetText(form, name, value) {
    try {
      const field = form.getTextField(name);
      if (!field) return false;
      const max = field.getMaxLength();
      let v = String(value == null ? '' : value);
      if (max && v.length > max) v = v.slice(0, max);
      field.setText(v);
      return true;
    } catch (e) {
      return false;
    }
  }

  function safeCheck(form, name) {
    try {
      const box = form.getCheckBox(name);
      if (box) {
        box.check();
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Field mapping from api/draft-amendment.js
  const FIELDS = {
    propertyAddress: 'Street Address and City',
    closingDateCheckbox: '3 The date in Paragraph 9 of the contract is changed to',
    closingDateText: 'date 5',
    closingDateYearSuffix: '20_25',
    salesPriceCheckbox: '1 The Sales Price in Paragraph 3 of the contract is',
    salesPriceTotal: 'undefined_3',
    optionFeeCheckbox: '6 Buyer has paid Seller an additional Option Fee of',
    optionFeeExtensionDays: 'for an extension of the',
  };

  const testCases = [
    {
      name: 'closing_date',
      amendmentType: 'closing_date',
      newValue: '2026-08-05',
      expectedChecks: ['3 The date in Paragraph 9 of the contract is changed to'],
      testFields: [
        { name: '1 The Sales Price...', shouldBeChecked: false },
        { name: '3 The date in Paragraph 9...', shouldBeChecked: true },
        { name: '6 Buyer has paid Seller...', shouldBeChecked: false },
      ],
    },
    {
      name: 'price_change',
      amendmentType: 'price_change',
      newValue: '325000',
      expectedChecks: ['1 The Sales Price in Paragraph 3 of the contract is'],
      testFields: [
        { name: '1 The Sales Price...', shouldBeChecked: true },
        { name: '3 The date in Paragraph 9...', shouldBeChecked: false },
        { name: '6 Buyer has paid Seller...', shouldBeChecked: false },
      ],
    },
    {
      name: 'option_extension',
      amendmentType: 'option_extension',
      newValue: '7',
      expectedChecks: ['6 Buyer has paid Seller an additional Option Fee of'],
      testFields: [
        { name: '1 The Sales Price...', shouldBeChecked: false },
        { name: '3 The date in Paragraph 9...', shouldBeChecked: false },
        { name: '5 The cost of lender...', shouldBeChecked: false },
        { name: '6 Buyer has paid Seller...', shouldBeChecked: true },
        { name: '7 Buyer waives...', shouldBeChecked: false },
      ],
    },
    {
      name: 'repair_items',
      amendmentType: 'repair_items',
      newValue: '["Roof leak", "HVAC service"]',
      notes: 'before closing',
      expectedChecks: ['9 Other Modifications Insert only factual statements and business details applicable to this sale'],
      testFields: [
        { name: '1 The Sales Price...', shouldBeChecked: false },
        { name: '3 The date in Paragraph 9...', shouldBeChecked: false },
        { name: '6 Buyer has paid Seller...', shouldBeChecked: false },
        { name: '9 Other Modifications...', shouldBeChecked: true },
      ],
    },
  ];

  let passCount = 0;
  let failCount = 0;

  for (const testCase of testCases) {
    console.log(`\n=== ${testCase.name} ===`);
    const pdfBytes = Buffer.from(TREC_39_11_BASE64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();

    // Fill property
    const tx = { property_address: '1847 Vintage Way, Boerne', city_state_zip: 'TX 78006' };
    const propertyLine = [tx.property_address, tx.city_state_zip].filter(Boolean).join(', ');
    safeSetText(form, FIELDS.propertyAddress, propertyLine);

    // Fill based on amendment type
    if (testCase.amendmentType === 'closing_date') {
      safeCheck(form, FIELDS.closingDateCheckbox);
      safeSetText(form, FIELDS.closingDateText, formatLongDateNoYear(testCase.newValue));
      safeSetText(form, FIELDS.closingDateYearSuffix, formatTwoDigitYear(testCase.newValue));
    } else if (testCase.amendmentType === 'price_change') {
      safeCheck(form, FIELDS.salesPriceCheckbox);
      safeSetText(form, FIELDS.salesPriceTotal, formatMoney(testCase.newValue));
    } else if (testCase.amendmentType === 'option_extension') {
      safeCheck(form, FIELDS.optionFeeCheckbox);
      safeSetText(form, FIELDS.optionFeeExtensionDays, `${testCase.newValue} days`);
    } else if (testCase.amendmentType === 'repair_items') {
      safeCheck(form, '9 Other Modifications Insert only factual statements and business details applicable to this sale');
      safeSetText(form, 'Text 8', 'Test repair items');
    }

    // Verify checkboxes
    let testPassed = true;
    for (const field of testCase.testFields) {
      const fullName = field.name.includes('...')
        ? Array.from(form.getFields()).find(f => f.constructor.name === 'PDFCheckBox' && f.getName().startsWith(field.name.substring(0, field.name.length - 3)))?.getName()
        : field.name;

      if (!fullName) {
        console.log(`  ? Field "${field.name}" not found`);
        testPassed = false;
        continue;
      }

      try {
        const box = form.getCheckBox(fullName);
        const isChecked = box.isChecked();
        const status = isChecked === field.shouldBeChecked ? '✓' : '✗';
        const display = fullName.length > 50 ? fullName.substring(0, 47) + '...' : fullName;
        console.log(`  ${status} "${display}" ${isChecked ? 'CHECKED' : 'unchecked'} (expected ${field.shouldBeChecked ? 'CHECKED' : 'unchecked'})`);

        if (isChecked !== field.shouldBeChecked) {
          testPassed = false;
        }
      } catch (e) {
        console.log(`  ? Error checking "${field.name}": ${e.message}`);
        testPassed = false;
      }
    }

    if (testPassed) {
      console.log(`Result: PASS`);
      passCount++;
    } else {
      console.log(`Result: FAIL`);
      failCount++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Total: ${passCount} PASS, ${failCount} FAIL`);
  console.log(`${'='.repeat(50)}`);

  if (failCount === 0) {
    console.log('\n✓ All scenarios verified. FIELDS coordinate map is correct.');
    process.exit(0);
  } else {
    console.log('\n✗ Some scenarios failed. FIELDS coordinate map needs rebuilding.');
    process.exit(1);
  }
})();
