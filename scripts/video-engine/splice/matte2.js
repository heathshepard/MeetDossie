#!/usr/bin/env node
/**
 * matte2.js -- RVM alpha matte, streamed, with no `sharp` dependency.
 *
 * The repo's matte.js needs sharp for PNG encode/decode, and sharp is not
 * present in MeetDossie/node_modules on this box (onnxruntime-node is). Since
 * rule 4 only wants the ALPHA from the 640px pass -- RGB comes from the 1080
 * master and the two are rejoined with alphaextract/alphamerge -- we can skip
 * PNG entirely: decode rgb24 straight off an ffmpeg pipe, run the model, and
 * push gray8 alpha straight into a second ffmpeg. No 2GB of intermediate PNGs.
 *
 * Usage: node matte2.js --in <video> --w 640 --model <onnx> --out <alpha.mkv>
 */
const { spawn } = require('child_process');
const ort = require('onnxruntime-node');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++)
    if (a[i].startsWith('--')) o[a[i].slice(2)] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
  return o;
}

(async () => {
  const A = args();
  const W = parseInt(A.w || '640', 10);

  // probe source dimensions so the 640-wide matte keeps the master's aspect
  const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames', '-of', 'default=nw=1:nk=1', A.in]);
  let pb = '';
  probe.stdout.on('data', d => pb += d);
  await new Promise(r => probe.on('close', r));
  const [sw, sh] = pb.trim().split('\n').map(Number);
  const H = Math.round(sh * W / sw / 2) * 2;
  const frameBytes = W * H * 3;
  console.log(`source ${sw}x${sh} -> matte ${W}x${H} (${frameBytes} B/frame)`);

  const dec = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', A.in,
    '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { stdio: ['ignore', 'pipe', 'inherit'] });

  // alpha goes straight out as a lossless gray track, already upscaled to
  // the master's own resolution so alphamerge has nothing to guess about.
  const enc = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', '30', '-i', '-',
    '-vf', `scale=${sw}:${sh}:flags=bicubic,format=gray`,
    '-c:v', 'ffv1', '-r', '30', A.out],
    { stdio: ['pipe', 'inherit', 'inherit'] });

  console.log('loading model', A.model);
  const session = await ort.InferenceSession.create(A.model, { executionProviders: ['cpu'] });
  let r1i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r2i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r3i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r4i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  const downsample = new ort.Tensor('float32',
    new Float32Array([Math.min(512 / Math.max(W, H), 1.0)]), [1]);

  const plane = W * H;
  const chw = new Float32Array(3 * plane);
  const gray = Buffer.alloc(plane);
  let pending = Buffer.alloc(0);
  let n = 0, t0 = Date.now();

  const writeFrame = buf => new Promise(res => {
    if (enc.stdin.write(buf)) res(); else enc.stdin.once('drain', res);
  });

  const queue = [];
  dec.stdout.on('data', d => { queue.push(d); });
  let done = false;
  dec.stdout.on('end', () => { done = true; });

  const nextFrame = async () => {
    while (pending.length < frameBytes) {
      if (queue.length) { pending = Buffer.concat([pending, queue.shift()]); continue; }
      if (done) return null;
      await new Promise(r => setTimeout(r, 2));
    }
    const f = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    return f;
  };

  for (;;) {
    const f = await nextFrame();
    if (!f) break;
    for (let p = 0; p < plane; p++) {
      chw[p] = f[p * 3] / 255;
      chw[plane + p] = f[p * 3 + 1] / 255;
      chw[2 * plane + p] = f[p * 3 + 2] / 255;
    }
    const res = await session.run({
      src: new ort.Tensor('float32', chw, [1, 3, H, W]),
      r1i, r2i, r3i, r4i, downsample_ratio: downsample,
    });
    r1i = res.r1o; r2i = res.r2o; r3i = res.r3o; r4i = res.r4o;
    const pha = res.pha.data;
    for (let p = 0; p < plane; p++) {
      const v = pha[p] * 255;
      gray[p] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    await writeFrame(Buffer.from(gray));
    if (++n % 50 === 0) process.stdout.write(`frame ${n} (${Math.round(n / ((Date.now() - t0) / 1000) * 10) / 10} fps)\r`);
  }
  enc.stdin.end();
  await new Promise(r => enc.on('close', r));
  console.log(`\nmatte done: ${n} frames in ${Math.round((Date.now() - t0) / 1000)}s -> ${A.out}`);
})().catch(e => { console.error(e); process.exit(1); });
