#!/usr/bin/env node
/**
 * build-labeler.js — redirect shim.
 *
 * The labeler build moved to build-labeler.mjs (v3) so it can import pdfjs-dist
 * as an ES module to extract widget geometry. This file just shells out to the
 * .mjs so old `node scripts/trec-labeler/build-labeler.js` invocations still work.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const target = path.join(__dirname, 'build-labeler.mjs');
const r = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(r.status || 0);
