// Local test WITHOUT flatten, so we can read back checkbox states
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

(async () => {
  const formType = process.argv[2] || 'resale-contract';
  const mergedPath = process.argv[3] || path.join(ROOT, '.tmp', 'v3-fha-fields-expanded.json');
  const outPath = process.argv[4] || path.join(ROOT, '.tmp', 'local-noflatten.pdf');

  const vm = require('vm');
  let src = fs.readFileSync(path.join(ROOT, 'api', 'fill-form.js'), 'utf8');
  // Remove the flatten() call
  src = src.replace(/pdfDoc\.getForm\(\)\.flatten\(\);/g, '/* flatten skipped */');
  src += '\nmodule.exports.__fillForm = fillForm;\nmodule.exports.__FORM_CONFIGS = FORM_CONFIGS;\n';
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => require(id.startsWith('.') ? path.join(ROOT, 'api', id) : id),
    console,
    process,
    Buffer,
    __dirname: path.join(ROOT, 'api'),
    __filename: path.join(ROOT, 'api', 'fill-form.js'),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams,
    fetch: global.fetch,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.join(ROOT, 'api', 'fill-form.js') });

  const fillForm = sandbox.module.exports.__fillForm;
  const fieldValues = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
  console.log('Filling', formType, 'with', Object.keys(fieldValues).length, 'fields (no flatten)');
  const outBytes = await fillForm(formType, fieldValues);
  fs.writeFileSync(outPath, outBytes);
  console.log('Wrote', outBytes.length, 'bytes to', outPath);
})().catch(e => { console.error(e); process.exit(1); });
