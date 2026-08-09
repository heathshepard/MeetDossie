#!/usr/bin/env node
// Build static "How Dossie Handles X" product-feature pages from JSON data
// files in marketing/features-data/. Each JSON file → features/<slug>/index.html.
// Vercel serves them at /features/<slug>.
//
// Different content type from /guides/ (TREC-form explainers, long-form) and
// /answers/ (AEO citation targets, comparison-heavy): these are short product
// walkthroughs built around a real screenshot — lead with the image, keep the
// copy skimmable. Heath's own feedback on the guide pages was "too wordy" —
// don't repeat that here.
//
// Run: node scripts/build-features.js
// Idempotent — safe to re-run after editing data files. Overwrites generated HTML.
//
// Sitemap: this script deliberately does NOT write sitemap.xml. build-guides.js
// is the canonical last-run sitemap writer (it already folds in answers-data
// slugs so build-answers.js running first doesn't drop them — see its
// loadAnswerSlugs()). This script's slugs are folded in the same way via
// loadFeatureSlugs() in build-guides.js. Build order: build-answers.js,
// build-features.js, then build-guides.js LAST.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'marketing', 'features-data');
const OUT_DIR = path.join(ROOT, 'features');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function renderFaqSchema(faq) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });
}

function renderBreadcrumbSchema(slug, title) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://meetdossie.com/' },
      { '@type': 'ListItem', position: 2, name: 'Features', item: 'https://meetdossie.com/features/' },
      { '@type': 'ListItem', position: 3, name: title, item: `https://meetdossie.com/features/${slug}` },
    ],
  });
}

function renderArticleSchema(f) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: f.title,
    description: f.meta_description,
    image: `https://meetdossie.com${f.image}`,
    author: { '@type': 'Person', name: 'Heath Shepard', jobTitle: 'Texas REALTOR®' },
    publisher: { '@type': 'Organization', name: 'Dossie', url: 'https://meetdossie.com' },
    mainEntityOfPage: `https://meetdossie.com/features/${f.slug}`,
    datePublished: f.published_at || f.updated_at || '2026-08-07',
    dateModified: f.updated_at || f.published_at || '2026-08-07',
  });
}

function renderFaqHtml(faq) {
  if (!faq || !faq.length) return '';
  return faq.map((f) => `
    <details class="faq-item">
      <summary class="faq-q">${escapeHtml(f.q)} <span class="faq-toggle">+</span></summary>
      <div class="faq-a">${f.a_html || escapeHtml(f.a)}</div>
    </details>`).join('');
}

function renderSteps(steps) {
  if (!steps || !steps.length) return '';
  return `<div class="step-list">${steps.map((s) => `
    <div class="step">
      <h3>${escapeHtml(s.h)}</h3>
      <p>${s.p_html || escapeHtml(s.p)}</p>
    </div>`).join('')}</div>`;
}

function renderRelated(related, allFeatures) {
  if (!related || related.length === 0) return '';
  const tiles = related.map((slug) => {
    const f = allFeatures.find((x) => x.slug === slug);
    if (!f) return '';
    return `<a class="related-card" href="/features/${slug}"><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.related_blurb || f.meta_description.slice(0, 110))}</p><span class="related-arrow">→</span></a>`;
  }).filter(Boolean).join('');
  return tiles ? `<section class="related"><h2>More features</h2><div class="related-grid">${tiles}</div></section>` : '';
}

function template(f, allFeatures) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(f.meta_title || f.title)}</title>
<meta name="description" content="${escapeAttr(f.meta_description)}">
<link rel="canonical" href="https://meetdossie.com/features/${f.slug}">
<meta name="author" content="Heath Shepard, Texas REALTOR®">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeAttr(f.title)}">
<meta property="og:description" content="${escapeAttr(f.meta_description)}">
<meta property="og:image" content="https://meetdossie.com${f.image}">
<meta property="og:url" content="https://meetdossie.com/features/${f.slug}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="/assets/posthog-loader.js"></script>

