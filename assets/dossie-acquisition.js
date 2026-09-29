/*
 * First-touch + last-touch acquisition capture for meetdossie.com marketing
 * pages (index.html, signup.html).
 *
 * Mirrors the pattern already shipping in the Rust repo
 * (src/lib/acquisition.ts) — first-touch never gets overwritten once a real
 * signal (utm_* or a referrer) has been captured, so a later direct visit
 * (someone typing the URL from memory) can't erase the campaign that
 * actually brought them in. Last-touch DOES get overwritten on every visit
 * that carries a signal — it's what answers "what made them convert on
 * THIS visit" as distinct from "what first made them aware."
 *
 * Both survive a page refresh and a later return (localStorage, not
 * sessionStorage) on the SAME device/browser. This does not solve
 * cross-device attribution — nothing here does, honestly, without a login
 * wall before conversion, which this funnel doesn't have.
 *
 * utm_content is expected to carry the decodable content_tag produced by
 * api/_lib/content-tag.js's buildContentTag() at publish time — this file
 * doesn't parse it, just stores it verbatim so the server side can.
 *
 * Owner: Carter, 2026-09-17
 */
(function () {
  'use strict';

  var FIRST_KEY = 'dossie_first_touch_v1';
  var LAST_KEY = 'dossie_last_touch_v1';

  function readSignal() {
    try {
      var params = new URLSearchParams(window.location.search);
      var utm_source = params.get('utm_source');
      var utm_medium = params.get('utm_medium');
      var utm_campaign = params.get('utm_campaign');
      var utm_content = params.get('utm_content');
      var referrer = document.referrer || null;

      if (!utm_source && !utm_medium && !utm_campaign && !utm_content && !referrer) {
        return null; // nothing worth locking in on this load
      }

      return {
        utm_source: utm_source,
        utm_medium: utm_medium,
        utm_campaign: utm_campaign,
        content_tag: utm_content,
        referrer: referrer,
        landing_page: window.location.pathname + window.location.search,
        captured_at: new Date().toISOString(),
      };
    } catch (e) {
      return null;
    }
  }

  function readStored(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function capture() {
    var signal = readSignal();
    if (!signal) return;
    try {
      if (!localStorage.getItem(FIRST_KEY)) {
        localStorage.setItem(FIRST_KEY, JSON.stringify(signal));
      }
      localStorage.setItem(LAST_KEY, JSON.stringify(signal)); // always overwrite
    } catch (e) {
      // localStorage can throw (private browsing, storage disabled) —
      // acquisition tracking is best-effort and must never break the page.
    }
  }

  function clear() {
    try {
      localStorage.removeItem(FIRST_KEY);
      localStorage.removeItem(LAST_KEY);
    } catch (e) { /* best-effort */ }
  }

  window.DossieAcquisition = {
    capture: capture,
    getFirstTouch: function () { return readStored(FIRST_KEY); },
    getLastTouch: function () { return readStored(LAST_KEY); },
    clear: clear,
  };

  capture();
})();
