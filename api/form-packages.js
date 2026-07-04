// Vercel Serverless Function: /api/form-packages
// GET    — returns all packages visible to the user (system defaults + their own), with items
// POST   { action: 'apply',  packageId, transactionId } — bulk-attaches all package forms to a tx
// POST   { action: 'create', name, side, description, templateIds } — creates a custom package
// PATCH  { id, templateIds } — replaces item list on a user-owned package
// DELETE ?id=<uuid>          — deletes a user-owned package (not system defaults)
//
// Authorization: Bearer <supabase user JWT>
//
// ==========================================================================
// SQL — RUN IN SUPABASE SQL EDITOR BEFORE DEPLOYING (already applied)
// ==========================================================================
//
//   CREATE TABLE IF NOT EXISTS public.form_packages (
//     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = system default
//     name        TEXT NOT NULL,
//     side        TEXT NOT NULL DEFAULT 'custom',  -- 'buyer', 'seller', 'custom'
//     description TEXT,
//     is_default  BOOLEAN NOT NULL DEFAULT false,
//     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
//   CREATE TABLE IF NOT EXISTS public.form_package_items (
//     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     package_id       UUID NOT NULL REFERENCES public.form_packages(id) ON DELETE CASCADE,
//     form_template_id UUID NOT NULL REFERENCES public.form_templates(id) ON DELETE CASCADE,
//     position         INTEGER NOT NULL DEFAULT 0,
//     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     UNIQUE(package_id, form_template_id)
//   );
//
//   CREATE INDEX IF NOT EXISTS idx_fp_user ON public.form_packages(user_id);
//   CREATE INDEX IF NOT EXISTS idx_fpi_pkg ON public.form_package_items(package_id);
//
//   ALTER TABLE public.form_packages ENABLE ROW LEVEL SECURITY;
//   ALTER TABLE public.form_package_items ENABLE ROW LEVEL SECURITY;
//
//   CREATE POLICY "fp_read" ON public.form_packages FOR SELECT
//     USING (auth.role() = 'authenticated' AND (user_id IS NULL OR user_id = auth.uid()));
//   CREATE POLICY "fp_insert" ON public.form_packages FOR INSERT WITH CHECK (auth.uid() = user_id);
//   CREATE POLICY "fp_update" ON public.form_packages FOR UPDATE USING (auth.uid() = user_id);
//   CREATE POLICY "fp_delete" ON public.form_packages FOR DELETE USING (auth.uid() = user_id);
//   CREATE POLICY "fp_service" ON public.form_packages FOR ALL USING (auth.role() = 'service_role');
//   CREATE POLICY "fpi_read" ON public.form_package_items FOR SELECT USING (auth.role() = 'authenticated');
//   CREATE POLICY "fpi_write" ON public.form_package_items FOR ALL USING (auth.role() = 'service_role');
//
// ==========================================================================

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      VERCEL_PREVIEW_RE.test(origin)
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

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

