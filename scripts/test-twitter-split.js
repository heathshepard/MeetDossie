// Dry-run for the rebuilt Twitter thread splitter.
// Mirrors the algorithm proposed for api/cron-publish-approved.js.
// Run: node scripts/test-twitter-split.js

const TWITTER_LIMIT = 280;
const NUMBERING_RESERVE = 5;          // " 6/6" = 4 chars; pad to 5 for safety
const HARD_LIMIT = TWITTER_LIMIT - NUMBERING_RESERVE; // 275
const MAX_CHUNKS = 6;
const MIN_CHUNK = 60;
const SKIP_BELOW = 20;

function splitForTwitter(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.length <= TWITTER_LIMIT) return [text];

  // 1. Paragraph split, drop bare-numbering markers ("1/", "2/", etc.).
  let paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  paragraphs = paragraphs.filter((p) => p.length >= SKIP_BELOW);

  // 2. Any single paragraph longer than HARD_LIMIT splits on sentences.
  const splitLong = [];
  for (const para of paragraphs) {
    if (para.length <= HARD_LIMIT) { splitLong.push(para); continue; }
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [para];
    let cur = '';
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const cand = cur ? cur + ' ' + s : s;
      if (cand.length <= HARD_LIMIT) { cur = cand; continue; }
      if (cur) splitLong.push(cur);
      cur = s;
    }
    if (cur) splitLong.push(cur);
  }
  paragraphs = splitLong;

  // 3. Merge any chunk below MIN_CHUNK (60) — prefer backward merge for
  //    narrative coherence (punchlines stick to their setup).
  const merged = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const cur = paragraphs[i];
    if (cur.length < MIN_CHUNK) {
      if (merged.length > 0) {
        const back = merged[merged.length - 1] + ' ' + cur;
        if (back.length <= HARD_LIMIT) {
          merged[merged.length - 1] = back;
          continue;
        }
      }
      if (i + 1 < paragraphs.length) {
        const fwd = cur + ' ' + paragraphs[i + 1];
        if (fwd.length <= HARD_LIMIT) {
          paragraphs[i + 1] = fwd;
          continue;
        }
      }
    }
    merged.push(cur);
  }
  paragraphs = merged;

  // 4. While count > MAX_CHUNKS (6), greedily merge the smallest adjacent pair.
  while (paragraphs.length > MAX_CHUNKS) {
    let bestIdx = -1;
    let bestSum = Infinity;
    for (let i = 0; i < paragraphs.length - 1; i++) {
      const sum = paragraphs[i].length + 1 + paragraphs[i + 1].length;
      if (sum <= HARD_LIMIT && sum < bestSum) {
        bestSum = sum;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // nothing more can be merged without overflow
    paragraphs[bestIdx] = paragraphs[bestIdx] + ' ' + paragraphs[bestIdx + 1];
    paragraphs.splice(bestIdx + 1, 1);
  }

  // Hard cap (defensive — should rarely fire after step 4).
  if (paragraphs.length > MAX_CHUNKS) paragraphs = paragraphs.slice(0, MAX_CHUNKS);

  // 5. Apply " i/N" numbering.
  const total = paragraphs.length;
  if (total <= 1) return paragraphs;
  return paragraphs.map((c, i) => `${c} ${i + 1}/${total}`);
}

const BRENDA_TWEET = `My TC was unreachable Friday afternoon. Option period ended Sunday. I found out Monday morning.

This is not a rare story.

1/

The thing nobody talks about: you're not just paying your TC to do paperwork. You're paying them to hold the anxiety you can't afford to carry during a live transaction.

2/

When they ghost you at 4:58pm Friday, the anxiety doesn't disappear. It just transfers back to you. At 9pm. On your couch.

3/

I've done deals where I knew every deadline cold because I had to. And deals where I trusted someone else and got burned.

The burnout isn't from working hard. It's from working scared.

4/

Dossie is an AI TC built for Texas agents. It doesn't take Fridays off. Founding price is $29/month: meetdossie.com/founding

5/

Anyone else had a TC go dark right before a deadline? Tell me it's not just me. 👇

6/`;

console.log(`Source content: ${BRENDA_TWEET.length} chars\n`);
console.log('═══════════════════════════════════════════════════════════════');
const chunks = splitForTwitter(BRENDA_TWEET);
console.log(`RESULT: ${chunks.length} chunks (limit ${MAX_CHUNKS})\n`);
chunks.forEach((c, i) => {
  console.log(`──── Tweet ${i + 1}/${chunks.length} (${c.length} chars) ────`);
  console.log(c);
  console.log('');
});

const max = Math.max(...chunks.map((c) => c.length));
const min = Math.min(...chunks.map((c) => c.length));
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Stats: ${chunks.length} chunks · longest ${max} chars · shortest ${min} chars`);
console.log(`Limits: ≤${TWITTER_LIMIT} per chunk · ≥${MIN_CHUNK} per chunk · ≤${MAX_CHUNKS} total`);
const overLimit = chunks.filter((c) => c.length > TWITTER_LIMIT).length;
const underMin = chunks.filter((c) => c.length < MIN_CHUNK).length;
console.log(`Violations: ${overLimit} over limit, ${underMin} under min, ${chunks.length > MAX_CHUNKS ? 1 : 0} over chunk cap`);
