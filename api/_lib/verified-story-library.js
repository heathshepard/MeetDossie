'use strict';

// api/_lib/verified-story-library.js
//
// Loader + eligibility filter for api/_lib/verified-war-stories.json -- the
// ONLY source of personal anecdotes a generator may draw from when writing
// a post/comment in Heath's name. Built 2026-09-09 after the daily
// group-post generator invented five personal war stories and nearly
// posted them under Heath's real name and real estate license.
//
// A format that needs an anecdote must call eligibleStories() and, if it
// comes back empty, MUST fall back to a non-anecdote format -- never
// invent one. See api/_lib/group-post5-formats.js pickFormat().
//
// Owner: Sage, 2026-09-09.

const fs = require('fs');
const path = require('path');

const LIB_PATH = path.join(__dirname, 'verified-war-stories.json');

function loadLibrary() {
  const raw = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  return Array.isArray(raw.stories) ? raw.stories : [];
}

function getStory(id) {
  return loadLibrary().find((s) => s.id === id) || null;
}

/**
 * @param {object} opts
 * @param {string[]} [opts.excludeIds]  story ids to exclude (already used
 *   elsewhere in this run, or used too recently in this group)
 * @returns {Array} eligible story entries (status === 'eligible' only --
 *   'blocked' stories, like the active Low Oak dispute, never come back
 *   from this function no matter what's excluded)
 */
function eligibleStories({ excludeIds = [] } = {}) {
  return loadLibrary().filter(
    (s) => s.status === 'eligible' && !excludeIds.includes(s.id),
  );
}

module.exports = { LIB_PATH, loadLibrary, getStory, eligibleStories };