// ---------------------------------------------------------------------------
// GET — returns all packages visible to the user (system defaults + their own)
//       with items expanded to include form template details
// ---------------------------------------------------------------------------
async function handleGet(req, res) {
  const { userId } = await verifySupabaseToken(req);
  if (!userId) throw new AuthError('Not authenticated.');

  // Fetch packages: system defaults (user_id IS NULL) + user's own
  const pkgRes = await supa(
    `form_packages?or=(user_id.is.null,user_id.eq.${encodeURIComponent(userId)})&order=is_default.desc,name.asc&select=id,name,side,description,is_default,user_id,created_at`
  );
  if (!pkgRes.ok) {
    const text = await pkgRes.text().catch(() => '');
    throw new Error(`form_packages fetch failed (${pkgRes.status}): ${text.slice(0, 200)}`);
  }
  const packages = await pkgRes.json();

  if (!Array.isArray(packages) || packages.length === 0) {
    return res.status(200).json({ ok: true, packages: [] });
  }

  // Fetch all items for these packages in one query
  const packageIds = packages.map((p) => p.id);
  const idsFilter = packageIds.map((id) => encodeURIComponent(id)).join(',');
  const itemsRes = await supa(
    `form_package_items?package_id=in.(${idsFilter})&order=position.asc,created_at.asc&select=id,package_id,position,form_template_id`
  );
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => '');
    throw new Error(`form_package_items fetch failed (${itemsRes.status}): ${text.slice(0, 200)}`);
  }
  const items = await itemsRes.json();

  // Fetch form template details for all referenced template IDs
  const templateIds = [...new Set((items || []).map((i) => i.form_template_id))];
  let templateMap = {};
  if (templateIds.length > 0) {
    const tidsFilter = templateIds.map((id) => encodeURIComponent(id)).join(',');
    const tmplRes = await supa(
      `form_templates?id=in.(${tidsFilter})&select=id,name,short_name,trec_number,category`
    );
    if (!tmplRes.ok) {
      const text = await tmplRes.text().catch(() => '');
      throw new Error(`form_templates fetch failed (${tmplRes.status}): ${text.slice(0, 200)}`);
    }
    const templates = await tmplRes.json();
    for (const t of (templates || [])) {
      templateMap[t.id] = t;
    }
  }

  // Build items map keyed by package_id
  const itemsByPackage = {};
  for (const item of (items || [])) {
    if (!itemsByPackage[item.package_id]) itemsByPackage[item.package_id] = [];
    itemsByPackage[item.package_id].push({
      id: item.id,
      position: item.position,
      form_template: templateMap[item.form_template_id] || null,
    });
  }

  // Assemble result
  const result = packages.map((pkg) => ({
    ...pkg,
    items: itemsByPackage[pkg.id] || [],
  }));

  return res.status(200).json({ ok: true, packages: result });
}

