"""
Extract Reddit cookies from Heath's real Chrome profile and write Playwright
storage state to scripts/sessions/reddit.json.

Why: Reddit OAuth path is dead. Heath's real Chrome IS logged into Reddit.
We need those cookies for cookie-based posting.

Mechanism:
  1. Copy locked Cookies SQLite DB to temp (Chrome holds an exclusive lock)
  2. Read Chrome's Local State, base64-decode encrypted_key, strip "DPAPI" prefix
  3. DPAPI-decrypt the AES key (Windows CryptUnprotectData)
  4. For each Reddit cookie row: AES-GCM decrypt encrypted_value
  5. Write Playwright storage state JSON
"""

import os
import sys
import json
import shutil
import sqlite3
import base64
import tempfile
import time
from pathlib import Path

USER_HOME = Path(os.environ['USERPROFILE'])
CHROME_USER_DATA = USER_HOME / 'AppData' / 'Local' / 'Google' / 'Chrome' / 'User Data'
COOKIES_DB = CHROME_USER_DATA / 'Default' / 'Network' / 'Cookies'
LOCAL_STATE = CHROME_USER_DATA / 'Local State'

SESSION_OUT = Path(__file__).parent / 'sessions' / 'reddit.json'
SESSION_OUT.parent.mkdir(parents=True, exist_ok=True)


def get_master_key():
    with open(LOCAL_STATE, 'r', encoding='utf-8') as f:
        local_state = json.load(f)
    encrypted_key_b64 = local_state['os_crypt']['encrypted_key']
    encrypted_key = base64.b64decode(encrypted_key_b64)
    # Strip "DPAPI" prefix (5 bytes)
    if not encrypted_key.startswith(b'DPAPI'):
        print(f"[extract] unexpected encrypted_key prefix: {encrypted_key[:5]}", file=sys.stderr)
        sys.exit(1)
    encrypted_key = encrypted_key[5:]

    import win32crypt
    decrypted = win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)
    # win32crypt returns (description, data)
    return decrypted[1]


def decrypt_value(encrypted_value, master_key):
    from Cryptodome.Cipher import AES

    # Chrome v10+ format: b'v10' or b'v11' + 12-byte nonce + ciphertext + 16-byte GCM tag
    prefix = encrypted_value[:3]
    if prefix in (b'v10', b'v11'):
        nonce = encrypted_value[3:15]
        ciphertext_and_tag = encrypted_value[15:]
        ciphertext = ciphertext_and_tag[:-16]
        tag = ciphertext_and_tag[-16:]
        cipher = AES.new(master_key, AES.MODE_GCM, nonce=nonce)
        try:
            plaintext = cipher.decrypt_and_verify(ciphertext, tag)
            # Chrome v20+ adds a 32-byte SHA256 hash prefix to the plaintext
            # before the actual cookie value. Detect by checking if first 32 bytes
            # look binary and the rest looks like text.
            if len(plaintext) > 32 and any(b < 32 and b not in (9, 10, 13) for b in plaintext[:32]):
                plaintext = plaintext[32:]
            return plaintext.decode('utf-8', errors='replace')
        except Exception as e:
            return None
    else:
        # Legacy DPAPI-only
        import win32crypt
        try:
            return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode('utf-8', errors='replace')
        except Exception:
            return None