<script type="application/ld+json">${renderArticleSchema(f)}</script>
<script type="application/ld+json">${renderBreadcrumbSchema(f.slug, f.title)}</script>
${f.faq && f.faq.length ? `<script type="application/ld+json">${renderFaqSchema(f.faq)}</script>` : ''}

<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #FDFCFA; --bg-warm: #F9F6F1; --bg-card: #FFFFFF;
  --border: #E8E2D9; --border-light: #F0EBE3;
  --text-primary: #2D2A26; --text-secondary: #7A7468; --text-light: #A39E94;
  --blush: #D4A0A0; --blush-light: #F2E4E4; --blush-deep: #C08080;
  --sage: #8FAF8F; --sage-light: #E4EDE2; --sage-deep: #6B8E68;
  --gold: #C9A84C; --gold-light: #F5EDD8; --gold-deep: #A48531;
  --coral: #E8836B; --coral-light: #FCE4DC; --coral-deep: #C9624A;
}
html { scroll-behavior: smooth; }
body { font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text-primary); line-height: 1.65; -webkit-font-smoothing: antialiased; }
a { color: var(--coral-deep); }

nav { position: sticky; top: 0; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; background: rgba(253,252,250,0.92); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border-light); }
.nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.nav-mark { width: 36px; height: 36px; border-radius: 12px; background: linear-gradient(135deg, var(--blush) 0%, var(--gold) 100%); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; color: #fff; font-family: 'Cormorant Garamond', serif; }
.nav-name { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.3px; }
.nav-cta { display: inline-flex; align-items: center; padding: 10px 18px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; box-shadow: 0 8px 20px rgba(232,131,107,0.28); }
.nav-cta:hover { background: var(--coral-deep); }

.crumbs { max-width: 860px; margin: 32px auto 0; padding: 0 24px; font-size: 12px; color: var(--text-light); letter-spacing: 0.4px; }
.crumbs a { color: var(--text-secondary); text-decoration: none; }

.article-hero { padding: 28px 24px 8px; max-width: 860px; margin: 0 auto; text-align: center; }
.article-eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--coral-deep); }
.article-hero h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(32px, 5.2vw, 48px); font-weight: 600; line-height: 1.08; letter-spacing: -1px; color: var(--text-primary); margin-top: 10px; }
.article-hero h1 em { font-style: italic; color: var(--blush-deep); }
.article-hero .deck { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 19px; color: var(--text-secondary); margin: 14px auto 0; max-width: 620px; }
.article-meta { font-size: 13px; color: var(--text-secondary); margin-top: 18px; display: flex; gap: 18px; flex-wrap: wrap; align-items: center; justify-content: center; }
.article-meta strong { color: var(--text-primary); font-weight: 700; }

