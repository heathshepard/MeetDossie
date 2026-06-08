"""
Extract Chrome Profile 4 Facebook cookies → Playwright storageState JSON

Reads Chrome's encrypted cookie database, decrypts using DPAPI + AES-256-GCM,
and saves as scripts/sessions/facebook.json in Playwright's storageState format.

Usage: python scripts/extract-chrome-cookies.py
"""

import os
import sys
import json
import base64
import shutil
import sqlite3
import ctypes
import ctypes.wintypes
import tempfile
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    print("ERROR: cryptography package required. Run: pip install cryptography")
    sys.exit(1)

PROFILE_DIR = Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/User Data"
PROFILE_NAME = "Profile 4"
LOCAL_STATE_PATH = PROFILE_DIR / "Local State"
COOKIES_PATH = PROFILE_DIR / PROFILE_NAME / "Network" / "Cookies"
OUTPUT_PATH = Path(__file__).parent / "sessions" / "facebook.json"

FACEBOOK_DOMAINS = [".facebook.com", "facebook.com", ".messenger.com"]


def dpapi_decrypt(ciphertext: bytes) -> bytes:
    """Decrypt bytes using Windows DPAPI (CryptUnprotectData)."""

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    p = ctypes.create_string_buffer(ciphertext, len(ciphertext))
    blobin = DATA_BLOB(ctypes.sizeof(p), p)
    blobout = DATA_BLOB()
    retval = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blobin), None, None, None, None, 0, ctypes.byref(blobout)
    )
    if not retval:
        raise RuntimeError("DPAPI decryption failed")
    result = ctypes.string_at(blobout.pbData, blobout.cbData)
    ctypes.windll.kernel32.LocalFree(blobout.pbData)
    return result


def get_aes_key() -> bytes:
    with open(LOCAL_STATE_PATH, encoding="utf-8") as f:
        local_state = json.load(f)
    encrypted_key_b64 = local_state["os_crypt"]["encrypted_key"]
    encrypted_key = base64.b64decode(encrypted_key_b64)
    # First 5 bytes are the literal string "DPAPI"
    dpapi_blob = encrypted_key[5:]
    return dpapi_decrypt(dpapi_blob)


def decrypt_cookie_value(aes_key: bytes, encrypted_value: bytes) -> str:
    if not encrypted_value:
        return ""
    # v10/v11 prefix = Chrome 80+ AES-GCM encryption
    if encrypted_value[:3] in (b"v10", b"v11"):
        nonce = encrypted_value[3:15]
        ciphertext = encrypted_value[15:]
        aesgcm = AESGCM(aes_key)
        try:
            return aesgcm.decrypt(nonce, ciphertext, None).decode("utf-8", errors="replace")
        except Exception:
            return ""
    # Older DPAPI-encrypted values
    try:
        return dpapi_decrypt(encrypted_value).decode("utf-8", errors="replace")
    except Exception:
        return ""


def extract_facebook_cookies(aes_key: bytes) -> list:
    # Copy the Cookies file to avoid SQLite lock contention while Chrome is running
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        shutil.copy2(COOKIES_PATH, tmp_path)
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, "
            "       is_secure, is_httponly, samesite "
            "FROM cookies WHERE host_key LIKE '%facebook.com' OR host_key LIKE '%messenger.com'"
        )
        rows = cur.fetchall()
        conn.close()
    finally:
        os.unlink(tmp_path)

    cookies = []
    for row in rows:
        value = row["value"]
        if not value and row["encrypted_value"]:
            value = decrypt_cookie_value(aes_key, bytes(row["encrypted_value"]))

        # Convert Chrome's microsecond epoch to Unix seconds
        expires = row["expires_utc"]
        if expires and expires > 0:
            # Chrome epoch starts 1601-01-01; Unix epoch 1970-01-01 → offset 11644473600 seconds
            expires_unix = (expires / 1_000_000) - 11_644_473_600
        else:
            expires_unix = -1

        samesite_map = {-1: "None", 0: "None", 1: "Lax", 2: "Strict"}
        samesite = samesite_map.get(row["samesite"], "None")

        cookies.append({
            "name": row["name"],
            "value": value,
            "domain": row["host_key"],
            "path": row["path"],
            "expires": expires_unix,
            "httpOnly": bool(row["is_httponly"]),
            "secure": bool(row["is_secure"]),
            "sameSite": samesite,
        })

    return cookies


def main():
    print(f"[extract-chrome-cookies] Reading AES key from Local State...")
    try:
        aes_key = get_aes_key()
        print(f"[extract-chrome-cookies] AES key: {len(aes_key)} bytes OK")
    except Exception as e:
        print(f"ERROR getting AES key: {e}")
        sys.exit(1)

    print(f"[extract-chrome-cookies] Extracting Facebook cookies from {COOKIES_PATH}...")
    try:
        cookies = extract_facebook_cookies(aes_key)
        print(f"[extract-chrome-cookies] Found {len(cookies)} Facebook cookies")
    except Exception as e:
        print(f"ERROR extracting cookies: {e}")
        sys.exit(1)

    if not cookies:
        print("ERROR: No Facebook cookies found. Make sure Chrome Profile 4 is logged into Facebook.")
        sys.exit(1)

    # Build Playwright storageState format
    storage_state = {
        "cookies": cookies,
        "origins": [],
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(storage_state, f, indent=2)

    print(f"[extract-chrome-cookies] Saved {len(cookies)} cookies → {OUTPUT_PATH}")
    print("[extract-chrome-cookies] Done. You can now run: node scripts/fb-group-watcher.js")


if __name__ == "__main__":
    main()
