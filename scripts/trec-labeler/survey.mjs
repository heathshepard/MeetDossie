import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = 'C:/Users/Heath Shepard/Desktop/MeetDossie/scripts';
const ids = ['trec-20-18','trec-40','trec-39-10','trec-36-11','trec-38-7','op-h','op-l'];
let tu = 0, tc = 0, tt = 0;
for (const id of ids) {
  const p = join(dir, `.${id}-unmatched-report.json`);
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const s = d.stats || {};
    console.log(`${id.padEnd(12)}: total=${String(s.total_widgets||0).padStart(3)} confident=${String(s.confident_match||0).padStart(3)} unmatched=${String(s.unmatched||0).padStart(3)}`);
    tu += s.unmatched||0; tc += s.confident_match||0; tt += s.total_widgets||0;
  } catch (e) { console.log(`${id}: NO REPORT`); }
}
console.log(`TOTAL       : total=${String(tt).padStart(3)} confident=${String(tc).padStart(3)} unmatched=${String(tu).padStart(3)}`);
