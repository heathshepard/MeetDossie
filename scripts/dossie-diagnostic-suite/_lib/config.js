"use strict";
// Shared config for Dossie diagnostic suite.
// Every scenario file imports this to get base URL + credentials + output paths.

const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function buildConfig(runId, argv) {
  const args = parseArgs(argv || process.argv);
  const base = args.base || process.env.BASE_URL || "https://meetdossie.com";
  const email = args.email || process.env.APV_EMAIL || "demo@meetdossie.com";
  // Fallback matches other apv-* scripts in scripts/. Real value is DEMO_PASSWORD in Vercel env.
  const password = args.password || process.env.APV_PASSWORD || process.env.DEMO_PASSWORD || "DossieDemo-VaIiAt6Bab";
  const outDir = args.out || path.resolve(__dirname, "..", "..", "..", ".tmp", "dossie-diagnostic-suite", `run-${runId}`);
  const headless = args.headless !== "false" && args.headless !== false;

  return {
    base,
    email,
    password,
    outDir,
    headless,
    runId,
    supabaseUrl: process.env.SUPABASE_URL || "https://pgwoitbdiyubjugwufhk.supabase.co",
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
    // Demo user id for demo@meetdossie.com (canonical, stable — verified 2026-07-10)
    demoUserId: process.env.DEMO_USER_ID || "c29ce34c-1434-44e5-a260-8d1a45213ec3",
    // Test property (per spec)
    property: {
      address: "1247 Sample Way",
      city_state_zip: "San Antonio, TX 78247",
      buyer_name: "Sarah Whitley",
      seller_name: "John Sample",
      sale_price: 325000,
      option_days: 7,
      option_fee: 200,
      down_payment_pct: 20,
      financing_type: "conventional",
    },
  };
}

module.exports = { buildConfig, parseArgs };
