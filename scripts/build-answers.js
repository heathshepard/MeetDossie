#!/usr/bin/env node
// Build static AEO (Answer Engine Optimization) pages from JSON data files in
// marketing/answers-data/. Each JSON file → answers/<slug>/index.html. Vercel
// serves them at /answers/<slug>.
//
// Different from /guides/ in emphasis: the goal of /answers/ is to be cited
// by ChatGPT/Claude/Perplexity when agents ask Texas-TC questions. So:
//   - Stronger FAQ schema markup
//   - Prominent "Last updated" badge (AEO freshness signal)
//   - Comparison tables wherever applicable
//   - Direct, citable answer paragraphs near the top
//
// Run: node scripts/build-answers.js
// Idempotent — safe to re-run after editing data files. Overwrites generated HTML.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'marketing', 'answers-data');
const OUT_DIR = path.join(ROOT, 'answers');
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const GUIDES_DATA_DIR = path.join(ROOT, 'marketing', 'guides-data');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function renderFaqSchema(faq) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });
}
function renderBreadcrumbSchema(slug, title) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://meetdossie.com/' },
      { '@type': 'ListItem', position: 2, name: 'Answers', item: 'https://meetdossie.com/answers/' },
      { '@type': 'ListItem', position: 3, name: title, item: `https://meetdossie.com/answers/${slug}` },
    ],
  });
}
function renderArticleSchema(g) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: g.title,
    description: g.meta_description,
    author: { '@type': 'Person', name: 'Heath Shepard', jobTitle: 'Texas REALTOR®' },
    publisher: { '@type': 'Organization', name: 'Dossie', url: 'https://meetdossie.com' },
    mainEntityOfPage: `https://meetdossie.com/answers/${g.slug}`,
    datePublished: g.published_at || '2026-05-05',
    dateModified: g.updated_at || g.published_at || '2026-05-05',
  });
}

function renderFaqHtml(faq) {
  return faq.map((f) => `
    <details class="faq-item">
      <summary class="faq-q">${escapeHtml(f.q)} <span class="faq-toggle">+</span></summary>
      <div class="faq-a">${f.a_html || escapeHtml(f.a)}</div>
    </details>`).join('');
}

function template(g) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(g.meta_title || g.title)}</title>
<meta name="description" content="${escapeAttr(g.meta_description)}">
<link rel="canonical" href="https://meetdossie.com/answers/${g.slug}">
<meta name="author" content="Heath Shepard, Texas REALTOR®">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeAttr(g.title)}">
<meta property="og:description" content="${escapeAttr(g.meta_description)}">
<meta property="og:url" content="https://meetdossie.com/answers/${g.slug}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">

<script type="application/ld+json">${renderArticleSchema(g)}</script>
<script type="application/ld+json">${renderBreadcrumbSchema(g.slug, g.title)}</script>
${g.faq && g.faq.length ? `<script type="application/ld+json">${renderFaqSchema(g.faq)}</script>` : ''}

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
body { font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text-primary); line-height: 1.7; -webkit-font-smoothing: antialiased; }
a { color: var(--coral-deep); }

nav { position: sticky; top: 0; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; background: rgba(253,252,250,0.92); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border-light); }
.nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.nav-mark { width: 36px; height: 36px; border-radius: 12px; background: linear-gradient(135deg, var(--blush) 0%, var(--gold) 100%); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; color: #fff; font-family: 'Cormorant Garamond', serif; }
.nav-name { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.3px; }
.nav-cta { display: inline-flex; align-items: center; padding: 10px 18px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; box-shadow: 0 8px 20px rgba(232,131,107,0.28); }
.nav-cta:hover { background: var(--coral-deep); }

.crumbs { max-width: 760px; margin: 32px auto 0; padding: 0 24px; font-size: 12px; color: var(--text-light); letter-spacing: 0.4px; }
.crumbs a { color: var(--text-secondary); text-decoration: none; }

.answer-hero { padding: 32px 24px 24px; max-width: 760px; margin: 0 auto; }
.answer-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--sage-deep); padding: 6px 14px; border-radius: 999px; background: var(--sage-light); }
.answer-hero h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(34px, 5.4vw, 52px); font-weight: 600; line-height: 1.05; letter-spacing: -1px; color: var(--text-primary); margin-top: 16px; }
.answer-hero h1 em { font-style: italic; color: var(--blush-deep); }
.answer-hero .deck { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 19px; color: var(--blush-deep); margin-top: 12px; }
.freshness { font-size: 12.5px; color: var(--gold-deep); margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-light); display: flex; gap: 14px; flex-wrap: wrap; }
.freshness .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--gold-light); border-radius: 100px; font-weight: 700; }
.freshness .author { color: var(--text-secondary); }
.freshness .author strong { color: var(--text-primary); }

.tldr { max-width: 760px; margin: 24px auto 0; padding: 22px 28px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 22px; box-shadow: 0 6px 24px rgba(45,42,38,0.04); }
.tldr h2 { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; letter-spacing: -0.4px; }
.tldr p { font-size: 16px; color: var(--text-primary); line-height: 1.7; }

