'use strict';

// api/admin-storage-cleanup.js
//
// On-demand Supabase Storage hygiene. Storage hit 2.21 GB against the 1 GB
// free-tier limit; this reclaims the two sets that nothing in the database
// references.
//
// Auth:  Authorization: Bearer ${CRON_SECRET}      (CLAUDE.md Section 15)
// Safety: dry run by default. Nothing is deleted unless confirm=1 is passed.
//
// Targets:
//   desktop-screenshots   every object in the bucket. Jun 9-10 automation
//                         test run. Only desktop_actions rows point at it and
//                         those are the test rows themselves.
//   social-cards-orphans  every object in social-cards that is NOT named by
//                         social_posts.media_url. A whole-database scan on
//                         2026-07-28 found '/social-cards/' in exactly one
//                         table (social_posts, 169 rows), so that column is
//                         the complete reference set.
//
// A full local backup of all 15 buckets (18,165 files, 2.21 GB) was taken
// 2026-07-28 to C:\Users\Heath\DossieBackups\supabase-storage-2026-07-28
// and byte-verified before this endpoint was written.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const LIST_PAGE = 1000;   // Supabase storage list() hard cap
const DELETE_BATCH = 200; // objects per remove() call

function sbHeaders(extra) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

// One page of a single prefix level. Folders come back with id === null.
async function listPage(bucket, prefix, offset) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({
      prefix,
      limit: LIST_PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });
  if (!res.ok) {
    throw new Error(`list ${bucket}/${prefix} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// storage list() is not recursive, so walk the prefix tree breadth-first.
async function listAllObjects(bucket) {
  const objects = [];
  const queue = [''];

  while (queue.length) {
    const prefix = queue.shift();
    let offset = 0;

    for (;;) {
      const page = await listPage(bucket, prefix, offset);
      if (!Array.isArray(page) || page.length === 0) break;

      for (const entry of page) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          queue.push(full); // folder
        } else {
          objects.push({ name: full, size: Number(entry.metadata?.size) || 0 });
        }
      }

      if (page.length < LIST_PAGE) break;
      offset += page.length;
    }
  }

  return objects;
}

// Every social-cards object name currently referenced by a post.
async function referencedSocialCardNames() {
  const path = '/rest/v1/social_posts'
    + '?select=media_url'
    + `&media_url=like.${encodeURIComponent('%/social-cards/%')}`;

  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: sbHeaders() });
  if (!res.ok) {
    throw new Error(`social_posts -> ${res.status} ${await res.text()}`);
  }

  const rows = await res.json();
  const names = new Set();
  for (const row of rows) {
    const [, name] = String(row.media_url || '').split('/social-cards/');
    if (name) names.add(decodeURIComponent(name));
  }
  return names;
}

async function removeBatch(bucket, names) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: sbHeaders(),
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) {
    throw new Error(`remove ${bucket} -> ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body.length : names.length;
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'supabase env missing' });
    return;
  }

  const target = String(req.query.target || '');
  const confirm = String(req.query.confirm || '') === '1';

  try {
    let bucket;
    let doomed;
    let protectedCount = 0;

    if (target === 'desktop-screenshots') {
      bucket = 'desktop-screenshots';
      doomed = await listAllObjects(bucket);
    } else if (target === 'social-cards-orphans') {
      bucket = 'social-cards';
      const [all, keep] = await Promise.all([
        listAllObjects(bucket),
        referencedSocialCardNames(),
      ]);
      doomed = all.filter(o => !keep.has(o.name));
      protectedCount = all.length - doomed.length;

      // The reference set must actually match objects in the bucket. If it
      // does not, the naming assumption is wrong and deleting would be
      // destructive, so refuse rather than guess.
      if (protectedCount === 0 && keep.size > 0) {
        res.status(409).json({
          error: 'refusing to delete: no bucket object matched any referenced media_url',
          referenced_urls: keep.size,
          bucket_objects: all.length,
        });
        return;
      }
    } else {
      res.status(400).json({
        error: 'target must be desktop-screenshots or social-cards-orphans',
      });
      return;
    }

    const bytes = doomed.reduce((sum, o) => sum + o.size, 0);

    if (!confirm) {
      res.status(200).json({
        mode: 'dry-run',
        target,
        bucket,
        would_delete_files: doomed.length,
        would_delete_mb: +(bytes / 1048576).toFixed(1),
        protected_files: protectedCount,
        sample: doomed.slice(0, 5).map(o => o.name),
        note: 're-run with &confirm=1 to actually delete',
      });
      return;
    }

    let deleted = 0;
    const failures = [];
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      const batch = doomed.slice(i, i + DELETE_BATCH).map(o => o.name);
      try {
        deleted += await removeBatch(bucket, batch);
      } catch (e) {
        failures.push({ at: i, error: String(e.message || e) });
      }
    }

    res.status(200).json({
      mode: 'deleted',
      target,
      bucket,
      deleted_files: deleted,
      freed_mb: +(bytes / 1048576).toFixed(1),
      protected_files: protectedCount,
      failed_batches: failures.length,
      failures: failures.slice(0, 5),
    });
  } catch (e) {
    console.error('[admin-storage-cleanup]', target, e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
