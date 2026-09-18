'use strict';

// scripts/_lib/ask-dossie-crop.js
//
// The crop_y maths for a D1 "Ask Dossie" capture, extracted so the two halves
// of the format agree by construction:
//
//   scripts/generate-ask-dossie-video.js  (capture half) renders it as prose
//                                         into capture-notes.md for a human
//   scripts/render-ask-dossie-video.js    (render half)  reads the NUMBER and
//                                         puts it straight into the spec
//
// It was prose-only before, which meant the render half either re-derived the
// same arithmetic (two copies, guaranteed to drift) or a person transcribed a
// number out of a markdown file. Neither survives being run unattended every
// day, which is now the point (docs/CONTENT-FORMAT-LIBRARY.md §8.3).
//
// WHAT IT SOLVES: the burned caption band sits over the bottom of the output
// frame. Playbook §5a check 14 fails a video whose captions sit on top of real
// app text. crop_y slides the 9:16 window up or down inside the taller capture
// so the answer bubble lands ABOVE the caption band and still fully in frame.

const DSF = 3;                 // deviceScaleFactor used by the recorder
const CAPTURE_H = 2532;        // 844 CSS px * 3
const WINDOW_H = 2080;         // the 9:16 window height inside that capture
const MAX_CROP_Y = CAPTURE_H - WINDOW_H;   // 452
const SCALE = 1920 / WINDOW_H;             // window px -> output px
const CAPTION_TOP_OUT = 1480;  // top of the burned caption band, output px

/**
 * @param {object} answer  the recorder's answer.json (needs answer_bubble_geometry)
 * @returns {{ok: boolean, cropY: number|null, lo: number, hi: number,
 *            topPx: number|null, bottomPx: number|null, note: string}}
 */
function computeCropY(answer) {
  const g = answer && answer.answer_bubble_geometry;
  if (!g) {
    return {
      ok: false, cropY: null, lo: 0, hi: MAX_CROP_Y, topPx: null, bottomPx: null,
      note: 'answer bubble geometry was not recorded for this take',
    };
  }
  const topPx = Math.round(g.top_css * DSF);
  const bottomPx = Math.round(g.bottom_css * DSF);
  const lo = Math.max(0, Math.round(bottomPx - CAPTION_TOP_OUT / SCALE));
  const hi = Math.min(MAX_CROP_Y, topPx);
  const ok = lo <= hi;
  return {
    ok,
    cropY: ok ? Math.round((lo + hi) / 2) : null,
    lo,
    hi,
    topPx,
    bottomPx,
    note: ok
      ? `crop_y ${Math.round((lo + hi) / 2)} (valid range [${lo}, ${hi}])`
      : `no crop_y satisfies both constraints (need >= ${lo} to clear the caption band `
        + `but <= ${hi} to keep the bubble top in frame) — split the answer across two `
        + 'segments or shorten the caption band; never shrink the footage',
  };
}

module.exports = {
  computeCropY,
  DSF,
  CAPTURE_H,
  WINDOW_H,
  MAX_CROP_Y,
  CAPTION_TOP_OUT,
};