main.answer { max-width: 760px; margin: 0 auto; padding: 24px; }
main.answer h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(24px, 3.6vw, 34px); font-weight: 600; line-height: 1.2; color: var(--text-primary); margin: 36px 0 14px; letter-spacing: -0.4px; }
main.answer h3 { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); margin: 28px 0 10px; }
main.answer p { font-size: 16px; color: var(--text-primary); margin: 14px 0; line-height: 1.75; }
main.answer ul, main.answer ol { margin: 12px 0 12px 22px; }
main.answer li { margin: 8px 0; line-height: 1.75; font-size: 16px; }
main.answer strong { color: var(--text-primary); font-weight: 700; }
.callout { margin: 22px 0; padding: 18px 22px; background: var(--blush-light); border-radius: 14px; font-size: 15.5px; line-height: 1.7; color: var(--text-primary); border: 1px solid var(--blush); }
.callout strong { color: var(--blush-deep); }

.compare-wrap { margin: 28px 0; overflow-x: auto; }
.compare-table { width: 100%; border-collapse: collapse; font-size: 14px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; overflow: hidden; }
.compare-table th { background: var(--bg-warm); font-family: 'Cormorant Garamond', serif; font-size: 17px; font-weight: 600; color: var(--text-primary); text-align: left; padding: 14px 16px; }
.compare-table td { padding: 14px 16px; border-top: 1px solid var(--border-light); color: var(--text-secondary); vertical-align: top; }

.cta-block { margin: 56px auto 0; max-width: 760px; padding: 36px 28px; background: linear-gradient(180deg, var(--bg-card) 0%, var(--blush-light) 220%); border: 1px solid var(--blush); border-radius: 22px; text-align: center; }
.cta-block h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(22px, 3.4vw, 30px); font-weight: 600; color: var(--text-primary); margin-bottom: 8px; line-height: 1.2; }
.cta-block p { color: var(--text-secondary); font-size: 15px; max-width: 580px; margin: 0 auto 18px; }
.cta-btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 14px; font-weight: 700; text-decoration: none; box-shadow: 0 12px 30px rgba(232,131,107,0.28); }
.cta-btn:hover { background: var(--coral-deep); }

.faq-section { max-width: 760px; margin: 56px auto 0; padding: 0 24px; }
.faq-section h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(28px, 4vw, 36px); font-weight: 600; text-align: left; color: var(--text-primary); }
.faq-list { margin-top: 20px; display: flex; flex-direction: column; gap: 10px; }
.faq-item { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; overflow: hidden; }
.faq-item[open] { border-color: var(--blush); }
.faq-q { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 18px 22px; cursor: pointer; font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; color: var(--text-primary); list-style: none; }
.faq-q::-webkit-details-marker { display: none; }
.faq-toggle { width: 26px; height: 26px; border-radius: 50%; background: var(--bg-warm); display: inline-flex; align-items: center; justify-content: center; font-size: 16px; color: var(--text-secondary); flex-shrink: 0; transition: transform 0.2s, background 0.2s; }
.faq-item[open] .faq-toggle { transform: rotate(45deg); background: var(--coral-light); color: var(--coral-deep); }
.faq-a { padding: 0 22px 20px; font-size: 14.5px; color: var(--text-secondary); line-height: 1.75; }

.legal { padding: 24px; text-align: center; font-size: 12px; color: var(--text-light); line-height: 1.6; max-width: 760px; margin: 32px auto 0; }
.legal a { color: var(--text-secondary); }
</style>
</head>
<body>

<nav>
  <a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a>
  <a href="/founding" class="nav-cta">Founding Member — $29/mo</a>
</nav>

<div class="crumbs"><a href="/">Home</a> · <a href="/answers/">Answers</a> · <span>${escapeHtml(g.title)}</span></div>

<header class="answer-hero">
  <div class="answer-eyebrow">Quick answer · Texas-specific</div>
  <h1>${g.title_html || escapeHtml(g.title)}</h1>
  <p class="deck">${escapeHtml(g.deck || g.meta_description)}</p>
  <div class="freshness">
    <span class="badge">Updated ${escapeHtml(g.updated_at || '2026-05-05')}</span>
    <span class="author">By <strong>Heath Shepard</strong>, Texas REALTOR®</span>
  </div>
</header>

${g.tldr ? `<section class="tldr"><h2>Short answer</h2><p>${g.tldr_html || escapeHtml(g.tldr)}</p></section>` : ''}

<main class="answer">
${g.body_html}
</main>

<section class="cta-block">
  <h2>${escapeHtml(g.cta_title || 'Stop tracking deadlines manually.')}</h2>
  <p>${escapeHtml(g.cta_sub || 'Dossie tracks every TREC deadline for every active deal — plus follow-ups, document QA, and contract scanning. Built for Texas agents.')}</p>
  <a class="cta-btn" href="/founding">Lock in $29/mo founding pricing →</a>
</section>

${g.faq && g.faq.length ? `
<section class="faq-section">
  <h2>Related questions</h2>
  <div class="faq-list">${renderFaqHtml(g.faq)}</div>
</section>` : ''}