// ---------------------------------------------------------------------------
// POST action: apply — bulk-attaches all forms in a package to a transaction
// ---------------------------------------------------------------------------
async function handleApply(req, res, userId) {
  const body = req.body || {};
  const packageId = sanitizeString(body.packageId, { maxLength: 200 });
  const transactionId = sanitizeString(body.transactionId, { maxLength: 200 });

  if (!packageId) throw new ValidationError('packageId is required.');
  if (!transactionId) throw new ValidationError('transactionId is required.');

  // Verify user owns the transaction
  const txRes = await supa(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id`
  );
  if (!txRes.ok) {
    const text = await txRes.text().catch(() => '');
    throw new Error(`transactions fetch failed (${txRes.status}): ${text.slice(0, 200)}`);
  }
  const txRows = await txRes.json();
  if (!Array.isArray(txRows) || txRows.length === 0) {
    throw new ValidationError('Transaction not found or does not belong to you.', 404);
  }

  // Fetch package + items (package must be visible: system or user-owned)
  const pkgRes = await supa(
    `form_packages?id=eq.${encodeURIComponent(packageId)}&or=(user_id.is.null,user_id.eq.${encodeURIComponent(userId)})&select=id,name`
  );
  if (!pkgRes.ok) {
    const text = await pkgRes.text().catch(() => '');
    throw new Error(`form_packages fetch failed (${pkgRes.status}): ${text.slice(0, 200)}`);
  }
  const pkgRows = await pkgRes.json();
  if (!Array.isArray(pkgRows) || pkgRows.length === 0) {
    throw new ValidationError('Package not found.', 404);
  }

  const itemsRes = await supa(
    `form_package_items?package_id=eq.${encodeURIComponent(packageId)}&order=position.asc&select=id,form_template_id`
  );
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => '');
    throw new Error(`form_package_items fetch failed (${itemsRes.status}): ${text.slice(0, 200)}`);
  }
  const packageItems = await itemsRes.json();
  if (!Array.isArray(packageItems) || packageItems.length === 0) {
    return res.status(200).json({ ok: true, attached: 0, documentIds: [] });
  }

  // Fetch existing documents for this transaction to avoid duplicates
  const existingRes = await supa(
    `documents?transaction_id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=form_template_id`
  );
  if (!existingRes.ok) {
    const text = await existingRes.text().catch(() => '');
    throw new Error(`documents fetch failed (${existingRes.status}): ${text.slice(0, 200)}`);
  }
  const existingDocs = await existingRes.json();
  const existingTemplateIds = new Set(
    (existingDocs || []).map((d) => d.form_template_id).filter(Boolean)
  );

  // Filter to only forms not already attached
  const toAttach = packageItems.filter(
    (item) => item.form_template_id && !existingTemplateIds.has(item.form_template_id)
  );
  if (toAttach.length === 0) {
    return res.status(200).json({ ok: true, attached: 0, documentIds: [], message: 'All forms already attached.' });
  }

  // Fetch template details for forms we need to attach
  const tidsFilter = toAttach.map((i) => encodeURIComponent(i.form_template_id)).join(',');
  const tmplRes = await supa(
    `form_templates?id=in.(${tidsFilter})&is_active=eq.true&select=id,name,short_name,trec_number,storage_path,source_url`
  );
  if (!tmplRes.ok) {
    const text = await tmplRes.text().catch(() => '');
    throw new Error(`form_templates fetch failed (${tmplRes.status}): ${text.slice(0, 200)}`);
  }
  const templates = await tmplRes.json();
  const templateById = {};
  for (const t of (templates || [])) templateById[t.id] = t;

  // Insert documents one at a time (PostgREST bulk insert doesn't return all rows reliably)
  const documentIds = [];
  for (const item of toAttach) {
    const template = templateById[item.form_template_id];
    if (!template) continue;

    // NOTE (2026-07-04): file_type + storage_path are NOT NULL in documents.
    // Blank package attachments have no rendered PDF yet — stamp a stable
    // placeholder derived from the template id. Fill-form pipeline reads
    // storage_path only when status !== 'blank', so the placeholder is inert
    // until a rendered PDF replaces it.
    const docRow = {
      user_id: userId,
      transaction_id: transactionId,
      file_name: `${template.name}.pdf`,
      file_type: 'application/pdf',
      document_type: 'form_template',
      storage_path: template.storage_path || `template/${template.id}.pdf`,
      source_url: template.source_url || null,
      form_template_id: template.id,
      status: 'blank',
    };

    const insertRes = await supa('documents', {
      method: 'POST',
      body: JSON.stringify(docRow),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text().catch(() => '');
      throw new Error(`documents insert failed (${insertRes.status}): ${text.slice(0, 300)}`);
    }
    const inserted = await insertRes.json();
    const newDoc = Array.isArray(inserted) ? inserted[0] : inserted;
    if (newDoc?.id) documentIds.push(newDoc.id);
  }

  return res.status(200).json({
    ok: true,
    attached: documentIds.length,
    documentIds,
  });
}

// ---------------------------------------------------------------------------
// POST action: create — creates a new custom package for the user
// ---------------------------------------------------------------------------
async function handleCreate(req, res, userId) {
  const body = req.body || {};
  const name = sanitizeString(body.name, { maxLength: 200 });
  const side = sanitizeString(body.side, { maxLength: 50 }) || 'custom';
  const description = sanitizeString(body.description, { maxLength: 500 });
  const templateIds = Array.isArray(body.templateIds) ? body.templateIds : [];

  if (!name) throw new ValidationError('name is required.');

  const validSides = ['buyer', 'seller', 'custom'];
  if (!validSides.includes(side)) {
    throw new ValidationError(`side must be one of: ${validSides.join(', ')}`);
  }

  // Insert the package
  const pkgRow = {
    user_id: userId,
    name,
    side,
    description: description || null,
    is_default: false,
  };

  const insertRes = await supa('form_packages', {
    method: 'POST',
    body: JSON.stringify(pkgRow),
  });
  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => '');
    throw new Error(`form_packages insert failed (${insertRes.status}): ${text.slice(0, 300)}`);
  }
  const inserted = await insertRes.json();
  const newPkg = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!newPkg?.id) throw new Error('form_packages insert did not return an id.');

  // Insert items if provided
  if (templateIds.length > 0) {
    for (let i = 0; i < templateIds.length; i++) {
      const tid = sanitizeString(String(templateIds[i]), { maxLength: 200 });
      if (!tid) continue;
      const itemRow = {
        package_id: newPkg.id,
        form_template_id: tid,
        position: i,
      };
      const itemRes = await supa('form_package_items', {
        method: 'POST',
        body: JSON.stringify(itemRow),
        headers: { Prefer: 'return=minimal' },
      });
      if (!itemRes.ok) {
        const text = await itemRes.text().catch(() => '');
        console.error(`[form-packages] item insert failed (${itemRes.status}): ${text.slice(0, 200)}`);
        // Non-fatal — continue inserting other items
      }
    }
  }

  return res.status(200).json({ ok: true, package: newPkg });
}

// ---------------------------------------------------------------------------
// PATCH — replace item list on a user-owned package
// ---------------------------------------------------------------------------
async function handlePatch(req, res, userId) {
  const body = req.body || {};
  const id = sanitizeString(body.id, { maxLength: 200 });
  const templateIds = Array.isArray(body.templateIds) ? body.templateIds : [];

  if (!id) throw new ValidationError('id is required.');

  // Verify the package belongs to this user and is not a system default
  const pkgRes = await supa(
    `form_packages?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id,is_default`
  );
  if (!pkgRes.ok) {
    const text = await pkgRes.text().catch(() => '');
    throw new Error(`form_packages fetch failed (${pkgRes.status}): ${text.slice(0, 200)}`);
  }
  const pkgRows = await pkgRes.json();
  if (!Array.isArray(pkgRows) || pkgRows.length === 0) {
    throw new ValidationError('Package not found or does not belong to you.', 404);
  }
  if (pkgRows[0].is_default) {
    throw new ValidationError('Cannot modify a system default package.', 403);
  }

  // Delete all existing items for this package
  const delRes = await supa(
    `form_package_items?package_id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
  );
  if (!delRes.ok) {
    const text = await delRes.text().catch(() => '');
    throw new Error(`form_package_items delete failed (${delRes.status}): ${text.slice(0, 200)}`);
  }

  // Re-insert from templateIds
  for (let i = 0; i < templateIds.length; i++) {
    const tid = sanitizeString(String(templateIds[i]), { maxLength: 200 });
    if (!tid) continue;
    const itemRow = {
      package_id: id,
      form_template_id: tid,
      position: i,
    };
    const itemRes = await supa('form_package_items', {
      method: 'POST',
      body: JSON.stringify(itemRow),
      headers: { Prefer: 'return=minimal' },
    });
    if (!itemRes.ok) {
      const text = await itemRes.text().catch(() => '');
      console.error(`[form-packages] item upsert failed (${itemRes.status}): ${text.slice(0, 200)}`);
    }
  }

  // Update updated_at on the package
  await supa(
    `form_packages?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
      headers: { Prefer: 'return=minimal' },
    }
  );

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE — delete a user-owned package (not system defaults)
// ---------------------------------------------------------------------------
async function handleDelete(req, res, userId) {
  const id = sanitizeString(req.query?.id || '', { maxLength: 200 });

  if (!id) throw new ValidationError('id query param is required.');

  // Verify ownership and non-default
  const pkgRes = await supa(
    `form_packages?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id,is_default`
  );
  if (!pkgRes.ok) {
    const text = await pkgRes.text().catch(() => '');
    throw new Error(`form_packages fetch failed (${pkgRes.status}): ${text.slice(0, 200)}`);
  }
  const pkgRows = await pkgRes.json();
  if (!Array.isArray(pkgRows) || pkgRows.length === 0) {
    throw new ValidationError('Package not found or does not belong to you.', 404);
  }
  if (pkgRows[0].is_default) {
    throw new ValidationError('Cannot delete a system default package.', 403);
  }

  // Delete (cascade deletes items)
  const delRes = await supa(
    `form_packages?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
  );
  if (!delRes.ok) {
    const text = await delRes.text().catch(() => '');
    throw new Error(`form_packages delete failed (${delRes.status}): ${text.slice(0, 200)}`);
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[form-packages] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      const { userId } = await verifySupabaseToken(req);
      const body = req.body || {};
      const action = sanitizeString(body.action, { maxLength: 50 });

      if (action === 'apply') {
        return await handleApply(req, res, userId);
      }
      if (action === 'create') {
        return await handleCreate(req, res, userId);
      }

      throw new ValidationError(`Unknown action: ${action || '(none)'}`);
    }

    if (req.method === 'PATCH') {
      const { userId } = await verifySupabaseToken(req);
      return await handlePatch(req, res, userId);
    }

    if (req.method === 'DELETE') {
      const { userId } = await verifySupabaseToken(req);
      return await handleDelete(req, res, userId);
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[form-packages] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'An unexpected error occurred.' });
  }
};
