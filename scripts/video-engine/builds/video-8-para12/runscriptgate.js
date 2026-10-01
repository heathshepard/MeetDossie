const fs = require('fs');
const S = require('/home/heath/mw/v8/verify-video-script.js');
const txt = fs.readFileSync('/home/heath/mw/v8/v8_script.md', 'utf8');
const tr = JSON.parse(fs.readFileSync('/home/heath/mw/v8/sp/tr_c.json', 'utf8'));
const deliveredWords = tr.words.filter((w) => w.type === 'word');
const res = S.validateScriptFile(txt, { deliveredWords });
console.log('PASS:', res.pass, '| delivered words:', deliveredWords.length);
for (const sec of res.sections) {
  console.log('\nsection:', sec.title);
  console.log('detail:', JSON.stringify(sec.result.detail));
  for (const [k, v] of Object.entries(sec.result.rules)) {
    console.log(' %s %s%s %s', v.pass ? 'PASS' : 'FAIL', k,
      v.blocking === false ? ' (non-blocking)' : '',
      v.note ? '- ' + String(v.note).slice(0, 240) : '');
  }
}
