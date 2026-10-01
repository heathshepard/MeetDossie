'use strict';

// api/_lib/secret-crypto.js
// =========================================================================
// Symmetric encryption for third-party credentials stored at rest in
// public.user_integrations — today that's per-member DocuSeal API keys
// (docuseal_api_key_encrypted). Google/Microsoft tokens are NOT routed
// through this — those are OAuth refresh/access tokens already scoped
// per-user by the OAuth provider itself and are handled by the existing
// google-oauth-callback.js / microsoft-oauth-callback.js write paths.
//
// AES-256-GCM. Key comes from INTEGRATION_ENCRYPTION_KEY (Vercel env,
// Production + Preview), 32 raw bytes, base64-encoded. Generated once via
// crypto.randomBytes(32).toString('base64') and set directly in Vercel —
// never committed, never logged, never printed by any script in this repo.
//
// Encoded shape: "v1:<iv_base64>:<tag_base64>:<ciphertext_base64>" — the
// "v1" prefix exists so a future key-rotation / algorithm change can add a
// "v2" branch without breaking rows encrypted under v1.
//
// SECURITY: this module must NEVER log, print, or return the raw key or
// any decrypted plaintext in an error message. Every function here throws
// plain Error() with only a category string on failure.
//
// Owner: Carter, 2026-10-01 (member integrations build).

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce size

function loadKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('integration_encryption_key_missing');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('integration_encryption_key_bad_length');
  }
  return key;
}

/**
 * Encrypts a plaintext secret for storage. Returns null for empty input
 * (so callers can store NULL instead of an encrypted empty string).
 * @param {string} plaintext
 * @returns {string|null} "v1:<iv>:<tag>:<ciphertext>" (all base64)
 */
function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = loadKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a value produced by encryptSecret(). Returns null (never
 * throws) on malformed input or a tampered/undecryptable payload — callers
 * must treat null as "no usable credential," not crash the request.
 * @param {string} encoded
 * @returns {string|null}
 */
function decryptSecret(encoded) {
  if (!encoded) return null;
  try {
    const parts = String(encoded).split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, ivB64, tagB64, ctB64] = parts;
    const key = loadKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    console.error('[secret-crypto] decrypt failed (category only, never payload):', err && err.code ? err.code : 'decrypt_error');
    return null;
  }
}

module.exports = { encryptSecret, decryptSecret };
