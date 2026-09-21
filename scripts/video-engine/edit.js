#!/usr/bin/env node
/**
 * edit.js — the orchestrator. One command, raw footage + a brief JSON in,
 * a finished 1080x1920 H.264 reel out.
 *
 * Chain: transcribe (ElevenLabs scribe_v1) -> cutlist (silence/um/false-start
 * removal) -> trim+concat render -> face-tracked auto-frame crop -> burn
 * captions (libass) -> mix background music -> final encode -> quality gate.
 *
 * Background separation (matte.js) is NOT in the default chain — it's the
 * slowest stage (real measured throughput in Media/video-engine-proto/
 * matte-test/matte-report.json) and the edge quality has known failure modes
 * on fast hand motion (see report). Turn it on with --matte; it composites
 * AFTER the crop, using the face-crop output as its input frames, over
 * --backdrop (defaults to the synthetic workspace backdrop — swap for a real
 * photo when available, see gen-workspace-backdrop.js).
 *
 * B-roll inserts: brief.brollInserts = [{ "atSec": 12, "path": "...", "durationSec": 2.5 }]
 * (post-cut timeline seconds). Spliced in as a hard cut-to-cutaway-and-back.
 *
 * Usage:
 *   node scripts/video-engine/edit.js --src <raw.mp4> --brief <brief.json> --out <final.mp4> [--matte] [--workdir <dir>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const val = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const ROOT = path.join(__dirname, '..', '..');
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}
function node(scriptRel, args) { run('node', [path.join(__dirname, scriptRel), ...args]); }

function ffprobeJson(file, entries) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { cwd: ROOT }).toString();
  return JSON.parse(out);
}

function main() {
  const args = parseArgs();
  const src = args.src, briefPath = args.brief, finalOut = args.out;
  const useMatte = !!args.matte;
  const workDir = args.workdir || path.join(ROOT, '.tmp', `edit-${Date.now()}`);
  if (!src || !briefPath || !finalOut) {
    console.error('Usage: edit.js --src <raw.mp4> --brief <brief.json> --out <final.mp4> [--matte] [--workdir <dir>]');
    process.exit(1);
  }
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  fs.mkdirSync(workDir, { recursive: true });
  const p = (name) => path.join(workDir, name);

  console.log(`=== Dossie local video engine ===\nsrc: ${src}\nbrief: ${briefPath}\nworkdir: ${workDir}\nmatte: ${useMatte}`);

  // 1. Extract 16kHz mono audio + transcribe.
  run('ffmpeg', ['-y', '-i', src, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', p('audio-16k.wav'), '-hide_banner', '-loglevel', 'error']);
  node('transcribe.js', ['--audio', p('audio-16k.wav'), '--out', p('transcript.json')]);

  // 2. Cut list (silence / filler / false-start removal).
  node('cutlist.js', ['--transcript', p('transcript.json'), '--out', p('cutlist.json')]);

  // 3. Trim + concat render (full source resolution, kept as an intermediate).
  node('render-cutlist.js', ['--src', src, '--cutlist', p('cutlist.json'), '--out', p('trimmed.mp4')]);

  // 4. Face-tracked auto-frame crop.
  const trimmedMeta = ffprobeJson(p('trimmed.mp4'), 'format=duration:stream=width,height,r_frame_rate');
  const fps = trimmedMeta.streams[0].r_frame_rate.split('/').reduce((a, b) => a / b);
  fs.mkdirSync(p('frames'), { recursive: true });
  run('ffmpeg', ['-y', '-i', p('trimmed.mp4'), p('frames/f%05d.png'), '-hide_banner', '-loglevel', 'error']);
  node('face-track-crop.js', [
    '--frames', p('frames'), '--out', p('cropped'),
    '--zoom', String(brief.zoom || 1.2), '--smooth', String(brief.smooth || 0.18),
    '--sampleEvery', String(brief.sampleEvery || 4),
  ]);

  let videoFramesDir = p('cropped/cropped');

  // 5. Optional background separation (off by default — see file header).
  if (useMatte) {
    const backdrop = args.backdrop || p('workspace-backdrop.png');
    if (!fs.existsSync(backdrop)) node('gen-workspace-backdrop.js', [backdrop]);
    node('matte.js', ['--frames', videoFramesDir, '--out', p('matte'), '--backdrop', backdrop]);
    videoFramesDir = p('matte/comp-workspace');
  }

  // 6. Reassemble cropped(+matted) frames with the trimmed audio.
  run('ffmpeg', ['-y', '-framerate', String(Math.round(fps)), '-i', path.join(videoFramesDir, 'f%05d.png'),
    '-i', p('trimmed.mp4'), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', p('reassembled.mp4'), '-hide_banner', '-loglevel', 'error']);

  // 7. Captions (ASS, burned in via libass — no drawtext in this ffmpeg build).
  node('captions.js', ['--transcript', p('transcript.json'), '--cutlist', p('cutlist.json'), '--brief', briefPath, '--out', p('captions.ass')]);

  // 8. B-roll inserts (simple hard-cut splice at post-cut timeline seconds).
  let withBroll = p('reassembled.mp4');
  if (Array.isArray(brief.brollInserts) && brief.brollInserts.length) {
    // Build a concat list alternating main-video segments and b-roll clips.
    const dur = parseFloat(ffprobeJson(p('reassembled.mp4'), 'format=duration').format.duration);
    const inserts = [...brief.brollInserts].sort((a, b) => a.atSec - b.atSec);
    const segList = p('broll-segments.txt');
    const lines = [];
    let cursor = 0;
    inserts.forEach((ins, i) => {
      const mainSeg = p(`broll-main-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', p('reassembled.mp4'), '-ss', String(cursor), '-to', String(ins.atSec),
        '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', mainSeg, '-hide_banner', '-loglevel', 'error']);
      lines.push(`file '${mainSeg}'`);
      const brollClip = p(`broll-clip-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', ins.path, '-t', String(ins.durationSec), '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-an', '-c:v', 'libx264', '-crf', '18', brollClip, '-hide_banner', '-loglevel', 'error']);
      // Give the b-roll silent audio track matching duration so concat audio streams line up.
      const brollWithAudio = p(`broll-clip-audio-${i}.mp4`);
      run('ffmpeg', ['-y', '-i', brollClip, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
        '-c:v', 'copy', '-c:a', 'aac', brollWithAudio, '-hide_banner', '-loglevel', 'error']);
      lines.push(`file '${brollWithAudio}'`);
      cursor = ins.atSec;
    });
    const tailSeg = p('broll-tail.mp4');
    run('ffmpeg', ['-y', '-i', p('reassembled.mp4'), '-ss', String(cursor), '-to', String(dur),
      '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', tailSeg, '-hide_banner', '-loglevel', 'error']);
    lines.push(`file '${tailSeg}'`);
    fs.writeFileSync(segList, lines.join('\n'));
    run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', segList, '-c', 'copy', p('with-broll.mp4'), '-hide_banner', '-loglevel', 'error']);
    withBroll = p('with-broll.mp4');
  }

  // 9. Music (ducked under voice) + captions + final scale in one pass.
  const musicMood = brief.musicMood;
  const musicVolume = brief.musicVolume != null ? brief.musicVolume : 0.12;
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'Media/Music/manifest.json'), 'utf8'));
  const track = musicMood ? manifest.find(m => m.mood === musicMood) : null;

  const vf = `ass=${p('captions.ass').replace(/:/g, '\\:')},scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`;
  // Voice cleanup: RNNoise (arnndn) beats afftdn by ~16dB of noise floor on
  // measured real footage — see Media/video-engine-proto/audio-cleanup/verdict.json.
  const rnnoiseModel = args.rnnoiseModel || path.join(ROOT, 'models', 'rnnoise-mp.rnnn');
  const denoiseAvailable = fs.existsSync(rnnoiseModel);
  const voiceDenoise = denoiseAvailable ? `arnndn=m=${rnnoiseModel.replace(/:/g, '\\:')}` : null;
  if (!denoiseAvailable) console.warn(`WARNING: RNNoise model not found at ${rnnoiseModel} — skipping voice denoise. Run scripts/video-engine/download-models.sh.`);

  if (track) {
    const musicPath = path.join(ROOT, 'Media/Music', track.file);
    const voiceChain = voiceDenoise ? `[0:a]${voiceDenoise}[voice]` : `[0:a]anull[voice]`;
    run('ffmpeg', ['-y', '-i', withBroll, '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex', `[0:v]${vf}[vout];${voiceChain};[1:a]volume=${musicVolume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
      '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', finalOut, '-hide_banner', '-loglevel', 'error']);
  } else {
    const af = voiceDenoise ? `${voiceDenoise},loudnorm=I=-16:TP=-1.5:LRA=11` : 'loudnorm=I=-16:TP=-1.5:LRA=11';
    run('ffmpeg', ['-y', '-i', withBroll,
      '-vf', vf, '-af', af,
      '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', finalOut, '-hide_banner', '-loglevel', 'error']);
  }

  // 10. Quality gate.
  const meta = ffprobeJson(finalOut, 'format=duration:stream=width,height,codec_name');
  const vStream = meta.streams.find(s => s.width);
  const durOk = parseFloat(meta.format.duration) > 3;
  const resOk = vStream && vStream.width === 1080 && vStream.height === 1920;
  const astats = execFileSync('ffmpeg', ['-i', finalOut, '-af', 'astats=metadata=0:measure_perchannel=none', '-f', 'null', '-'],
    { cwd: ROOT }).toString();
  const meanMatch = /Overall.*?\n.*?RMS level dB: ([\-\d.]+)/s;
  const gate = {
    durationSec: parseFloat(meta.format.duration),
    resolution: vStream ? `${vStream.width}x${vStream.height}` : null,
    resolutionOk: !!resOk,
    durationOk: durOk,
    hasAudioTrack: meta.streams.some(s => s.codec_name === 'aac'),
  };
  gate.pass = gate.resolutionOk && gate.durationOk && gate.hasAudioTrack;
  fs.writeFileSync(p('quality-gate.json'), JSON.stringify(gate, null, 2));
  console.log('\n=== QUALITY GATE ===');
  console.log(JSON.stringify(gate, null, 2));
  console.log(`\nFinal output: ${finalOut}`);
  if (!gate.pass) { console.error('QUALITY GATE FAILED'); process.exit(1); }
}

main();
