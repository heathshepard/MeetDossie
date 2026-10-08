#!/usr/bin/env node
/**
 * model-path.js — one place that knows where the model weights live.
 *
 * Canonical location is scripts/video-engine/models/ (fetched by
 * download-models.sh), so the whole engine is one self-contained directory.
 * A repo-root models/ is checked as a fallback for machines set up before the
 * move. Resolution order is explicit rather than a bare relative path, which
 * silently depended on the caller's cwd and failed differently depending on
 * whether edit.js or a human invoked the stage.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ENGINE_MODELS = path.join(__dirname, 'models');
const ROOT_MODELS = path.join(__dirname, '..', '..', 'models');

function resolveModel(name, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of [ENGINE_MODELS, ROOT_MODELS]) {
    const c = path.join(dir, name);
    if (fs.existsSync(c)) return c;
  }
  // Return the canonical path so the caller's "not found" message names the
  // place the file is supposed to be, not wherever cwd happened to point.
  return path.join(ENGINE_MODELS, name);
}

module.exports = { resolveModel, ENGINE_MODELS, ROOT_MODELS };
