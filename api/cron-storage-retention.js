'use strict';

// api/cron-storage-retention.js
//
// Keeps disposable Storage buckets from creeping back over the free-tier
// limit. system-diagnostics is written by the Ridge watchdog every 4h at
// roughly 12 MB/day with no expiry, which is what pushed Storage to 2.21 GB
// against the 1 GB cap on 2026-07-28.
//
// Schedule: daily 04:30 UTC (before cron-stripe-reconcile at 05:00).
// Auth:     Authorization: Bearer ${CRON_SECRET}
//
// Only buckets listed in RETENTION are touched, and only objects older than
// their retention window. Buckets holding customer data or app content are
// deliberately absent. Pass ?dry=1 to report without deleting.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const RETENTION = [
  { bucket: 'system-diagnostics', days: 3 },
  { bucket: 'desktop-screenshots', days: 3 },
];

const LIST_PAGE = 1000;
const DELETE_BATCH = 200;

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// storage list() is not recursive, so walk the prefix tree breadth-first.
async function listAllObjects(bucket) {
  const objects = [];
  const queue = [''];

  while (queue.length) {
    const prefix = queue.shift();
    let offset = 0;

    for (;;) {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: sbHeaders(),
        body: JSON.stringify({
          prefix, limit: LIST_PAGE, offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
      });
      if (!res.ok) throw new Error(`list ${bucket} -> ${res.status} ${await res.text()}`);

      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;

      for (const entry of page) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          queue.push(full);
        } else {
          objects.push({
            name: full,
            size: Number(entry.metadata?.size) || 0,
            created: entry.created_at || entry.updated_at || null,
          });
        }
      }

      if (page.length < LIST_PAGE) break;
      offset += page.length;
    }
  }

  return objects;
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

  const dry = String(req.query.dry || '') === '1';
  const results = [];

  try {
    for (const { bucket, days } of RETENTION) {
      const cutoff = Date.now() - days * 86400 * 1000;
      const all = await listAllObjects(bucket);

      // An object with no timestamp is kept. Deleting on a missing date would
      // wipe the bucket the first time the list API changes shape.
      const stale = all.filter(o => o.created && Date.parse(o.created) < cutoff);
      const freed = stale.reduce((sum, o) => sum + o.size, 0);

      let deleted = 0;
      if (!dry) {
        for (let i = 0; i < stale.length; i += DELETE_BATCH) {
          deleted += await removeBatch(bucket, stale.slice(i, i + DELETE_BATCH).map(o => o.name));
        }
      }

      results.push({
        bucket, retention_days: days,
        total_files: all.length,
        stale_files: stale.length,
        kept_files: all.length - stale.length,
        [dry ? 'would_free_mb' : 'freed_mb']: +(freed / 1048576).toFixed(1),
        deleted,
      });
    }

    res.status(200).json({ status: 'ok', mode: dry ? 'dry-run' : 'applied', results });
  } catch (e) {
    console.error('[cron-storage-retention]', e);
    res.status(500).json({ error: String(e.message || e), results });
  }
};
