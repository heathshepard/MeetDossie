const DOCUSEAL_BASE = 'https://api.docuseal.com';
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const TEMPLATE_ID = 4996863; // TREC 20-19 template v2 (211 fields, 6 submitters: Buyer 1/2, Seller 1/2, Buyer Broker, Seller Broker; supersedes 4952172 on 2026-07-14)

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
