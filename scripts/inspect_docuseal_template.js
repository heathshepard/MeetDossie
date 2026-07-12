const DOCUSEAL_BASE = 'https://api.docuseal.com';
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const TEMPLATE_ID = 4952172; // TREC 20-19 template (fillable, 280 auto-imported fields; replaces archived 4111319 on 2026-07-12)

async function inspectTemplate() {
  if (!DOCUSEAL_API_KEY) {
    console.error('DOCUSEAL_API_KEY not set');
    process.exit(1);
  }

  try {
    const res = await fetch(DOCUSEAL_BASE + '/templates/' + TEMPLATE_ID, {
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`Template fetch failed (${res.status}): ${text.slice(0, 500)}`);
      process.exit(1);
    }

    const template = await res.json();
    console.log(JSON.stringify(template, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

inspectTemplate();
