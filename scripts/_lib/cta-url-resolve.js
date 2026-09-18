'use strict';

// scripts/_lib/cta-url-resolve.js
//
// "Does the CTA in this video actually go somewhere?" — as a real network
// check, not a format check.
//
// WHY THIS EXISTS
// ---------------
// 2026-09-16: Rust's CTA card said `rustfitness.app`, which is NXDOMAIN. That
// URL was about to be burned into a published video and its captions, where it
// is unfixable after the fact. scripts/build-shortform-video.py grew
// assert_cta_url_resolves() as a RENDER-time refusal, but that guard:
//   * only covers videos built by that one compositor (not the Ken Burns
//     listing renderer, not anything hand-dropped into the watch folder), and
//   * is DNS-only — a domain that resolves but serves a 404 still passes.
//
// This module is the QUEUE-time equivalent, wired into
// scripts/check-video-quality-cli.js as the `cta_url_resolves` rule so nothing
// reaches video_library with a dead link, whatever produced it.
//
// WHAT COUNTS AS A PASS
//   1. DNS resolves (the Rust failure mode), and
//   2. an HTTP(S) request returns a status < 400 after following redirects.
//
// WHAT IS DELIBERATELY SKIPPED (returns pass with a reason, never a silent OK)
//   * A CTA that is not a URL at all. heath-realtor's CTA is the sentence
//     "Text me for a private showing" — there is no link to check. Detected by
//     a space, since no real host contains one. Same rule the compositor uses.
//   * No CTA supplied by the caller. The caller is expected to say so
//     explicitly; a missing value is reported as `skipped`, and it is the
//     orchestrator's job (scripts/daily-video-supply.js) to always pass one.
//
// FAIL-CLOSED: a network error, a timeout, or a throw is a FAIL, not a skip.
// "I couldn't check" and "it's fine" must never look the same — that is the
// silent-failure class this whole gate exists to catch
// (feedback_silent-failure-is-the-enemy.md).

const dns = require('dns').promises;

const DEFAULT_TIMEOUT_MS = 8000;

function hostOf(url) {
  return String(url).replace(/^https?:\/\//i, '').split('/')[0].split('?')[0];
}

function normalize(url) {
  const s = String(url).trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/**
 * @param {string|null} ctaUrl  the CTA as it appears on the end card
 * @param {{timeoutMs?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<{pass: boolean, skipped: boolean, url: string|null,
 *                    host: string|null, status: number|null, note: string}>}
 */
async function checkCtaUrl(ctaUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl || globalThis.fetch;

  if (!ctaUrl) {
    return {
      pass: true, skipped: true, url: null, host: null, status: null,
      note: 'no CTA URL supplied — nothing to resolve',
    };
  }
  if (/\s/.test(String(ctaUrl).trim())) {
    return {
      pass: true, skipped: true, url: String(ctaUrl), host: null, status: null,
      note: 'CTA is a sentence, not a link (e.g. "Text me for a private showing") — no URL to resolve',
    };
  }

  const url = normalize(ctaUrl);
  const host = hostOf(url);

  // 1. DNS. This is the exact Rust failure mode and it is the cheapest check,
  //    so it runs first and reports a distinct note from an HTTP failure.
  try {
    await dns.lookup(host);
  } catch (err) {
    return {
      pass: false, skipped: false, url, host, status: null,
      note: `DNS does not resolve for host "${host}" (${(err && err.code) || err}) — this is a dead link`,
    };
  }

  // 2. HTTP. HEAD first (cheap); some hosts 405 a HEAD, so fall back to GET
  //    before calling it a failure rather than failing a perfectly live page.
  for (const method of ['HEAD', 'GET']) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await doFetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status < 400) {
        return {
          pass: true, skipped: false, url, host, status: res.status,
          note: `${method} ${url} -> ${res.status}`,
        };
      }
      if (method === 'GET' || res.status !== 405) {
        return {
          pass: false, skipped: false, url, host, status: res.status,
          note: `${method} ${url} -> ${res.status} — the CTA resolves but does not serve a page`,
        };
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (method === 'GET') {
        return {
          pass: false, skipped: false, url, host, status: null,
          note: `request to ${url} failed (${(err && err.message) || err}) — failing closed`,
        };
      }
    }
  }

  return {
    pass: false, skipped: false, url, host, status: null,
    note: `could not verify ${url} — failing closed`,
  };
}

module.exports = { checkCtaUrl, hostOf, normalize };
