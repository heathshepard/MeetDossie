const fs = require('fs');
const path = require('path');
const { validateScriptFile } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-script.js'));

const file = path.join(__dirname, '..', 'docs', 'SCRIPT-VIDEO-7-OPTION-PERIOD-WEEKEND.md');
const res = validateScriptFile(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify(res, null, 1));