.listen-btn { margin-top: 20px; display: inline-flex; align-items: center; gap: 10px; padding: 11px 20px 11px 16px; border: 1px solid var(--blush); border-radius: 999px; background: var(--blush-light); color: var(--blush-deep); font-family: 'Plus Jakarta Sans', sans-serif; font-size: 14px; font-weight: 700; cursor: pointer; transition: background 0.15s, transform 0.15s; }
.listen-btn:hover { background: var(--blush); color: #fff; transform: translateY(-1px); }
.listen-icon { display: inline-flex; width: 16px; height: 16px; }
.listen-spin { animation: listen-spin 0.9s linear infinite; }
@keyframes listen-spin { to { transform: rotate(360deg); } }

.shot-wrap { max-width: 980px; margin: 36px auto 0; padding: 0 24px; }
.browser-frame { background: var(--bg-card); border: 1px solid var(--border); border-radius: 18px; overflow: hidden; box-shadow: 0 24px 64px rgba(26,26,46,0.10); }
.browser-chrome { display: flex; align-items: center; gap: 6px; padding: 11px 16px; background: var(--bg-warm); border-bottom: 1px solid var(--border-light); }
.browser-chrome .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.browser-chrome .dot-r { background: #E8836B; }
.browser-chrome .dot-y { background: #C9A96E; }
.browser-chrome .dot-g { background: #8BA888; }
.browser-url { margin-left: 10px; font-size: 11.5px; color: var(--text-light); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 100px; padding: 3px 12px; font-weight: 500; }
.browser-frame img { display: block; width: 100%; height: auto; }
.shot-caption { text-align: center; font-size: 13.5px; color: var(--text-secondary); margin-top: 14px; }

main.article { max-width: 700px; margin: 0 auto; padding: 40px 24px 0; }
main.article > .intro p { font-size: 17px; color: var(--text-primary); line-height: 1.8; margin: 0 0 8px; }

.step-list { margin-top: 32px; display: flex; flex-direction: column; gap: 20px; }
.step { padding: 20px 22px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; }
.step h3 { font-family: 'Cormorant Garamond', serif; font-size: 20px; font-weight: 600; color: var(--blush-deep); margin-bottom: 6px; }
.step p { font-size: 15px; color: var(--text-primary); line-height: 1.65; }
.step p strong { font-weight: 700; }

.callout { margin: 28px 0 4px; padding: 18px 22px; background: var(--blush-light); border-radius: 14px; font-size: 15.5px; line-height: 1.65; color: var(--text-primary); border: 1px solid var(--blush); font-family: 'Cormorant Garamond', serif; font-style: italic; }

.cta-block { margin: 52px auto 0; max-width: 700px; padding: 36px 28px; background: linear-gradient(180deg, var(--bg-card) 0%, var(--blush-light) 220%); border: 1px solid var(--blush); border-radius: 22px; text-align: center; }
.cta-block h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(22px, 3.4vw, 30px); font-weight: 600; color: var(--text-primary); margin-bottom: 8px; line-height: 1.2; }
.cta-block p { color: var(--text-secondary); font-size: 15px; max-width: 560px; margin: 0 auto 18px; }
.cta-btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 14px; font-weight: 700; text-decoration: none; box-shadow: 0 12px 30px rgba(232,131,107,0.28); transition: transform 0.15s, background 0.15s; }
.cta-btn:hover { transform: translateY(-1px); background: var(--coral-deep); }

.faq-section { max-width: 700px; margin: 52px auto 0; padding: 0 24px; }
.faq-section h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(22px, 3.2vw, 28px); font-weight: 600; color: var(--text-primary); }
.faq-list { margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }
.faq-item { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; overflow: hidden; }
.faq-item[open] { border-color: var(--blush); }
.faq-q { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 16px 20px; cursor: pointer; font-family: 'Cormorant Garamond', serif; font-size: 18px; font-weight: 600; color: var(--text-primary); list-style: none; }
.faq-q::-webkit-details-marker { display: none; }
.faq-toggle { width: 24px; height: 24px; border-radius: 50%; background: var(--bg-warm); display: inline-flex; align-items: center; justify-content: center; font-size: 15px; color: var(--text-secondary); flex-shrink: 0; transition: transform 0.2s, background 0.2s; }
.faq-item[open] .faq-toggle { transform: rotate(45deg); background: var(--coral-light); color: var(--coral-deep); }
.faq-a { padding: 0 20px 18px; font-size: 14.5px; color: var(--text-secondary); line-height: 1.7; }

.related { max-width: 980px; margin: 60px auto 0; padding: 0 24px; }
.related h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(22px, 3.2vw, 28px); font-weight: 600; color: var(--text-primary); }
.related-grid { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.related-card { display: block; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; padding: 22px 22px 26px; text-decoration: none; color: var(--text-primary); transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
.related-card:hover { transform: translateY(-2px); border-color: var(--blush); box-shadow: 0 14px 32px rgba(45,42,38,0.06); }
.related-card h3 { font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; color: var(--text-primary); line-height: 1.25; margin-bottom: 6px; }
.related-card p { font-size: 13.5px; color: var(--text-secondary); line-height: 1.55; }
.related-arrow { display: inline-block; margin-top: 8px; font-size: 14px; color: var(--coral-deep); font-weight: 700; }

.legal { padding: 24px; text-align: center; font-size: 12px; color: var(--text-light); line-height: 1.6; max-width: 700px; margin: 28px auto 0; }
.legal a { color: var(--text-secondary); }

@media (max-width: 640px) { .article-hero { text-align: left; } .article-meta { justify-content: flex-start; } }
</style>
</head>
<body>

<nav>
  <a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a>
  <a href="/app" class="nav-cta">Get Started</a>
</nav>

<div class="crumbs">
  <a href="/">Home</a> · <a href="/features/">Features</a> · <span>${escapeHtml(f.title)}</span>
</div>

<header class="article-hero">
  <div class="article-eyebrow">${escapeHtml(f.eyebrow || 'Product feature')}</div>
  <h1>${f.title_html || escapeHtml(f.title)}</h1>
  <p class="deck">${escapeHtml(f.deck || f.meta_description)}</p>
  <div class="article-meta">
    <span>By <strong>Heath Shepard</strong>, Texas REALTOR®</span>
    <span>Updated ${escapeHtml(f.updated_at || '2026-08-07')}</span>
  </div>
  <button id="dossie-listen-btn" class="listen-btn" type="button" data-type="feature" data-slug="${escapeAttr(f.slug)}" data-idle-label="Listen to this page">
    <span class="listen-icon"></span>
    <span class="listen-label">Listen to this page</span>
  </button>
  <audio id="dossie-listen-audio" preload="none"></audio>
</header>

<div class="shot-wrap">
  <div class="browser-frame">
    <div class="browser-chrome">
      <span class="dot dot-r"></span><span class="dot dot-y"></span><span class="dot dot-g"></span>
      <span class="browser-url">meetdossie.com/workspace</span>
    </div>
    <img src="${escapeAttr(f.image)}" alt="${escapeAttr(f.image_alt || f.title)}" loading="eager" width="1440" height="900">
  </div>
  ${f.image_caption ? `<p class="shot-caption">${escapeHtml(f.image_caption)}</p>` : ''}
</div>

<main class="article">
  <div class="intro">${f.intro_html || ''}</div>
  ${renderSteps(f.steps)}
  ${f.callout ? `<div class="callout">${escapeHtml(f.callout)}</div>` : ''}
</main>

<section class="cta-block">
  <h2>${escapeHtml(f.cta_title || 'See it on your own contract.')}</h2>
  <p>${escapeHtml(f.cta_sub || 'Dossie handles the busywork on every active deal — built for Texas agents.')}</p>
  <a class="cta-btn" href="/app">Start for $149/mo →</a>
</section>

${f.faq && f.faq.length ? `
<section class="faq-section">
  <h2>Frequently asked</h2>
  <div class="faq-list">${renderFaqHtml(f.faq)}</div>
</section>` : ''}

${renderRelated(f.related_features, allFeatures)}

<p class="legal">
  Screenshots shown are real Dossie product screens, not mockups. This page is provided as-is for informational purposes. <a href="/">meetdossie.com</a>
</p>

<script src="/assets/article-audio.js" defer></script>

<script>
(function () {
  try {
    document.addEventListener('posthog:ready', function () {
      try {
        window.posthog.capture('guide_page_viewed', {
          page_type: 'feature',
          page_slug: ${JSON.stringify(f.slug)},
        });
      } catch (_) { /* analytics never load-bearing */ }
    });
  } catch (err) { /* analytics is never load-bearing */ }
})();
</script>

</body>
</html>
`;
}

function loadFeatures() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const data = JSON.parse(raw);
    if (!data.slug) data.slug = f.replace(/\.json$/, '');
    return data;
  });
}

function writeFeature(f, allFeatures) {
  const dir = path.join(OUT_DIR, f.slug);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'index.html');
  fs.writeFileSync(out, template(f, allFeatures), 'utf8');
  return out;
}

function writeFeaturesIndex(allFeatures) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tiles = allFeatures.map((f) => `
    <a class="g-tile" href="/features/${f.slug}">
      <div class="g-tile-shot"><img src="${escapeAttr(f.image)}" alt="${escapeAttr(f.image_alt || f.title)}" loading="lazy" width="1440" height="900"></div>
      <h3>${escapeHtml(f.title)}</h3>
      <p>${escapeHtml(f.related_blurb || f.meta_description.slice(0, 140))}</p>
      <span>Read →</span>
    </a>`).join('');
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How Dossie Handles It — Product Features for Texas Agents — Dossie</title>
<meta name="description" content="Real product screenshots, short walkthroughs — how Dossie handles contract scanning, TREC deadlines, and e-signatures for Texas real estate agents.">
<link rel="canonical" href="https://meetdossie.com/features/">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#FDFCFA;--bg-card:#FFF;--border-light:#F0EBE3;--text-primary:#2D2A26;--text-secondary:#7A7468;--blush:#D4A0A0;--blush-deep:#C08080;--coral:#E8836B;--coral-deep:#C9624A;--gold-deep:#A48531;--bg-warm:#F9F6F1;--gold:#C9A84C}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text-primary);line-height:1.6;-webkit-font-smoothing:antialiased}
nav{position:sticky;top:0;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100;background:rgba(253,252,250,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border-light)}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-mark{width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,var(--blush) 0%,var(--gold) 100%);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;font-family:'Cormorant Garamond',serif}
.nav-name{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:var(--text-primary)}
.nav-cta{padding:10px 18px;border-radius:999px;background:var(--coral);color:#fff;font-size:13px;font-weight:700;text-decoration:none}
header{max-width:760px;margin:0 auto;padding:48px 24px 24px;text-align:center}
header .eyebrow{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--coral-deep);font-weight:700}
header h1{font-family:'Cormorant Garamond',serif;font-size:clamp(34px,5.4vw,48px);font-weight:600;line-height:1.05;color:var(--text-primary);margin-top:10px}
header p{margin-top:14px;font-size:16px;color:var(--text-secondary);max-width:600px;margin-left:auto;margin-right:auto}
main{max-width:1080px;margin:0 auto;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:24px}
.g-tile{display:block;background:var(--bg-card);border:1px solid var(--border-light);border-radius:16px;padding:16px;text-decoration:none;color:var(--text-primary);transition:transform .15s,border-color .15s,box-shadow .15s}
.g-tile:hover{transform:translateY(-2px);border-color:var(--blush);box-shadow:0 14px 32px rgba(45,42,38,.06)}
.g-tile-shot{border-radius:12px;overflow:hidden;margin-bottom:14px;border:1px solid var(--border-light)}
.g-tile-shot img{display:block;width:100%;height:auto}
.g-tile h3{font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;line-height:1.25;margin-bottom:8px;padding:0 6px}
.g-tile p{font-size:14px;color:var(--text-secondary);line-height:1.55;margin-bottom:12px;padding:0 6px}
.g-tile span{color:var(--coral-deep);font-weight:700;font-size:14px;padding:0 6px}
</style>
</head><body>
<nav>
  <a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a>
  <a href="/app" class="nav-cta">Get Started</a>
</nav>
<header>
  <div class="eyebrow">For Texas agents</div>
  <h1>How Dossie handles it</h1>
  <p>Real product screenshots, short walkthroughs — no mockups. See exactly what Dossie does with your files, deadlines, and signatures.</p>
</header>
<main>
  <div class="grid">${tiles}</div>
</main>
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('No marketing/features-data/ directory found.');
    process.exit(1);
  }
  const features = loadFeatures();
  console.log(`Loaded ${features.length} feature data files.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  features.forEach((f) => {
    const out = writeFeature(f, features);
    console.log(`  wrote ${path.relative(ROOT, out)}`);
  });
  writeFeaturesIndex(features);
  console.log(`  wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))}`);
  console.log('Note: sitemap.xml is NOT written here — run build-guides.js after this to fold /features/ into the canonical sitemap.');
  console.log('Done.');
}

main();