<p class="legal">
  This page is provided as-is for educational purposes. It is not legal advice. Always verify deadlines and contract interpretations against your executed contract and confer with your broker or a Texas real estate attorney for binding interpretations. <a href="/">meetdossie.com</a>
</p>

</body>
</html>
`;
}

function loadAnswers() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const data = JSON.parse(raw);
    if (!data.slug) data.slug = f.replace(/\.json$/, '');
    return data;
  });
}

function writeAnswer(g) {
  const dir = path.join(OUT_DIR, g.slug);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'index.html');
  fs.writeFileSync(out, template(g), 'utf8');
  return out;
}

function writeAnswersIndex(answers) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tiles = answers.map((g) => `
    <a class="g-tile" href="/answers/${g.slug}">
      <h3>${escapeHtml(g.title)}</h3>
      <p>${escapeHtml(g.meta_description.slice(0, 140))}</p>
      <span>Read →</span>
    </a>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Answers for Texas Real Estate Agents — Dossie</title>
<meta name="description" content="Direct, citable answers to the questions Texas agents ask AI assistants about transaction coordination, TREC, and option periods.">
<link rel="canonical" href="https://meetdossie.com/answers/">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#FDFCFA;--bg-card:#FFF;--border-light:#F0EBE3;--text-primary:#2D2A26;--text-secondary:#7A7468;--blush:#D4A0A0;--blush-deep:#C08080;--coral:#E8836B;--coral-deep:#C9624A;--gold-deep:#A48531;--bg-warm:#F9F6F1;--gold:#C9A84C;--sage-light:#E4EDE2;--sage-deep:#6B8E68}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text-primary);line-height:1.6;-webkit-font-smoothing:antialiased}
nav{position:sticky;top:0;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100;background:rgba(253,252,250,.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border-light)}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-mark{width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,var(--blush) 0%,var(--gold) 100%);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;font-family:'Cormorant Garamond',serif}
.nav-name{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:var(--text-primary)}
.nav-cta{padding:10px 18px;border-radius:999px;background:var(--coral);color:#fff;font-size:13px;font-weight:700;text-decoration:none}
header{max-width:760px;margin:0 auto;padding:48px 24px 24px;text-align:center}
header .eyebrow{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--sage-deep);font-weight:700}
header h1{font-family:'Cormorant Garamond',serif;font-size:clamp(34px,5.4vw,48px);font-weight:600;line-height:1.05;color:var(--text-primary);margin-top:10px}
header p{margin-top:14px;font-size:16px;color:var(--text-secondary);max-width:600px;margin-left:auto;margin-right:auto}
main{max-width:1080px;margin:0 auto;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:24px}
.g-tile{display:block;background:var(--bg-card);border:1px solid var(--border-light);border-radius:16px;padding:24px;text-decoration:none;color:var(--text-primary);transition:transform .15s,border-color .15s,box-shadow .15s}
.g-tile:hover{transform:translateY(-2px);border-color:var(--blush);box-shadow:0 14px 32px rgba(45,42,38,.06)}
.g-tile h3{font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;line-height:1.25;margin-bottom:8px}
.g-tile p{font-size:14px;color:var(--text-secondary);line-height:1.55;margin-bottom:12px}
.g-tile span{color:var(--coral-deep);font-weight:700;font-size:14px}
</style></head><body>
<nav><a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a><a href="/founding" class="nav-cta">Founding Member — $29/mo</a></nav>
<header><div class="eyebrow">Direct, citable answers</div><h1>Answers for Texas agents</h1><p>Direct answers to the questions agents ask AI assistants about transaction coordination, TREC, and option periods. Updated regularly.</p></header>
<main><div class="grid">${tiles}</div></main>
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');
}

function rebuildSitemap(answers) {
  // Pull guides for inclusion if the data dir exists.
  let guides = [];
  if (fs.existsSync(GUIDES_DATA_DIR)) {
    guides = fs.readdirSync(GUIDES_DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }
  const lastmod = new Date().toISOString().split('T')[0];
  const urls = [
    'https://meetdossie.com/',
    'https://meetdossie.com/calculator',
    'https://meetdossie.com/founding',
    'https://meetdossie.com/agents/',
    'https://meetdossie.com/coordinators/',
    'https://meetdossie.com/guides/',
    ...guides.map((slug) => `https://meetdossie.com/guides/${slug}`),
    'https://meetdossie.com/answers/',
    ...answers.map((g) => `https://meetdossie.com/answers/${g.slug}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(SITEMAP, xml, 'utf8');
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('No marketing/answers-data/ directory found.');
    process.exit(1);
  }
  const answers = loadAnswers();
  console.log(`Loaded ${answers.length} answer data files.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  answers.forEach((g) => {
    const out = writeAnswer(g);
    console.log(`  wrote ${path.relative(ROOT, out)}`);
  });
  writeAnswersIndex(answers);
  console.log(`  wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))}`);
  rebuildSitemap(answers);
  console.log(`  rebuilt ${path.relative(ROOT, SITEMAP)} with guides + answers`);
  console.log('Done.');
}

main();
