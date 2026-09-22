#!/usr/bin/env node
/**
 * fix-registry.js — the contract between review.js (the critic) and edit.js
 * (the editor). ONE row per finding review.js can emit.
 *
 * WHY THIS EXISTS
 * produce.js used to loop until `review.fixes` produced no brief changes, then
 * print "nothing left to change in the brief — stopping early" and exit 0-ish
 * silence. That sentence was a lie in the only case that mattered: review.js
 * flagged a 27-second static stretch in dossie_trial_06.mp4, attached a `null`
 * brief patch because no editor knob existed, and produce.js treated "I have
 * no knob" as "there is nothing wrong." Nine of its findings were mute in
 * exactly that way.
 *
 * THE RULE THIS FILE ENFORCES
 * Every finding is either:
 *   owner: 'editor' — it drives named brief fields, listed in `knobs`, and
 *                     edit.js must actually read every one of them.
 *   owner: 'human'  — no amount of re-editing fixes it. `humanReason` says
 *                     what a person has to do (usually reshoot or supply an
 *                     asset). produce.js NAMES these out loud and exits 4.
 * There is no third category. A finding with no registry row is itself
 * reported as a defect ("unregistered finding") rather than silently dropped.
 *
 * Run `node scripts/video-engine/fix-registry.js` to print the coverage table.
 */
'use strict';

