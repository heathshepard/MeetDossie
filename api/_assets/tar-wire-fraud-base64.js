// TAR 2517 Wire Fraud Warning PDF — base64-encoded asset
//
// PLACEHOLDER — Heath must complete this step before wire fraud generation goes live:
//   1. Log in to Texas REALTORS member portal at texasrealtors.com
//   2. Download TAR 2517 "Addendum Regarding Wire Fraud and Electronic Funds Transfer"
//   3. Base64-encode it:
//      Windows PowerShell:  [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\TAR-2517.pdf"))
//      Mac/Linux:           base64 -i TAR-2517.pdf
//   4. Replace the empty string below with the full base64 string
//   5. Commit and deploy
//
// Until this is populated, api/fill-form.js will fail gracefully when form_type
// is 'wire-fraud-warning' (pdf-lib will throw "Failed to load PDF" which is
// caught by the main handler and returned as a 500 error with a clear message).

module.exports = '';
