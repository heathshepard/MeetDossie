#!/usr/bin/env node
/**
 * audio-diagnose.js — SOURCE audio facts the chain must know before it
 * touches a single sample: is a channel dead, and is the take clipping.
 *
 * Both were found on /mnt/c/Users/Heath/Downloads/20260922_124214.mp4
 * (2026-09-22) and both were being handled wrong:
 *
 * 1. DEAD CHANNEL. A single DJI lav into one input records to ONE channel.
 *    Measured: ch0 RMS -16.9 dB, ch1 RMS -92.0 dB with an -inf noise floor.
 *    The chain's two extraction points both used `-ac 1`, and ffmpeg's
 *    default stereo->mono downmix is (L+R)/2 — averaging a live channel
 *    with silence. That is a silent 6 dB loss of the ONLY signal in the
 *    file, and it looks like nothing is wrong: the transcript still comes
 *    back, the meters still move, it is just quietly half as loud and
 *    noisier for it. Downstream, the untouched stereo pair also means the
 *    delivered video plays the voice out of the left speaker only.
 *
 *    FIX: detect it, then FOLD — take the live channel and copy it to both
 *    sides at unity (`pan=stereo|c0=c0|c1=c0`). No level is lost and the
 *    result is true dual mono.
 *
 * 2. CLIPPING. Measured: true peak +0.6 dBFS, max_volume 0.0 dB, 1512
 *    samples pinned in the top histogram bin. The transmitter gain is too
 *    hot and there is no headroom left.
 *
 *    THIS IS NOT SILENTLY FIXABLE AND MUST NOT BE PRESENTED AS FIXED.
 *    Clipped peaks are destroyed information — the waveform above 0 dBFS
 *    was never recorded. Normalizing afterwards moves the flat tops down
 *    and makes the meters look fine while the distortion rides along at the
 *    same ratio. The only real fix happens at the transmitter, before the
 *    shoot, so the report has to reach Heath. A soft-limit repair pass is
 *    offered (`repairFilter`) because rounding the corners does reduce the
 *    harshness, but `report()` states plainly that it happened and that the
 *    take was recorded clipped.
 *
 * Usage:
 *   node scripts/video-engine/audio-diagnose.js --src <video/audio> [--json]
 *
 * Library:
 *   const AD = require('./audio-diagnose.js');
 *   const d = AD.diagnose(src);          // { channels, clipping, filters, findings }
 *   AD.report(d)                         // multi-line human report
 */
'use strict';
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

/**
 * Run ffmpeg and hand back STDERR — astats / volumedetect / ebur128 all
 * print their measurements there, not to stdout. Must be spawnSync:
 * execFileSync returns stdout only, so reading its return value here gives
 * an empty string and every measurement silently parses as null.
 */
function ffStderr(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return (r.stderr || '') + (r.stdout || '');
}

/**
 * A channel counts as DEAD when it is both absolutely negligible and
 * negligible RELATIVE to the loudest channel. Two tests, not one: an
 * absolute threshold alone would call a quiet-but-real room mic dead, and a
 * relative threshold alone would call both channels of a near-silent file
 * "one dead one live". A dead channel from an unused input measures around
 * -90 dB RMS with an -inf noise floor; a real but quiet channel does not.
 */
const DEAD_ABS_RMS_DB = -60;
const DEAD_REL_RMS_DB = 35;

