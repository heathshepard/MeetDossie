const fs = require('fs');
const data = fs.readFileSync('trec_decoded.txt', 'latin1');
const BS = String.fromCharCode(92);
const tjRe = new RegExp('\(((?:[^()' + BS + ']|' + BS + '.)*)\)\s*Tj', 'g');
const parts = [];
let m;
while ((m = tjRe.exec(data)) !== null) parts.push(m[1]);
const tjArrRe = /\[([^\[\]]*)\]\s*TJ/g;
while ((m = tjArrRe.exec(data)) !== null) {
  const arr = m[1];
  const strRe = new RegExp('\(((?:[^()' + BS + ']|' + BS + '.)*)\)', 'g');
  let s;
  while ((s = strRe.exec(arr)) !== null) parts.push(s[1]);
}
const text = parts.join('');
fs.writeFileSync('trec_text.txt', text);
console.log('parts:', parts.length, 'chars:', text.length);
