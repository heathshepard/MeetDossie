// ONE-SHOT admin script: remove Seller's Disclosure (OP-H) from Buyer Transaction package.
// Auth: Authorization: Bearer <CRON_SECRET>
// DELETE this file after running.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

module.exports = async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured.' });
  }

  const log = [];

  // Step 1: Find Buyer Transaction package
  const pkgRes = await supa('form_packages?select=id,name&order=name.asc');
  if (!pkgRes.ok) {
    const t = await pkgRes.text().catch(() => '');
    return res.status(500).json({ ok: false, error: 'form_packages fetch failed', detail: t.slice(0, 200) });
  }
  const packages = await pkgRes.json();
  log.push({ step: 'packages', found: packages.map(p => ({ id: p.id, name: p.name })) });

  const buyerPkg = packages.find(p => p.name && p.name.toLowerCase().includes('buyer'));
  if (!buyerPkg) {
    return res.status(404).json({ ok: false, error: 'Buyer Transaction package not found', packages: packages.map(p => p.name) });
  }
  log.push({ step: 'buyer_package', id: buyerPkg.id, name: buyerPkg.name });

  // Step 2: Get all items in Buyer Transaction package
  const itemsRes = await supa(`form_package_items?package_id=eq.${encodeURIComponent(buyerPkg.id)}&select=id,form_template_id,position`);
  if (!itemsRes.ok) {
    const t = await itemsRes.text().catch(() => '');
    return res.status(500).json({ ok: false, error: 'form_package_items fetch failed', detail: t.slice(0, 200) });
  }
  const items = await itemsRes.json();
  log.push({ step: 'items_in_package', count: items.length });

  // Step 3: Get form template details to find OP-H (Seller's Disclosure)
  const templateIds = items.map(i => i.form_template_id).filter(Boolean);
  if (templateIds.length === 0) {
    return res.status(200).json({ ok: true, removed: 0, message: 'Package has no items.', log });
  }

  const tidsFilter = templateIds.map(id => encodeURIComponent(id)).join(',');
  const tmplRes = await supa(`form_templates?id=in.(${tidsFilter})&select=id,name,short_name,trec_number`);
  if (!tmplRes.ok) {
    const t = await tmplRes.text().catch(() => '');
    return res.status(500).json({ ok: false, error: 'form_templates fetch failed', detail: t.slice(0, 200) });
  }
  const templates = await tmplRes.json();
  log.push({ step: 'templates', list: templates.map(t => ({ id: t.id, name: t.name, trec_number: t.trec_number })) });

  // Find OP-H — Seller's Disclosure Notice
  const ophTemplate = templates.find(t =>
    (t.trec_number && t.trec_number.toUpperCase().includes('OP-H')) ||
    (t.short_name && t.short_name.toUpperCase().includes('OP-H')) ||
    (t.name && t.name.toLowerCase().includes("seller's disclosure"))
  );

  if (!ophTemplate) {
    return res.status(404).json({ ok: false, error: "OP-H (Seller's Disclosure) template not found in Buyer package", templates: templates.map(t => t.name), log });
  }
  log.push({ step: 'found_oph', template: { id: ophTemplate.id, name: ophTemplate.name, trec_number: ophTemplate.trec_number } });

  // Step 4: Find the package item row for OP-H
  const ophItem = items.find(i => i.form_template_id === ophTemplate.id);
  if (!ophItem) {
    return res.status(404).json({ ok: false, error: 'OP-H item row not found in package items', log });
  }
  log.push({ step: 'oph_item', id: ophItem.id, form_template_id: ophItem.form_template_id });

  // Step 5: DELETE the item row
  const delRes = await supa(
    `form_package_items?id=eq.${encodeURIComponent(ophItem.id)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
  );
  if (!delRes.ok) {
    const t = await delRes.text().catch(() => '');
    return res.status(500).json({ ok: false, error: 'DELETE failed', detail: t.slice(0, 200), log });
  }

  // Step 6: Confirm deletion
  const verifyRes = await supa(`form_package_items?id=eq.${encodeURIComponent(ophItem.id)}&select=id`);
  const verifyRows = await verifyRes.json().catch(() => []);
  const confirmed = Array.isArray(verifyRows) && verifyRows.length === 0;
  log.push({ step: 'verify_deleted', confirmed });

  return res.status(200).json({
    ok: true,
    removed: 1,
    deletedItem: { id: ophItem.id, template: ophTemplate.name, trec_number: ophTemplate.trec_number },
    confirmed,
    log,
  });
};
