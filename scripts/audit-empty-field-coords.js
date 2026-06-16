// Audit script: find fields with empty/missing coordinate areas
const FIELD_MAP_DOCUSEAL = require('../api/_assets/field-map-resale-docuseal.js');

const emptyCoordFields = [];
const validCoordFields = [];

Object.entries(FIELD_MAP_DOCUSEAL).forEach(([fieldName, coord]) => {
  // Check if areas is missing, empty, or has no valid coordinates
  if (!coord || !coord.page === undefined) {
    emptyCoordFields.push({
      name: fieldName,
      reason: 'missing coord object',
      coord: coord,
    });
  } else if (coord.x === undefined || coord.y === undefined || coord.h === undefined) {
    emptyCoordFields.push({
      name: fieldName,
      reason: 'missing x/y/h properties',
      coord: coord,
    });
  } else {
    validCoordFields.push(fieldName);
  }
});

console.log(`\n=== FIELD COORDINATE AUDIT ===`);
console.log(`Total fields: ${Object.keys(FIELD_MAP_DOCUSEAL).length}`);
console.log(`Valid coordinates: ${validCoordFields.length}`);
console.log(`Empty/missing coordinates: ${emptyCoordFields.length}`);

if (emptyCoordFields.length > 0) {
  console.log(`\n=== FIELDS WITHOUT COORDINATES ===`);
  emptyCoordFields.forEach(item => {
    console.log(`${item.name}: ${item.reason}`);
  });
}

console.log(`\n=== SUMMARY ===`);
console.log(`Fields to render: ${validCoordFields.length}`);
console.log(`Fields to skip: ${emptyCoordFields.length}`);
