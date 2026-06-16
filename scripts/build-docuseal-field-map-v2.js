const https = require('https');
const fs = require('fs');

const apiKey = 'y2FBCNLnLrUC7bhuRi3uKR3ZLVnWJ1QpB3uiv4A4pnu';
const templateId = 4018208;

console.error(`Fetching DocuSeal template ${templateId}...`);

const options = {
  hostname: 'api.docuseal.com',
  port: 443,
  path: `/templates/${templateId}`,
  method: 'GET',
  headers: {
    'X-Auth-Token': apiKey,
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const templateJson = JSON.parse(data);
      const fields = templateJson.fields || [];
      
      console.error(`Processing ${fields.length} fields from DocuSeal template...`);
      
      // Build the field map
      const fieldMap = {};
      const coordinateLog = [];
      
      fields.forEach((field, index) => {
        const fieldName = field.name;
        const fieldType = field.type;
        const areas = field.areas || [];
        
        if (areas.length === 0) {
          coordinateLog.push(`[SKIP] Field ${index}: "${fieldName}" has no areas`);
          return;
        }
        
        const area = areas[0];
        const pageIndex = area.page || 0;
        const x = area.x;
        const y = area.y;
        const w = area.w;
        const h = area.h;
        
        fieldMap[fieldName] = {
          page: pageIndex,
          x: x,
          y: y,
          w: w,
          h: h,
          type: fieldType === 'checkbox' ? 'checkbox' : 'text',
        };
        
        coordinateLog.push(`[OK] Field ${index}: "${fieldName}" → page ${pageIndex}, x=${x.toFixed(4)}, y=${y.toFixed(4)}, w=${w.toFixed(4)}, h=${h.toFixed(4)}, type=${fieldType}`);
      });
      
      const mappedCount = Object.keys(fieldMap).length;
      console.error(`\nBuilt field map with ${mappedCount} fields`);
      console.error(`${fields.length - mappedCount} fields had no areas and were skipped`);
      
      // Generate JavaScript module with proper quoting for field names
      const jsModule = `// Field map for TREC 20-19 Resale Contract using DocuSeal template schema
// Source: DocuSeal template ${templateId}
// Generated: ${new Date().toISOString()}
// Total fields: ${mappedCount}
// Coordinates are normalized 0-1 (page-relative, x=left, y=top)
// Type: DocuSeal's native coordinate system (percentage-based)

module.exports = {
${Object.entries(fieldMap)
  .map(([name, coords]) => {
    // Check if field name needs quoting (contains spaces, special chars, or starts with number)
    const needsQuoting = /[^a-zA-Z0-9_]/.test(name) || /^[0-9]/.test(name);
    const quotedName = needsQuoting ? `'${name}'` : name;
    return `  ${quotedName}: {
    page: ${coords.page},
    x: ${coords.x},
    y: ${coords.y},
    w: ${coords.w},
    h: ${coords.h},
    type: '${coords.type}',
  }`;
  })
  .join(',\n')}
};
`;
      
      // Write using forward slashes that work on Windows
      const jsPath = 'C:/Users/Heath Shepard/Desktop/MeetDossie/api/_assets/field-map-resale-docuseal.js';
      const logPath = 'C:/Users/Heath Shepard/Desktop/MeetDossie/.tmp-docuseal-field-coordinates.log';
      
      fs.writeFileSync(jsPath, jsModule, 'utf8');
      fs.writeFileSync(logPath, coordinateLog.join('\n'), 'utf8');
      
      console.error('\nFiles written:');
      console.error(`  - ${jsPath}`);
      console.error(`  - ${logPath}`);
      console.error(`\nField map has ${mappedCount} entries`);
      process.exit(0);
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.end();