/** @type {Record<string, {section:number, check:string, owner:'editor'|'human', knobs:string[], humanReason?:string, note?:string}>} */
const REGISTRY = {
  // ---- §2 HOOK ----
  'hook.no_face_frame0': {
    section: 2, check: 'HOOK', owner: 'editor', knobs: ['openOnFace'],
    note: 'shot-plan.js opens the first shot on a frame where the detector found a face',
  },
  'hook.lead_in_silence': { section: 2, check: 'HOOK', owner: 'editor', knobs: ['silenceThreshold'] },
  'hook.banned_opener': {
    section: 2, check: 'HOOK', owner: 'editor', knobs: ['startAtLine'],
    note: 'cutlist.js opens on the first word of the sentence containing startAtLine',
  },
  'hook.no_headline': { section: 2, check: 'HOOK', owner: 'editor', knobs: ['hookLine'] },
  'hook.weak_opener': { section: 2, check: 'HOOK', owner: 'editor', knobs: ['startAtLine'] },

  // ---- §4 PACING ----
  'pacing.static_stretch': {
    section: 4, check: 'PACING', owner: 'editor', knobs: ['shotPlan', 'maxShotSec', 'punchFactor'],
    note: 'THE trial_06 bug. shot-plan.js re-cuts the picture on sentence/clause boundaries.',
  },
  'pacing.dead_air': { section: 5, check: 'PACING', owner: 'editor', knobs: ['silenceThreshold'] },
  'pacing.scale_jump': { section: 4, check: 'PACING', owner: 'editor', knobs: ['maxScaleRatio'] },

  // ---- §4/§5 VISUALS ----
  'visuals.face_too_tight': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['zoom'] },
  'visuals.face_tight': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['zoom'] },
  'visuals.face_too_loose': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['zoom'] },
  'visuals.punch_too_tight': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['punchZoomMax'] },
  'visuals.head_clipped': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['headroom'] },
  'visuals.room_visible': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['matte', 'backdrop'] },
  'visuals.matte_halo': { section: 5, check: 'VISUALS', owner: 'editor', knobs: ['matteErode', 'matteFeather', 'vignette'] },
  'visuals.shot_variety_static': {
    section: 4, check: 'VISUALS', owner: 'editor', knobs: ['shotPlan', 'punchFactor', 'maxShotSec'],
    note: 'THE trial_06 bug, seen from the vision reviewer instead of the frame-diff.',
  },

  // ---- §5 HUMAN ----
  'human.eyes_away_fail': {
    section: 5, check: 'HUMAN', owner: 'human',
    humanReason: 'Eye contact is a PERFORMANCE property of the take. §5 says cut to a better take, cover with product footage, or reshoot — and when every take has the same problem there is no better take to cut to. RESHOOT with the script directly under the lens, or supply Dossie screen footage to cover the worst stretches.',
    knobs: [],
  },
  'human.eyes_pattern': {
    section: 5, check: 'HUMAN', owner: 'human',
    humanReason: 'Same as above at warning severity: the gaze pattern is in the source. Editing can only hide it behind B-roll that does not exist yet.',
    knobs: [],
  },
  'human.delivery_weak': {
    section: 19, check: 'HUMAN', owner: 'human',
    humanReason: 'Delivery (energy, pace, confidence) is a property of the take. §19: say RESHOOT rather than hide a weak read behind transitions.',
    knobs: [],
  },

  // ---- §6/§7 AUDIO ----
  'audio.loudness': { section: 6, check: 'AUDIO', owner: 'editor', knobs: ['loudnessTarget'] },
  'audio.boxy': { section: 6, check: 'AUDIO', owner: 'editor', knobs: ['deroom'] },
  'audio.squashed': { section: 6, check: 'AUDIO', owner: 'editor', knobs: ['compressorRatio'] },
  'audio.muffled': { section: 6, check: 'AUDIO', owner: 'editor', knobs: ['denoiseStrength'] },
  'audio.harsh': { section: 6, check: 'AUDIO', owner: 'editor', knobs: ['deess', 'presenceDb'] },
  'audio.music_too_loud': { section: 7, check: 'AUDIO', owner: 'editor', knobs: ['musicVolume'] },
  'audio.missing_words': { section: 17, check: 'AUDIO', owner: 'editor', knobs: ['padStart', 'padEnd'] },
  'audio.chopped_fragment': { section: 17, check: 'AUDIO', owner: 'editor', knobs: ['padEnd'] },
  'audio.mid_splice': { section: 17, check: 'AUDIO', owner: 'editor', knobs: ['padStart', 'padEnd'] },
  'audio.sync_fail': { section: 17, check: 'AUDIO', owner: 'editor', knobs: ['audioOffsetMs'] },
  'audio.sync_warn': { section: 17, check: 'AUDIO', owner: 'editor', knobs: ['audioOffsetMs'] },
  'audio.unusable_source': {
    section: 19, check: 'AUDIO', owner: 'human',
    humanReason: 'Room reverb and a wrong-mic take cannot be removed, only reduced. §19 + the recording rules: RESHOOT on the DJI lav with the phone actually set to the receiver as its input source.',
    knobs: [],
  },

  // ---- §8 CAPTIONS ----
  'captions.coverage': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionCoverage'] },
  'captions.illegible': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionSize'] },
  'captions.busy_background': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionBox'] },
  'captions.over_face': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionMarginV'] },
  'captions.safe_zone': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionMarginV'] },
  'captions.no_emphasis': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['emphasisWords'] },
  'captions.verbatim': { section: 8, check: 'CAPTIONS', owner: 'editor', knobs: ['captionStyle'] },

  // ---- §9 STORY / B-ROLL ----
  'story.broll_missing': {
    section: 9, check: 'STORY', owner: 'human',
    humanReason: 'The named B-roll does not exist in Media/. §9 forbids inserting unrelated stock to fill the hole and §16 forbids implying a capability we do not have. Record the Dossie screen capture (or shoot the real thing) and add it to brief.brollInserts — edit.js already splices a clip it is given.',
    knobs: ['brollInserts'],
  },
  'story.weak_concept': {
    section: 3, check: 'STORY', owner: 'human',
    humanReason: '§3: a weak idea cannot be rescued with editing. This needs a different concept or a different script, not a different cut.',
    knobs: [],
  },

  // ---- §17 TECHNICAL ----
  'technical.black_frame': { section: 17, check: 'TECHNICAL', owner: 'editor', knobs: ['blackFrameGuard'] },
  'technical.clipped_last_word': { section: 17, check: 'TECHNICAL', owner: 'editor', knobs: ['padEnd', 'endHoldSec'] },
  'technical.fumbled_last_line': { section: 19, check: 'TECHNICAL', owner: 'editor', knobs: ['endAfterLine'] },
  'technical.no_lead_in_pad': { section: 17, check: 'TECHNICAL', owner: 'editor', knobs: ['padEnd'] },
  'technical.short_tail': { section: 17, check: 'TECHNICAL', owner: 'editor', knobs: ['endHoldSec'] },

  // ---- §17 CTA ----
  'cta.not_seen': { section: 17, check: 'CTA', owner: 'editor', knobs: ['ending', 'cta'] },
  'cta.too_short': { section: 17, check: 'CTA', owner: 'editor', knobs: ['endHoldSec'] },
};

