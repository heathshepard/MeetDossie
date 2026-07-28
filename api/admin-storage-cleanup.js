'use strict';

// api/admin-storage-cleanup.js
//
// On-demand Supabase Storage hygiene. Storage hit 2.21 GB against the 1 GB
// free-tier limit; this reclaims sets that nothing in the database or the
// repo references.
//
// Auth:  Authorization: Bearer ${CRON_SECRET}      (CLAUDE.md Section 15)
// Safety: read-only by default. Nothing is deleted unless confirm=1.
//
// Modes:
//   (default)      dry run - report what would be deleted
//   mode=manifest  return signed download URLs for the same set, so private
//                  buckets can be pulled local before deletion
//   confirm=1      actually delete
//
// Targets:
//   social-cards-orphans   objects in social-cards not named by any
//                          social_posts.media_url
//   videos-unused          objects in videos not used by the app
//                          (tutorial_videos / video_library / sage_conversations)
//                          and not attached to an approved-but-unpublished post
//   wipe:<bucket>          every object in <bucket>, allowlisted below
//
// Because manifest and delete resolve the target through the same code path,
// the signed download set is exactly the set that deletion would remove.
//
// A full local backup of all 15 buckets (18,165 files, 2.21 GB) was taken
// 2026-07-28 to C:\Users\Heath\DossieBackups\supabase-storage-2026-07-28
// and byte-verified before any deletion.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const LIST_PAGE = 1000;   // Supabase storage list() hard cap
const DELETE_BATCH = 200; // objects per remove() call
const SIGN_BATCH = 500;   // objects per sign() call
const SIGN_TTL = 7200;    // seconds a download URL stays valid

// Buckets a full wipe is permitted against. Anything holding live customer
// data or app content is deliberately absent: documents, social-cards,
// videos, screen-recordings (source media for the render pipeline),
// customer-view-digests, tar-forms-uploads, voiceovers, email-assets.
const WIPE_ALLOWED = new Set([
  'desktop-screenshots',
  'system-diagnostics',
  'jarvis-apks',
  'morning-briefs',
  'ventures-files',
]);

function sbHeaders(extra) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

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

async function sbSelect(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`select ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Every "<bucket>/<object name>" mentioned anywhere in a row set. Mirrors the
// SQL that scanned each row cast to text, so the two agree by construction.
function namesFromRows(rows, bucket) {
  const out = new Set();
  const re = new RegExp(`/${bucket}/([^"'\\\\,\\s)]+)`, 'g');
  for (const row of rows) {
    const txt = JSON.stringify(row);
    let m;
    while ((m = re.exec(txt)) !== null) out.add(safeDecode(m[1]));
  }
  return out;
}

// Objects in the videos bucket that must survive: anything the app serves,
// plus anything attached to a post that has not published yet.
async function videosToKeep() {
  const [tutorials, library, sage, approved] = await Promise.all([
    sbSelect('tutorial_videos?select=*'),
    sbSelect('video_library?select=*'),
    sbSelect('sage_conversations?select=*'),
    sbSelect('social_posts?select=media_url,status&status=eq.approved'),
  ]);

  const keep = new Set();
  for (const rows of [tutorials, library, sage, approved]) {
    for (const n of namesFromRows(rows, 'videos')) keep.add(n);
  }
  return keep;
}

async function referencedSocialCardNames() {
  const rows = await sbSelect(
    'social_posts?select=media_url&media_url=like.' + encodeURIComponent('%/social-cards/%')
  );
  const names = new Set();
  for (const row of rows) {
    const [, name] = String(row.media_url || '').split('/social-cards/');
    if (name) names.add(safeDecode(name));
  }
  return names;
}

async function signBatch(bucket, names) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ expiresIn: SIGN_TTL, paths: names }),
  });
  if (!res.ok) throw new Error(`sign ${bucket} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function removeBatch(bucket, names) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: sbHeaders(),
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new Error(`remove ${bucket} -> ${res.status} ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body) ? body.length : names.length;
}

// Resolve a target to { bucket, doomed[], protectedCount }.
async function resolveTarget(target) {
  if (target.startsWith('wipe:')) {
    const bucket = target.slice(5);
    if (!WIPE_ALLOWED.has(bucket)) {
      const err = new Error(`bucket not allowlisted for wipe: ${bucket}`);
      err.statusCode = 403;
      throw err;
    }
    return { bucket, doomed: await listAllObjects(bucket), protectedCount: 0 };
  }

  if (target === 'social-cards-orphans') {
    const bucket = 'social-cards';
    const [all, keep] = await Promise.all([listAllObjects(bucket), referencedSocialCardNames()]);
    const doomed = all.filter(o => !keep.has(o.name));
    const protectedCount = all.length - doomed.length;
    if (protectedCount === 0 && keep.size > 0) {
      const err = new Error('refusing: no bucket object matched any referenced media_url');
      err.statusCode = 409;
      throw err;
    }
    return { bucket, doomed, protectedCount };
  }

  if (target === 'videos-unused') {
    const bucket = 'videos';
    const [all, keep] = await Promise.all([listAllObjects(bucket), videosToKeep()]);
    const doomed = all.filter(o => !keep.has(o.name));
    const protectedCount = all.length - doomed.length;
    // The app is known to serve from this bucket. Matching nothing would mean
    // the name extraction is wrong, and deleting would take the tutorial
    // library with it, so refuse rather than guess.
    if (protectedCount === 0) {
      const err = new Error('refusing: no video matched an app or approved-post reference');
      err.statusCode = 409;
      throw err;
    }
    return { bucket, doomed, protectedCount };
  }

  const err = new Error('unknown target');
  err.statusCode = 400;
  throw err;
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
  const mode = String(req.query.mode || '');
  const confirm = String(req.query.confirm || '') === '1';

  try {
    const { bucket, doomed, protectedCount } = await resolveTarget(target);
    const bytes = doomed.reduce((sum, o) => sum + o.size, 0);

    if (mode === 'manifest') {
      const signed = [];
      for (let i = 0; i < doomed.length; i += SIGN_BATCH) {
        const slice = doomed.slice(i, i + SIGN_BATCH);
        const bySize = new Map(slice.map(o => [o.name, o.size]));
        const out = await signBatch(bucket, slice.map(o => o.name));
        for (const row of out) {
          const name = row.path || row.name;
          if (row.signedURL) {
            signed.push({
              name,
              size: bySize.get(name) || 0,
              url: `${SUPABASE_URL}/storage/v1${row.signedURL}`,
            });
          }
        }
      }

      res.status(200).json({
        mode: 'manifest', target, bucket,
        objects: signed.length,
        total_mb: +(bytes / 1048576).toFixed(1),
        expires_in_seconds: SIGN_TTL,
        files: signed,
      });
      return;
    }

    if (!confirm) {
      res.status(200).json({
        mode: 'dry-run', target, bucket,
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
      mode: 'deleted', target, bucket,
      deleted_files: deleted,
      freed_mb: +(bytes / 1048576).toFixed(1),
      protected_files: protectedCount,
      failed_batches: failures.length,
      failures: failures.slice(0, 5),
    });
  } catch (e) {
    console.error('[admin-storage-cleanup]', target, e);
    res.status(e.statusCode || 500).json({ error: String(e.message || e) });
  }
};
