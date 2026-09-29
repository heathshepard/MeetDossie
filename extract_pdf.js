const fs = require('fs');
const zlib = require('zlib');
const path = process.argv[2];
const outPath = process.argv[3];
const buf = fs.readFileSync(path);
const str = buf.toString('latin1');
const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
let m;
let allText = '';
while ((m = streamRe.exec(str)) !== null) {
  const raw = Buffer.from(m[1], 'latin1');
  try {
    const out = zlib.inflateSync(raw);
    allText += out.toString('latin1') + '\n';
  } catch(e) {}
}
fs.writeFileSync(outPath, allText);
console.log('done', allText.length);
