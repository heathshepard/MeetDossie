# Carter Loop 3 — Telemetry schema gap

**Context:** Quinn's loop 2 verification of GOLD-2026-06-12-v2-overnight-ops-fix-loop2 passed 4 of 5 checks:
- ✅ marketplace classifier rejects all 4 test cases (barn-porch, TC discussion, tractor OBO, TC charging discussion)
- ✅ vercel.json has single mission-watchdog cron `0 * * * *` (24/7); old partial schedules `0 13-23 * * *` and `0 0,1 * * *` removed
- ✅ `api/_lib/cron-telemetry.js` exists, fail-soft via try/catch
- ✅ 4 crons wire up `recordCronRun`: mission-watchdog, send-to-sage, engagement-veto-mode, publish-approved
- ✅ `scripts/mission-watchdog-runner.ps1` uses `$env:CRON_SECRET` — no hardcoded secret anywhere in repo
- ❌ **`cron_runs` table is missing the `last_meta` JSONB column** — every telemetry write currently fails 400 PGRST204

**The gap:**
The SQL migration block at the bottom of `api/_lib/cron-telemetry.js` (line 50-56) describes a table with `cron_name, last_run, last_status, last_meta JSONB`. The actual table in Supabase only has `id, cron_name, last_run, last_status, created_at`. Live probe confirmed:

```
POST /rest/v1/cron_runs with last_meta → 400 {"code":"PGRST204","message":"Could not find the 'last_meta' column of 'cron_runs' in the schema cache"}
POST /rest/v1/cron_runs without last_meta → 201 OK
```

Because `recordCronRun` is wrapped in try/catch (fail-soft), the crons don't crash — but EVERY telemetry write silently fails. We have zero observability, defeating the whole point of the fix.

**Repro:**
```bash
curl -X POST https://pgwoitbdiyubjugwufhk.supabase.co/rest/v1/cron_runs \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d '{"cron_name":"test","last_run":"2026-06-12T12:00:00Z","last_status":"ok","last_meta":{}}'
```

**Required fix (Carter):**

1. **Add `last_meta` column to `cron_runs` table** via Supabase migration:
   ```sql
   ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS last_meta JSONB;
   ```

2. **Also add `updated_at` for upsert semantics** (the original spec wanted upsert on cron_name; current table has `id bigint NOT NULL` PRIMARY KEY which means inserts append rather than upsert per-cron). Either:
   - (preferred) Drop `id`, make `cron_name` the PRIMARY KEY, add `updated_at TIMESTAMPTZ DEFAULT now()` — matches the spec at line 50-56 of cron-telemetry.js
   - OR keep current schema, switch the telemetry to use `Prefer: resolution=merge-duplicates` against the `cron_name` UNIQUE constraint (already exists as `cron_runs_cron_name_key`)

   The existing UNIQUE constraint on `cron_name` should make merge-duplicates work TODAY for non-meta columns. Just adding `last_meta` is sufficient to fix the immediate bug — schema rework is a nice-to-have.

3. **Minimum-viable fix:**
   ```sql
   ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS last_meta JSONB;
   ALTER TABLE cron_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
   ```

4. **Verify** by hitting the same POST that failed and confirming 201:
   ```bash
   POST with last_meta → expect 201, not 400
   ```

5. **Commit + push to staging.** GOLD tag: `GOLD-2026-06-12-v3-cron-telemetry-schema-fix`.

6. Notify Quinn for loop 3 re-verification.

**Heath has been pinged about the gap. Do NOT merge to main.**
