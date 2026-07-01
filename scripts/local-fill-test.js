// Local test: run fillForm directly with merged-fields.json input
// Bypasses Supabase/Vercel — pure local pdf-lib invocation
// Usage: node scripts/local-fill-test.js [form-type] [merged-fields-path] [out-path]
//
// Defaults: resale-contract, .tmp/v3-fha-verify/merged-fields.json, .tmp/local-test-resale.pdf

const fs = require('fs');
const path = require('path');

// Stub out the middleware imports so we can load fill-form
const ROOT = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

(async () => {
  const formType = process.argv[2] || 'resale-contract';
  const mergedPath = process.argv[3] || path.join(ROOT, '.tmp', 'v3-fha-verify', 'merged-fields.json');
  const outPath = process.argv[4] || path.join(ROOT, '.tmp', `local-test-${formType}.pdf`);

  // Load the module — fill-form exports the handler but we need fillForm internally
  // The module evaluates at require-time and exports handler. We need the fillForm function.
  // Approach: monkey-patch the module to extract fillForm before handler runs.
  const mod = require(path.join(ROOT, 'api', 'fill-form.js'));
  // Re-require by reading the file and extracting fillForm via export hack
  // Easier path: use the module's internal helpers by re-loading after exposing them via env hack

  // Read fill-form.js, append `module.exports.__fillForm = fillForm; module.exports.__FORM_CONFIGS = FORM_CONFIGS;`
  // For test only — we'll create a small wrapper that re-uses the module's internals.

  // Simplest approach: spawn a child node process with a wrapper that intercepts before module.exports = handler
  // But require caching is fine; instead we'll re-evaluate the file body in a sandbox with VM module.

  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'api', 'fill-form.js'), 'utf8')
    + '\nmodule.exports.__fillForm = fillForm;\nmodule.exports.__FORM_CONFIGS = FORM_CONFIGS;\n';
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
  if (!fillForm) { console.error('Could not extract fillForm function'); process.exit(1); }

  const fieldValues = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
  console.log('Filling', formType, 'with', Object.keys(fieldValues).length, 'fields');
  const outBytes = await fillForm(formType, fieldValues);
  fs.writeFileSync(outPath, outBytes);
  console.log('Wrote', outBytes.length, 'bytes to', outPath);
})().catch(e => { console.error(e); process.exit(1); });
