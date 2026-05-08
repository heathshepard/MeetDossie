"""End-to-end diagnostic for the Zernio publish pipeline.

Reads .env.production.local (pulled via `vercel env pull --environment=production`)
and runs Steps 1-5 from the user's spec, printing exact responses.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ENV = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\.env.production.local")


def load_env(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r'^([A-Z0-9_]+)="(.*)"$', line.strip())
        if m:
            out[m.group(1)] = m.group(2)
    return out


def http(method: str, url: str, headers=None, body=None, timeout=30) -> tuple[int, str]:
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return e.code, body
    except Exception as e:
        return 0, f"<exception> {type(e).__name__}: {e}"


def supabase_query(env: dict[str, str], table: str, query: str = "", method: str = "GET", body: str | None = None) -> tuple[int, str]:
    base = env.get("SUPABASE_URL", "")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        return 0, "missing SUPABASE_URL or key"
    url = f"{base}/rest/v1/{table}"
    if query:
        url += f"?{query}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    return http(method, url, headers=headers, body=body)


def main() -> int:
    env = load_env(ENV)
    zkey = env.get("ZERNIO_API_KEY", "")
    cron = env.get("CRON_SECRET", "")
    sup_url = env.get("SUPABASE_URL", "")

    print("=" * 70)
    print("ENV CHECK")
    print("=" * 70)
    print(f"  SUPABASE_URL          : {'set' if sup_url else 'MISSING'}  ({sup_url or '-'})")
    print(f"  SUPABASE_SERVICE_ROLE : {'set' if env.get('SUPABASE_SERVICE_ROLE_KEY') else 'MISSING'}")
    print(f"  CRON_SECRET           : {'set' if cron else 'MISSING'}  (len={len(cron)})")
    print(f"  ZERNIO_API_KEY        : {'set' if zkey else 'MISSING'}  (len={len(zkey)})")
    print()

    # --------- STEP 1: GET zernio.com/api/v1/accounts ---------
    print("=" * 70)
    print("STEP 1 — GET https://zernio.com/api/v1/accounts")
    print("=" * 70)
    status, text = http(
        "GET",
        "https://zernio.com/api/v1/accounts",
        headers={"Authorization": f"Bearer {zkey}", "Accept": "application/json"},
    )
    print(f"  HTTP {status}")
    print(f"  body (first 1500): {text[:1500]}")
    print()

    # --------- STEP 2: zernio_accounts ---------
    print("=" * 70)
    print("STEP 2 — SELECT * FROM public.zernio_accounts")
    print("=" * 70)
    status, text = supabase_query(env, "zernio_accounts", "select=*")
    print(f"  HTTP {status}")
    try:
        rows = json.loads(text)
        if isinstance(rows, list):
            print(f"  rows: {len(rows)}")
            for r in rows:
                print("   -", json.dumps(r, default=str))
        else:
            print(f"  body: {text[:600]}")
    except Exception:
        print(f"  body: {text[:600]}")
    print()

    # --------- STEP 3: social_posts top 10 ---------
    print("=" * 70)
    print("STEP 3 — SELECT id, platform, status, content, created_at FROM social_posts ORDER BY created_at DESC LIMIT 10")
    print("=" * 70)
    q = "select=id,platform,status,content,scheduled_for,posted_at,zernio_account_id,zernio_post_id,created_at,approved_at&order=created_at.desc&limit=10"
    status, text = supabase_query(env, "social_posts", q)
    print(f"  HTTP {status}")
    try:
        rows = json.loads(text)
        if isinstance(rows, list):
            print(f"  rows: {len(rows)}")
            for r in rows:
                content_preview = (r.get("content") or "")[:80].replace("\n", " ")
                print(f"   - id={r.get('id')[:8]}.. platform={r.get('platform')} status={r.get('status')} approved_at={r.get('approved_at')} posted_at={r.get('posted_at')} acct={r.get('zernio_account_id')} content='{content_preview}...'")
        else:
            print(f"  body: {text[:800]}")
    except Exception as e:
        print(f"  parse error: {e}")
        print(f"  body: {text[:800]}")
    print()

    # Bonus: count approved-and-due rows like the cron does
    print("STEP 3b — approved-and-due-now rows (cron's filter)")
    q2 = "select=id,platform,zernio_account_id,scheduled_for&status=eq.approved&posted_at=is.null"
    status, text = supabase_query(env, "social_posts", q2)
    print(f"  HTTP {status}")
    try:
        rows = json.loads(text)
        if isinstance(rows, list):
            print(f"  approved-unpublished rows: {len(rows)}")
            for r in rows:
                print(f"   - id={r.get('id')[:8]}.. platform={r.get('platform')} zernio_account_id={r.get('zernio_account_id')} scheduled_for={r.get('scheduled_for')}")
        else:
            print(f"  body: {text[:600]}")
    except Exception:
        print(f"  body: {text[:600]}")
    print()

    # --------- STEP 5: hit prod cron-publish-approved (status only, doesn't expose key) ---------
    print("=" * 70)
    print("STEP 5 — POST https://meetdossie.com/api/cron-publish-approved")
    print("=" * 70)
    status, text = http(
        "POST",
        "https://meetdossie.com/api/cron-publish-approved",
        headers={"Authorization": f"Bearer {cron}", "Accept": "application/json", "Content-Type": "application/json"},
        body="",
    )
    print(f"  HTTP {status}")
    print(f"  body: {text[:1500]}")
    print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
