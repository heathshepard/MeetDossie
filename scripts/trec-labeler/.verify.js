// Verifies the generated trec-labeler.html embeds parseable data.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/trec-labeler.html', 'utf8');

const marker = 'var EMBEDDED_DATA_JSON = ';
const start = html.indexOf(marker);
if (start === -1) { console.error('FAIL: EMBEDDED_DATA_JSON marker not found'); process.exit(1); }

// Walk forward past whitespace to opening quote of the JS string literal.
let i = start + marker.length;
while (i < html.length && /\s/.test(html[i])) i++;
if (html[i] !== '"') { console.error('FAIL: expected " at ' + i + ', got "' + html.slice(i, i+50) + '"'); process.exit(1); }
i++;
let buf = '';
while (i < html.length) {
  const c = html[i];
  if (c === '\\') { buf += c + html[i+1]; i += 2; continue; }
  if (c === '"') break;
  buf += c; i++;
}
// Re-parse the JS string literal to get the inner JSON.
const innerJson = JSON.parse('"' + buf + '"');
const data = JSON.parse(innerJson);

const forms = Object.keys(data);
console.log('Forms:', forms.join(', '));
console.log('trec-20-18 count:', data['trec-20-18'].length);
console.log('First widget index:', data['trec-20-18'][0].index, 'field_name:', data['trec-20-18'][0].field_name);
console.log('Last widget index:', data['trec-20-18'][data['trec-20-18'].length - 1].index);
console.log('Schema keys on first widget:', Object.keys(data['trec-20-18'][0]).join(', '));
['trec-40', 'trec-36-11', 'op-l', 'trec-39-10', 'trec-38-7', 'op-h'].forEach((f) => {
  console.log(f, '->', Array.isArray(data[f]) ? 'array[' + data[f].length + ']' : 'NOT ARRAY');
});

// Sanity: required schema fields per DoD item 2
const required = ['index','field_name','page','x','y','width','height','field_type','nearest_labels_within_100px','reason_no_match'];
let missing = 0;
data['trec-20-18'].forEach((w) => {
  required.forEach((k) => {
    if (!(k in w)) { console.error('FAIL: widget', w.index, 'missing', k); missing++; }
  });
});
if (missing) { console.error('Total missing fields:', missing); process.exit(1); }
console.log('All ' + data['trec-20-18'].length + ' widgets have required schema fields.');

// Confirm no network calls
const negatives = [
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /XMLHttpRequest/ },
  { name: '<script src=', re: /<script[^>]+src=/i },
  { name: '<link rel="stylesheet" href="http', re: /<link[^>]+href=["']?https?:/i },
  { name: 'fonts.googleapis', re: /fonts\.googleapis/i },
  { name: '<img src="http', re: /<img[^>]+src=["']?https?:/i },
];
let netCalls = 0;
negatives.forEach((n) => {
  if (n.re.test(html)) { console.error('FAIL: network reference found:', n.name); netCalls++; }
});
if (netCalls === 0) console.log('No network calls detected.');

console.log('Bundle size:', (html.length / 1024).toFixed(1) + ' KB');
if (html.length > 500 * 1024) { console.error('FAIL: > 500KB'); process.exit(1); }
console.log('Verification OK.');