def main():
    if not COOKIES_DB.exists():
        print(f"[extract] Cookies DB not found at {COOKIES_DB}", file=sys.stderr)
        sys.exit(1)
    if not LOCAL_STATE.exists():
        print(f"[extract] Local State not found at {LOCAL_STATE}", file=sys.stderr)
        sys.exit(1)

    master_key = get_master_key()
    print(f"[extract] master key decrypted ({len(master_key)} bytes)", file=sys.stderr)

    # Copy the locked DB to temp using raw Win32 CreateFileW with full share
    # modes so we can read while Chrome has an exclusive write lock.
    tmpdir = tempfile.mkdtemp(prefix='reddit-cookies-')
    tmp_db = Path(tmpdir) / 'Cookies'

    def shared_copy(src: Path, dst: Path):
        import win32file
        import win32con
        # Open with all 3 share flags so Chrome's exclusive write lock doesn't block us
        handle = win32file.CreateFileW(
            str(src),
            win32con.GENERIC_READ,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
            None,
            win32con.OPEN_EXISTING,
            win32con.FILE_ATTRIBUTE_NORMAL,
            None,
        )
        try:
            chunks = []
            while True:
                hr, data = win32file.ReadFile(handle, 1024 * 1024)
                if not data:
                    break
                chunks.append(data)
            with open(dst, 'wb') as out:
                for c in chunks:
                    out.write(c)
        finally:
            handle.Close()

    try:
        shared_copy(COOKIES_DB, tmp_db)
        print(f"[extract] shared-copied Cookies DB to {tmp_db} ({tmp_db.stat().st_size} bytes)", file=sys.stderr)
    except Exception as e:
        print(f"[extract] shared_copy failed ({e}); falling back to shutil.copy2", file=sys.stderr)
        shutil.copy2(COOKIES_DB, tmp_db)

    # Also copy the WAL + SHM if they exist (SQLite needs them for in-flight transactions)
    for suffix in ('-wal', '-shm'):
        src_aux = Path(str(COOKIES_DB) + suffix)
        if src_aux.exists():
            try:
                dst_aux = Path(str(tmp_db) + suffix)
                shared_copy(src_aux, dst_aux)
                print(f"[extract] also copied {suffix}", file=sys.stderr)
            except Exception as e:
                print(f"[extract] could not copy {suffix}: {e}", file=sys.stderr)

    conn = sqlite3.connect(str(tmp_db))
    cur = conn.cursor()

    cur.execute("""
        SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
        FROM cookies
        WHERE host_key LIKE '%reddit.com%'
    """)

    rows = cur.fetchall()
    print(f"[extract] found {len(rows)} reddit.com cookie rows", file=sys.stderr)

    playwright_cookies = []
    auth_cookies_seen = []

    for host_key, name, enc, path, expires_utc, is_secure, is_httponly, samesite in rows:
        value = decrypt_value(enc, master_key)
        if value is None:
            print(f"[extract] FAILED to decrypt {name} on {host_key}", file=sys.stderr)
            continue

        # Convert Chrome's expires_utc (microseconds since 1601-01-01) to Unix seconds.
        # session cookies have expires_utc=0
        if expires_utc == 0:
            expires = -1
        else:
            expires = int(expires_utc / 1_000_000 - 11644473600)

        # Playwright samesite mapping: 0=None, 1=Lax (default browser), 2=Strict, -1=None,
        # but newer Chrome uses: -1=unspecified, 0=NoRestriction, 1=Lax, 2=Strict
        samesite_map = {-1: 'Lax', 0: 'None', 1: 'Lax', 2: 'Strict'}
        ss = samesite_map.get(samesite, 'Lax')
        # Playwright requires Secure=true when SameSite=None
        secure = bool(is_secure)
        if ss == 'None':
            secure = True

        cookie = {
            'name': name,
            'value': value,
            'domain': host_key,
            'path': path or '/',
            'expires': expires,
            'httpOnly': bool(is_httponly),
            'secure': secure,
            'sameSite': ss,
        }
        playwright_cookies.append(cookie)

        if name in ('reddit_session', 'token_v2', 'session_tracker', 'edgebucket', 'loid'):
            auth_cookies_seen.append(name)

    conn.close()
    shutil.rmtree(tmpdir, ignore_errors=True)

    storage_state = {
        'cookies': playwright_cookies,
        'origins': [],
    }

    with open(SESSION_OUT, 'w', encoding='utf-8') as f:
        json.dump(storage_state, f, indent=2)

    print(f"[extract] wrote {len(playwright_cookies)} cookies to {SESSION_OUT}", file=sys.stderr)
    print(f"[extract] auth-ish cookies found: {auth_cookies_seen}", file=sys.stderr)

    # Print the auth cookie names as JSON for chaining
    print(json.dumps({
        'cookie_count': len(playwright_cookies),
        'auth_cookies': auth_cookies_seen,
        'output_path': str(SESSION_OUT),
    }))


if __name__ == '__main__':
    main()