/**
 * Every brief field edit.js (or a stage it invokes) actually reads. Kept here
 * so `--verify` can prove the registry does not promise a knob that does not
 * exist — the exact failure mode this file is meant to end.
 */
const EDITOR_KNOBS = new Set([
  // cut
  'silenceThreshold', 'padStart', 'padEnd', 'minKeep', 'startAtLine', 'endAfterLine', 'dropLines',
  // shot plan / framing
  'shotPlan', 'minShotSec', 'maxShotSec', 'punchFactor', 'maxScaleRatio', 'punchZoomMax',
  'openOnFace', 'openWide', 'jlCutSec', 'zoom', 'smooth', 'sampleEvery', 'headroom',
  'matte', 'backdrop', 'matteErode', 'matteFeather', 'vignette',
  // captions
  'hookLine', 'cta', 'emphasisWords', 'captionSize', 'captionMarginV', 'captionBox', 'captionStyle', 'captionCoverage',
  // audio
  'musicMood', 'musicVolume', 'deroom', 'audioOffsetMs', 'loudnessTarget',
  'compressorRatio', 'denoiseStrength', 'deess', 'presenceDb',
  // ending
  'ending', 'endHoldSec', 'endCardSec', 'cardTagline', 'blackFrameGuard',
  // b-roll
  'brollInserts',
]);

function lookup(id) { return REGISTRY[id] || null; }
function isEditorFixable(id) { const r = REGISTRY[id]; return !!r && r.owner === 'editor'; }
function humanReasonFor(id) { const r = REGISTRY[id]; return r && r.owner === 'human' ? r.humanReason : null; }

function summary() {
  const ids = Object.keys(REGISTRY);
  const editor = ids.filter(i => REGISTRY[i].owner === 'editor');
  const human = ids.filter(i => REGISTRY[i].owner === 'human');
  const badKnobs = [];
  for (const id of ids) for (const k of REGISTRY[id].knobs) if (!EDITOR_KNOBS.has(k)) badKnobs.push(`${id} -> ${k}`);
  return { total: ids.length, editorFixable: editor.length, humanOnly: human.length, human, knobsNotImplemented: badKnobs };
}

if (require.main === module) {
  const s = summary();
  console.log(`fix types: ${s.total}   editor-fixable: ${s.editorFixable}   human-only: ${s.humanOnly}`);
  if (s.knobsNotImplemented.length) {
    console.error('\nREGISTRY PROMISES KNOBS THAT DO NOT EXIST:');
    for (const b of s.knobsNotImplemented) console.error('  ' + b);
    process.exit(1);
  }
  console.log('\nhuman-only (no editor knob will ever fix these):');
  for (const id of s.human) console.log(`  ${id} (§${REGISTRY[id].section}) — ${REGISTRY[id].humanReason.split('.')[0]}.`);
  console.log('\neditor-fixable:');
  for (const id of Object.keys(REGISTRY)) if (REGISTRY[id].owner === 'editor') console.log(`  ${id} (§${REGISTRY[id].section}) -> ${REGISTRY[id].knobs.join(', ')}`);
}

module.exports = { REGISTRY, EDITOR_KNOBS, lookup, isEditorFixable, humanReasonFor, summary };
