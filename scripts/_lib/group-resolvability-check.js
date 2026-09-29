'use strict';

// scripts/_lib/group-resolvability-check.js
//
// Startup gate for scripts/comment-hunt-groups.json and
// scripts/fb-commenter-groups.json.
//
// WHY (Carter, 2026-09-16): a live browser audit of Heath's real Facebook
// account disproved two group names that had been sitting in config:
// "Boerne Real Estate" does not exist (the real group is "All about Boerne
// Real Estate") and "Real Estate in Austin TX" does not exist at all.
// Neither name happened to be in these two specific files, but nothing
// would have stopped it — there was no gate anywhere that required a group
// to be actually visited and confirmed live before a script could scan or
// post to it. This module is that gate, and it is deliberately dumb: it
// does not itself drive a browser or hit Facebook. It only trusts what a
// human/agent has ALREADY recorded as verified in the config (the
// `existence_verified` field added to every group entry the same day this
// file was written) plus a basic URL-shape sanity check. Verification still
// has to happen the old-fashioned way — visit the group, confirm it's real,
// then flip existence_verified to true. What changes is that an entry
// nobody has ever verified can no longer just get quietly scanned/posted to
// because it LOOKS plausible.
//
// A group entry is RESOLVABLE only if:
//   1. it has a non-empty url matching a real facebook.com group URL shape
//      (not empty, not a PLACEHOLDER, not something that isn't even a
//      facebook.com group link), AND
//   2. existence_verified === true — someone has actually loaded the group
//      live and confirmed it's real, not just typed a plausible name into a
//      config file (the exact failure mode this closes).
// Anything else is refused and reported, never silently dropped.

const FB_GROUP_URL_RE = /^https:\/\/(www\.)?facebook\.com\/(groups|share\/g)\/[^/\s]+\/?$/i;

/**
 * @param {object} group
 * @param {object} [opts]
 * @param {string} [opts.urlField]   defaults to 'url' (comment-hunt-groups.json shape).
 *                                    pass 'group_url' for fb-commenter-groups.json.
 * @param {string} [opts.nameField]  defaults to 'name'; pass 'group_name' for the other file.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function checkGroupResolvable(group, opts = {}) {
  const urlField = opts.urlField || 'url';
  const nameField = opts.nameField || 'name';
  const url = group && group[urlField];
  const name = (group && group[nameField]) || group?.key || '(unnamed group)';

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: `${name}: no ${urlField} set` };
  }
  if (url.includes('PLACEHOLDER')) {
    return { ok: false, reason: `${name}: ${urlField} is a PLACEHOLDER, never filled in` };
  }
  if (!FB_GROUP_URL_RE.test(url.trim())) {
    return { ok: false, reason: `${name}: ${urlField} "${url}" doesn't look like a real facebook.com group URL` };
  }
  if (group.existence_verified !== true) {
    return {
      ok: false,
      reason: `${name}: existence_verified is not true — nobody has confirmed this group actually exists live `
        + `(the exact gap that let "Boerne Real Estate" and "Real Estate in Austin TX" sit in config as unverified guesses)`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Splits a group list into resolvable / unresolved, reporting every
 * refusal. Never throws — a malformed group entry is just unresolved.
 *
 * @param {Array} groups
 * @param {object} [opts]              same urlField/nameField as checkGroupResolvable
 * @param {function} [opts.report]     called once per unresolved group with a
 *                                       one-line reason string. Defaults to
 *                                       console.error, tagged so it's greppable.
 * @returns {{ resolvable: Array, unresolved: Array<{group, reason}> }}
 */
function filterResolvableGroups(groups, opts = {}) {
  const report = opts.report || ((msg) => console.error(`[group-resolvability] REFUSED — ${msg}`));
  const resolvable = [];
  const unresolved = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const result = checkGroupResolvable(group, opts);
    if (result.ok) {
      resolvable.push(group);
    } else {
      unresolved.push({ group, reason: result.reason });
      report(result.reason);
    }
  }
  return { resolvable, unresolved };
}

module.exports = {
  FB_GROUP_URL_RE,
  checkGroupResolvable,
  filterResolvableGroups,
};