/** analyzeChannels — per-channel astats on the source. */
function analyzeChannels(src) {
  const txt = ffStderr(['-i', src, '-map', '0:a:0', '-af', 'astats=reset=0', '-f', 'null', '-']);
  const chans = [];
  let cur = null;
  for (const line of txt.split('\n')) {
    const mCh = line.match(/Channel:\s*(\d+)/);
    if (mCh) { cur = { index: Number(mCh[1]) - 1 }; chans.push(cur); continue; }
    // astats closes with an "Overall" block in the SAME key: value shape and
    // with no Channel: header. Without this guard its numbers land in
    // whatever channel was parsed last — which read the dead right channel
    // back as -19.9 dB (the file's overall RMS) instead of -92.0 dB, and
    // made the dead channel invisible. Close the current channel here.
    if (/^\[Parsed_astats.*?\]\s*Overall\s*$/.test(line.trim()) || /^\s*Overall\s*$/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const grab = (label, key, parse = parseFloat) => {
      const m = line.match(new RegExp(`${label}:\\s*(-?[\\d.]+|-?inf|nan)`));
      if (m) cur[key] = (m[1] === '-inf' || m[1] === 'inf' || m[1] === 'nan') ? (m[1] === 'inf' ? Infinity : m[1] === 'nan' ? NaN : -Infinity) : parse(m[1]);
    };
    grab('RMS level dB', 'rmsDb');
    grab('Peak level dB', 'peakDb');
    grab('Noise floor dB', 'noiseFloorDb');
    grab('Flat factor', 'flatFactor');
  }
  // astats prints an unlabelled "Overall" block last; drop anything past the
  // real channel count reported by ffprobe.
  let declared = 2;
  try {
    declared = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', src]).toString().trim()) || 2;
  } catch { /* keep default */ }
  const channels = chans.slice(0, declared);

  const live = channels.filter(c => Number.isFinite(c.rmsDb));
  const loudest = live.length ? Math.max(...live.map(c => c.rmsDb)) : -Infinity;
  for (const c of channels) {
    const rms = Number.isFinite(c.rmsDb) ? c.rmsDb : -Infinity;
    c.dead = (rms < DEAD_ABS_RMS_DB) && ((loudest - rms) > DEAD_REL_RMS_DB);
  }
  const deadIdx = channels.filter(c => c.dead).map(c => c.index);
  const liveIdx = channels.filter(c => !c.dead).map(c => c.index);

  return {
    declaredChannels: declared,
    channels,
    loudestRmsDb: Number.isFinite(loudest) ? +loudest.toFixed(2) : null,
    deadChannels: deadIdx,
    liveChannels: liveIdx,
    // Only a true "one live, rest dead" case is foldable. All-dead is a
    // broken take, not something to fold.
    foldNeeded: deadIdx.length > 0 && liveIdx.length === 1 && declared > 1,
    allDead: liveIdx.length === 0,
  };
}

/**
 * channelFixFilter — the ffmpeg -af fragment that folds the one live channel
 * to every output channel at UNITY. Not a downmix: `-ac 1` / amerge average
 * the inputs, which is the 6 dB loss this whole module exists to stop.
 */
function channelFixFilter(chanInfo, outChannels = 2) {
  if (!chanInfo.foldNeeded) return null;
  const src = `c${chanInfo.liveChannels[0]}`;
  if (outChannels === 1) return `pan=mono|c0=${src}`;
  return `pan=stereo|c0=${src}|c1=${src}`;
}

/** clipping — true peak (ebur128) + how many samples are pinned at full scale. */
function analyzeClipping(src) {
  const vol = ffStderr(['-i', src, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-']);
  const ebu = ffStderr(['-i', src, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-']);

  const num = (txt, re) => { const m = txt.match(re); return m ? parseFloat(m[1]) : null; };
  const maxVolumeDb = num(vol, /max_volume:\s*(-?[\d.]+) dB/);
  const meanVolumeDb = num(vol, /mean_volume:\s*(-?[\d.]+) dB/);
  const hist0 = num(vol, /histogram_0db:\s*(\d+)/) || 0;
  const hist1 = num(vol, /histogram_1db:\s*(\d+)/) || 0;

  // ebur128's Summary block prints "True peak:\n    Peak:  X dBFS".
  let truePeakDb = null;
  const tpBlock = ebu.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  if (tpBlock) truePeakDb = parseFloat(tpBlock[1]);
  const integratedLufs = num(ebu, /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/);
  const lra = num(ebu, /LRA:\s*(-?[\d.]+)\s*LU/);

  // WHAT histogram_0db ACTUALLY IS (measured 2026-09-22, and it is not what
  // it looks like): volumedetect bins every sample by round(20*log10(|x|)),
  // so histogram_0db is the count in the TOP 1 dB BIN — everything from
  // about -0.5 dBFS upward — NOT the count of samples at full scale.
  //
  // On water.mp4 it reports 4289, and a direct scan of the decoded samples
  // finds 27 at or above full scale. Reporting the bin count as "samples
  // pinned at full scale" overstates the damage by ~160x and would have sent
  // Heath to re-shoot a take whose worst clip is two consecutive samples.
  // The bin count is kept because it is a genuine headroom signal, but it is
  // NAMED for what it is and the finding quotes the real count instead.
  const samplesInTopDbBin = hist0;
  const samplesAtFullScale = hist0; // provisional; diagnose() replaces this with the measured count
  const clipping = (maxVolumeDb != null && maxVolumeDb >= -0.05 && samplesAtFullScale > 0) ||
    (truePeakDb != null && truePeakDb > 0.0);

  let severity = 'none';
  if (clipping) {
    if (samplesAtFullScale > 20000 || (truePeakDb != null && truePeakDb > 3.0)) severity = 'severe';
    else if (samplesAtFullScale > 200 || (truePeakDb != null && truePeakDb > 0.3)) severity = 'moderate';
    else severity = 'marginal';
  }

  return {
    clipping, severity,
    truePeakDb, maxVolumeDb, meanVolumeDb,
    samplesAtFullScale, samplesInTopDbBin, samplesWithin1Db: hist1,
    integratedLufs, lra,
  };
}

/**
 * locateClipping — WHERE in the take the clipping is, in seconds.
 *
 * A total sample count answers "is it clipped" but not "does it matter".
 * 4,289 samples across 117 s is 0.008% of the take and could be either one
 * audible blown word or a dusting of single samples nobody will ever hear.
 * The difference is entirely in the clustering, so this decodes the live
 * channel and groups runs of full-scale samples into EVENTS.
 *
 * Heath asked to be told which WORD, not handed a percentage. The events
 * here carry timestamps so review.js can name the words from the transcript.
 *
 * Returns { events:[{startSec,endSec,samples,longestRunSamples}], totals }.
 */
function locateClipping(src, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const liveChannel = opts.liveChannel != null ? opts.liveChannel : 0;
  // Decode the live channel only, as float, so full scale is exactly 1.0.
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', src,
    '-map', '0:a:0', '-af', `pan=mono|c0=c${liveChannel}`,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-'],
    { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' });
  if (!r.stdout || !r.stdout.length) return { events: [], totals: { clippedSamples: 0 }, error: 'could not decode audio for clip location' };
  const buf = r.stdout;
  const n = Math.floor(buf.length / 4);
  const THRESH = opts.threshold || 0.9999;
  // Group clipped samples that are within GAP seconds of each other into one
  // event — a "word" is the unit Heath cares about, not a sample.
  const GAP = Math.round(sampleRate * (opts.gapSec || 0.05));
  const events = [];
  let cur = null, run = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(buf.readFloatLE(i * 4));
    if (v >= THRESH) {
      total++;
      run++;
      if (cur && i - cur.lastIdx <= GAP) { cur.samples++; cur.lastIdx = i; cur.longestRunSamples = Math.max(cur.longestRunSamples, run); }
      else { cur = { startIdx: i, lastIdx: i, samples: 1, longestRunSamples: 1 }; events.push(cur); }
    } else {
      run = 0;
    }
  }
  return {
    totals: { clippedSamples: total, totalSamples: n, fractionOfTake: n ? +(total / n).toExponential(2) : 0 },
    events: events.map(e => ({
      startSec: +(e.startIdx / sampleRate).toFixed(3),
      endSec: +(e.lastIdx / sampleRate).toFixed(3),
      samples: e.samples,
      longestRunSamples: e.longestRunSamples,
      // A single isolated sample at full scale is inaudible. A run of ~20+
      // consecutive samples at 48 kHz is ~0.4 ms of flat top, which is where
      // it starts to be audible as a harsh edge on a consonant.
      likelyAudible: e.longestRunSamples >= 20,
    })).sort((a, b) => b.samples - a.samples),
  };
}

/**
 * repairFilter — a soft limiter that rounds the clipped corners and pulls
 * the ceiling down under 0 dBFS. It REDUCES harshness. It does NOT undo
 * clipping; the samples above full scale were never recorded. Always paired
 * with a report line saying the take was recorded clipped.
 */
function repairFilter(clip) {
  if (!clip.clipping) return null;
  // Pull down by however far the true peak overshoots (plus 1 dB of room),
  // then soft-limit so nothing re-touches the ceiling.
  const over = Math.max(0, (clip.truePeakDb != null ? clip.truePeakDb : 0)) + 1.0;
  return `volume=${(-over).toFixed(2)}dB,alimiter=limit=0.891:level=false:attack=5:release=50`;
}

/** diagnose — everything, in one call. */
function diagnose(src) {
  if (!fs.existsSync(src)) throw new Error(`audio-diagnose: no such file ${src}`);
  const channels = analyzeChannels(src);
  const clipping = analyzeClipping(src);
  // WHERE the clipping is, not just how much. Only worth decoding the whole
  // take when there is clipping to locate.
  const clipLocations = clipping.clipping
    ? locateClipping(src, { liveChannel: channels.liveChannels.length ? channels.liveChannels[0] : 0 })
    : { events: [], totals: { clippedSamples: 0 } };
  clipping.events = clipLocations.events;
  clipping.audibleEvents = clipLocations.events.filter(e => e.likelyAudible);
  clipping.fractionOfTake = clipLocations.totals.fractionOfTake;
  // The MEASURED count of samples at/over full scale, replacing the top-bin
  // proxy from volumedetect (see analyzeClipping). Severity is re-graded on
  // the real number and on whether any run is long enough to hear, because
  // "27 isolated samples over 117 s" and "27000 samples in one word" are the
  // same headline number and completely different problems.
  if (clipLocations.totals.clippedSamples != null && !clipLocations.error) {
    clipping.samplesAtFullScale = clipLocations.totals.clippedSamples;
    clipping.longestRunSamples = clipLocations.events.reduce((m, e) => Math.max(m, e.longestRunSamples), 0);
    if (clipping.audibleEvents.length >= 3 || clipping.longestRunSamples >= 100) clipping.severity = 'severe';
    else if (clipping.audibleEvents.length >= 1) clipping.severity = 'moderate';
    else clipping.severity = 'marginal';
  }
  const findings = [];

  if (channels.allDead) {
    findings.push({
      id: 'audio-all-channels-dead', severity: 'blocker', forHeath: true,
      message: `Every audio channel is silent (loudest RMS ${channels.loudestRmsDb} dB). There is no usable audio in this take.`,
    });
  } else if (channels.foldNeeded) {
    const dead = channels.channels.filter(c => c.dead);
    findings.push({
      id: 'audio-dead-channel', severity: 'fixed', forHeath: true,
      message: `Dead audio channel: ch${dead.map(c => c.index).join(', ch')} is silent (${dead.map(c => `${c.rmsDb.toFixed(1)} dB RMS`).join(', ')}) while ch${channels.liveChannels[0]} carries the whole signal at ${channels.channels[channels.liveChannels[0]].rmsDb.toFixed(1)} dB. Single lav into one input. FOLDED the live channel to both sides at unity — a plain -ac 1 downmix here would have averaged the voice with silence and lost 6 dB of the only signal in the file.`,
    });
  }

  if (clipping.clipping) {
    findings.push({
      id: 'audio-clipping', severity: clipping.severity === 'severe' ? 'blocker' : 'warning', forHeath: true,
      message: `SOURCE RECORDED WITH NO HEADROOM. True peak ${clipping.truePeakDb != null ? clipping.truePeakDb.toFixed(1) : '?'} dBFS. ${clipping.samplesAtFullScale} sample(s) at or over full scale across ${clipping.events.length} event(s); longest unbroken run ${clipping.longestRunSamples || 0} sample(s); ${clipping.audibleEvents.length} event(s) long enough to likely be audible${clipping.audibleEvents.length ? ` (at ${clipping.audibleEvents.slice(0, 5).map(e => `${e.startSec}s`).join(', ')})` : ''}. ${clipping.samplesInTopDbBin} samples sit in the top 1 dB bin — that is the headroom problem, not the damage. Mean level ${clipping.meanVolumeDb != null ? clipping.meanVolumeDb.toFixed(1) : '?'} dB. ACTION FOR HEATH: lower the DJI transmitter gain before the next take — aim for peaks around -6 dBFS. Whatever clipping did occur is NOT fixable in post: the waveform above full scale was never recorded, and normalizing only moves the flat tops down while the distortion rides along unchanged.`,
    });
  }

  return {
    src,
    channels,
    clipping,
    filters: {
      channelFix: channelFixFilter(channels, 2),
      channelFixMono: channelFixFilter(channels, 1),
      clipRepair: repairFilter(clipping),
    },
    findings,
  };
}

/** report — the loud, human version. Callers print this; it is never silent. */
function report(d) {
  const L = [];
  L.push('--- SOURCE AUDIO DIAGNOSIS ---');
  L.push(`channels: ${d.channels.declaredChannels} declared` +
    d.channels.channels.map(c => ` | ch${c.index} RMS ${Number.isFinite(c.rmsDb) ? c.rmsDb.toFixed(1) : '-inf'} dB peak ${Number.isFinite(c.peakDb) ? c.peakDb.toFixed(1) : '-inf'} dB${c.dead ? '  <== DEAD' : ''}`).join(''));
  if (d.filters.channelFix) L.push(`channel fix: ${d.filters.channelFix}  (fold live channel to both sides at unity — NOT a -ac 1 downmix)`);
  else if (!d.channels.allDead) L.push('channel fix: none needed (no dead channel)');
  L.push(`clipping: ${d.clipping.clipping ? `YES (${d.clipping.severity})` : 'no'} | true peak ${d.clipping.truePeakDb} dBFS | ${d.clipping.samplesAtFullScale} samples at/over full scale (longest run ${d.clipping.longestRunSamples || 0}) | ${d.clipping.samplesInTopDbBin} in the top 1 dB bin | mean ${d.clipping.meanVolumeDb} dB | integrated ${d.clipping.integratedLufs} LUFS`);
  if (d.clipping.events && d.clipping.events.length) {
    L.push(`clip events: ${d.clipping.events.length} total, ${d.clipping.audibleEvents.length} likely audible (run >= 20 samples). Top by sample count:`);
    for (const e of d.clipping.events.slice(0, 8)) L.push(`   ${e.startSec}s-${e.endSec}s  ${e.samples} samples, longest run ${e.longestRunSamples}${e.likelyAudible ? '  <== likely audible' : ''}`);
  }
  for (const f of d.findings) L.push(`[${f.severity.toUpperCase()}] ${f.id}: ${f.message}`);
  L.push('------------------------------');
  return L.join('\n');
}

function main() {
  const a = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); args[k] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true; }
  if (!args.src) { console.error('Usage: audio-diagnose.js --src <video/audio> [--json]'); process.exit(1); }
  const d = diagnose(args.src);
  if (args.json) console.log(JSON.stringify(d, null, 2));
  else console.log(report(d));
}

module.exports = { diagnose, report, analyzeChannels, analyzeClipping, locateClipping, channelFixFilter, repairFilter };
if (require.main === module) main();
