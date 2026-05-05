#!/usr/bin/env node
// Build static SEO guide pages from JSON data files in marketing/guides-data/.
// Each JSON file → guides/<slug>/index.html. Vercel serves them at /guides/<slug>.
//
// Run: node scripts/build-guides.js
// Idempotent — safe to re-run after editing data files. Overwrites generated HTML.
//
// Why static-at-build-time instead of a Vercel function: SEO-critical pages
// should be cacheable static assets so Googlebot sees the rendered content
// immediately and Vercel's CDN handles the load. Adding a guide is just a
// new JSON file + one node command.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'marketing', 'guides-data');
const OUT_DIR = path.join(ROOT, 'guides');
const SITEMAP = path.join(ROOT, 'sitemap.xml');

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
      { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://meetdossie.com/guides/' },
      { '@type': 'ListItem', position: 3, name: title, item: `https://meetdossie.com/guides/${slug}` },
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
    mainEntityOfPage: `https://meetdossie.com/guides/${g.slug}`,
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

function renderComparisonTable(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h])}</td>`).join('')}</tr>`).join('');
  return `
    <div class="compare-wrap"><table class="compare-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderRelated(related, allGuides) {
  if (!related || related.length === 0) return '';
  const tiles = related.map((slug) => {
    const g = allGuides.find((x) => x.slug === slug);
    if (!g) return '';
    return `<a class="related-card" href="/guides/${slug}"><h3>${escapeHtml(g.title)}</h3><p>${escapeHtml(g.related_blurb || g.meta_description.slice(0, 110))}</p><span class="related-arrow">→</span></a>`;
  }).filter(Boolean).join('');
  return tiles ? `<section class="related"><h2>Related guides</h2><div class="related-grid">${tiles}</div></section>` : '';
}

function template(g, allGuides) {
  const calculatorBlock = g.show_calculator !== false ? `
    <section class="calc-section" aria-labelledby="calc-title">
      <h2 class="section-h2" id="calc-title">Try the calculator</h2>
      <p class="section-sub">${escapeHtml(g.calculator_blurb || 'Plug in your contract dates and we\'ll compute every TREC deadline — option period, earnest money, financing, and closing.')}</p>
      <div id="dossie-calculator"></div>
    </section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(g.meta_title || g.title)}</title>
<meta name="description" content="${escapeAttr(g.meta_description)}">
<link rel="canonical" href="https://meetdossie.com/guides/${g.slug}">
<meta name="author" content="Heath Shepard, Texas REALTOR®">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeAttr(g.title)}">
<meta property="og:description" content="${escapeAttr(g.meta_description)}">
<meta property="og:url" content="https://meetdossie.com/guides/${g.slug}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/calculator-widget.css">

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
body { font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text-primary); line-height: 1.65; -webkit-font-smoothing: antialiased; }
a { color: var(--coral-deep); }

nav { position: sticky; top: 0; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; background: rgba(253,252,250,0.92); backdrop-filter: blur(20px); border-bottom: 1px solid var(--border-light); }
.nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.nav-mark { width: 36px; height: 36px; border-radius: 12px; background: linear-gradient(135deg, var(--blush) 0%, var(--gold) 100%); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; color: #fff; font-family: 'Cormorant Garamond', serif; }
.nav-name { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.3px; }
.nav-cta { display: inline-flex; align-items: center; padding: 10px 18px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; box-shadow: 0 8px 20px rgba(232,131,107,0.28); }
.nav-cta:hover { background: var(--coral-deep); }

.crumbs { max-width: 760px; margin: 32px auto 0; padding: 0 24px; font-size: 12px; color: var(--text-light); letter-spacing: 0.4px; }
.crumbs a { color: var(--text-secondary); text-decoration: none; }

.article-hero { padding: 32px 24px 24px; max-width: 760px; margin: 0 auto; }
.article-eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--gold-deep); }
.article-hero h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(34px, 5.4vw, 52px); font-weight: 600; line-height: 1.05; letter-spacing: -1px; color: var(--text-primary); margin-top: 10px; }
.article-hero h1 em { font-style: italic; color: var(--blush-deep); }
.article-hero .deck { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 19px; color: var(--blush-deep); margin-top: 12px; }
.article-meta { font-size: 13px; color: var(--text-secondary); margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-light); display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
.article-meta strong { color: var(--text-primary); font-weight: 700; }

main.article { max-width: 760px; margin: 0 auto; padding: 24px; }
main.article h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(24px, 3.6vw, 34px); font-weight: 600; line-height: 1.2; color: var(--text-primary); margin: 36px 0 14px; letter-spacing: -0.4px; }
main.article h3 { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: var(--text-primary); margin: 28px 0 10px; }
main.article p { font-size: 16px; color: var(--text-primary); margin: 12px 0; line-height: 1.75; }
main.article ul, main.article ol { margin: 12px 0 12px 22px; }
main.article li { margin: 6px 0; line-height: 1.7; font-size: 16px; }
main.article strong { color: var(--text-primary); font-weight: 700; }
main.article blockquote { margin: 18px 0; padding: 16px 20px; border-left: 3px solid var(--blush); background: var(--bg-warm); border-radius: 0 12px 12px 0; font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 19px; color: var(--text-primary); }
.callout { margin: 22px 0; padding: 18px 22px; background: var(--blush-light); border-radius: 14px; font-size: 15.5px; line-height: 1.65; color: var(--text-primary); border: 1px solid var(--blush); }
.callout strong { color: var(--blush-deep); }

.compare-wrap { margin: 28px 0; overflow-x: auto; }
.compare-table { width: 100%; border-collapse: collapse; font-size: 14px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; overflow: hidden; }
.compare-table th { background: var(--bg-warm); font-family: 'Cormorant Garamond', serif; font-size: 17px; font-weight: 600; color: var(--text-primary); text-align: left; padding: 14px 16px; }
.compare-table td { padding: 14px 16px; border-top: 1px solid var(--border-light); color: var(--text-secondary); vertical-align: top; }

.calc-section { max-width: 1080px; margin: 56px auto 0; padding: 0 24px; }
.calc-section .section-h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(26px, 4vw, 36px); font-weight: 600; color: var(--text-primary); }
.calc-section .section-sub { font-size: 15px; color: var(--text-secondary); margin: 8px 0 24px; max-width: 640px; line-height: 1.7; }

.cta-block { margin: 56px auto 0; max-width: 760px; padding: 36px 28px; background: linear-gradient(180deg, var(--bg-card) 0%, var(--blush-light) 220%); border: 1px solid var(--blush); border-radius: 22px; text-align: center; }
.cta-block h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(22px, 3.4vw, 30px); font-weight: 600; color: var(--text-primary); margin-bottom: 8px; line-height: 1.2; }
.cta-block p { color: var(--text-secondary); font-size: 15px; max-width: 580px; margin: 0 auto 18px; }
.cta-btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 14px; font-weight: 700; text-decoration: none; box-shadow: 0 12px 30px rgba(232,131,107,0.28); transition: transform 0.15s, background 0.15s; }
.cta-btn:hover { transform: translateY(-1px); background: var(--coral-deep); }

.faq-section { max-width: 760px; margin: 56px auto 0; padding: 0 24px; }
.faq-list { margin-top: 20px; display: flex; flex-direction: column; gap: 10px; }
.faq-item { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; overflow: hidden; }
.faq-item[open] { border-color: var(--blush); }
.faq-q { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 18px 22px; cursor: pointer; font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; color: var(--text-primary); list-style: none; }
.faq-q::-webkit-details-marker { display: none; }
.faq-toggle { width: 26px; height: 26px; border-radius: 50%; background: var(--bg-warm); display: inline-flex; align-items: center; justify-content: center; font-size: 16px; color: var(--text-secondary); flex-shrink: 0; transition: transform 0.2s, background 0.2s; }
.faq-item[open] .faq-toggle { transform: rotate(45deg); background: var(--coral-light); color: var(--coral-deep); }
.faq-a { padding: 0 22px 20px; font-size: 14.5px; color: var(--text-secondary); line-height: 1.7; }

.related { max-width: 1080px; margin: 64px auto 0; padding: 0 24px; }
.related h2 { font-family: 'Cormorant Garamond', serif; font-size: clamp(24px, 3.4vw, 32px); font-weight: 600; color: var(--text-primary); }
.related-grid { margin-top: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.related-card { display: block; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; padding: 22px 22px 26px; text-decoration: none; color: var(--text-primary); transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
.related-card:hover { transform: translateY(-2px); border-color: var(--blush); box-shadow: 0 14px 32px rgba(45,42,38,0.06); }
.related-card h3 { font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; color: var(--text-primary); line-height: 1.25; margin-bottom: 6px; }
.related-card p { font-size: 13.5px; color: var(--text-secondary); line-height: 1.55; }
.related-arrow { display: inline-block; margin-top: 8px; font-size: 14px; color: var(--coral-deep); font-weight: 700; }

.legal { padding: 24px; text-align: center; font-size: 12px; color: var(--text-light); line-height: 1.6; max-width: 760px; margin: 32px auto 0; }
.legal a { color: var(--text-secondary); }
</style>
</head>
<body>

<nav>
  <a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a>
  <a href="/founding" class="nav-cta">Founding Member — $29/mo</a>
</nav>

<div class="crumbs">
  <a href="/">Home</a> · <a href="/calculator">Calculator</a> · <span>${escapeHtml(g.title)}</span>
</div>

<header class="article-hero">
  <div class="article-eyebrow">${escapeHtml(g.eyebrow || 'TREC guide')}</div>
  <h1>${g.title_html || escapeHtml(g.title)}</h1>
  <p class="deck">${escapeHtml(g.deck || g.meta_description)}</p>
  <div class="article-meta">
    <span>By <strong>Heath Shepard</strong>, Texas REALTOR®</span>
    <span>Updated ${escapeHtml(g.updated_at || '2026-05-05')}</span>
  </div>
</header>

<main class="article">
${g.body_html}
</main>

${calculatorBlock}

<section class="cta-block">
  <h2>${escapeHtml(g.cta_title || 'Stop tracking deadlines manually.')}</h2>
  <p>${escapeHtml(g.cta_sub || 'Dossie tracks every TREC deadline for every active deal — plus follow-ups, document QA, and contract scanning. Built for Texas agents.')}</p>
  <a class="cta-btn" href="/founding">Lock in $29/mo founding pricing →</a>
</section>

${g.faq && g.faq.length ? `
<section class="faq-section">
  <h2 class="section-h2">Frequently asked</h2>
  <div class="faq-list">${renderFaqHtml(g.faq)}</div>
</section>` : ''}

${renderRelated(g.related_guides, allGuides)}

<p class="legal">
  This guide is provided as-is for educational purposes. It is not legal advice. Always verify deadlines and contract interpretations against your executed contract and confer with your broker or a Texas real estate attorney for binding interpretations. <a href="/">meetdossie.com</a>
</p>

${g.show_calculator !== false ? '<script src="/assets/trec-engine.js"></script>\n<script src="/assets/calculator-widget.js"></script>' : ''}

</body>
</html>
`;
}

function loadGuides() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const data = JSON.parse(raw);
    if (!data.slug) data.slug = f.replace(/\.json$/, '');
    return data;
  });
}

function writeGuide(g, allGuides) {
  const dir = path.join(OUT_DIR, g.slug);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'index.html');
  fs.writeFileSync(out, template(g, allGuides), 'utf8');
  return out;
}

function writeGuidesIndex(allGuides) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tiles = allGuides.map((g) => `
    <a class="g-tile" href="/guides/${g.slug}">
      <h3>${escapeHtml(g.title)}</h3>
      <p>${escapeHtml(g.related_blurb || g.meta_description.slice(0, 140))}</p>
      <span>Read →</span>
    </a>`).join('');
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Texas TREC Guides for Real Estate Agents — Dossie</title>
<meta name="description" content="Texas-specific TREC guides: option period, earnest money, financing, deadlines, transaction coordination. Written by a Texas REALTOR®.">
<link rel="canonical" href="https://meetdossie.com/guides/">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#FDFCFA;--bg-card:#FFF;--border-light:#F0EBE3;--text-primary:#2D2A26;--text-secondary:#7A7468;--blush:#D4A0A0;--blush-deep:#C08080;--coral:#E8836B;--coral-deep:#C9624A;--gold-deep:#A48531;--bg-warm:#F9F6F1}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text-primary);line-height:1.6;-webkit-font-smoothing:antialiased}
nav{position:sticky;top:0;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100;background:rgba(253,252,250,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border-light)}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-mark{width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,var(--blush) 0%,var(--gold-deep) 100%);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;font-family:'Cormorant Garamond',serif}
.nav-name{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:var(--text-primary)}
.nav-cta{padding:10px 18px;border-radius:999px;background:var(--coral);color:#fff;font-size:13px;font-weight:700;text-decoration:none}
header{max-width:760px;margin:0 auto;padding:48px 24px 24px;text-align:center}
header .eyebrow{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--gold-deep);font-weight:700}
header h1{font-family:'Cormorant Garamond',serif;font-size:clamp(34px,5.4vw,48px);font-weight:600;line-height:1.05;color:var(--text-primary);margin-top:10px}
header p{margin-top:14px;font-size:16px;color:var(--text-secondary);max-width:600px;margin-left:auto;margin-right:auto}
main{max-width:1080px;margin:0 auto;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:24px}
.g-tile{display:block;background:var(--bg-card);border:1px solid var(--border-light);border-radius:16px;padding:24px;text-decoration:none;color:var(--text-primary);transition:transform .15s,border-color .15s,box-shadow .15s}
.g-tile:hover{transform:translateY(-2px);border-color:var(--blush);box-shadow:0 14px 32px rgba(45,42,38,.06)}
.g-tile h3{font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;line-height:1.25;margin-bottom:8px}
.g-tile p{font-size:14px;color:var(--text-secondary);line-height:1.55;margin-bottom:12px}
.g-tile span{color:var(--coral-deep);font-weight:700;font-size:14px}
</style>
</head><body>
<nav>
  <a href="/" class="nav-logo"><span class="nav-mark">D</span><span class="nav-name">Dossie</span></a>
  <a href="/founding" class="nav-cta">Founding Member — $29/mo</a>
</nav>
<header>
  <div class="eyebrow">For Texas agents</div>
  <h1>TREC guides &amp; calculators</h1>
  <p>Texas-specific deadline rules, contract mechanics, and TC pricing — written by a Texas REALTOR®. Every guide is paired with the free <a href="/calculator">TREC deadline calculator</a>.</p>
</header>
<main>
  <div class="grid">${tiles}</div>
</main>
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');
}

function writeSitemap(allGuides) {
  const lastmod = new Date().toISOString().split('T')[0];
  const urls = [
    'https://meetdossie.com/',
    'https://meetdossie.com/calculator',
    'https://meetdossie.com/founding',
    'https://meetdossie.com/agents/',
    'https://meetdossie.com/coordinators/',
    'https://meetdossie.com/guides/',
    ...allGuides.map((g) => `https://meetdossie.com/guides/${g.slug}`),
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
    console.error('No marketing/guides-data/ directory found.');
    process.exit(1);
  }
  const guides = loadGuides();
  console.log(`Loaded ${guides.length} guide data files.`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  guides.forEach((g) => {
    const out = writeGuide(g, guides);
    console.log(`  wrote ${path.relative(ROOT, out)}`);
  });
  writeGuidesIndex(guides);
  console.log(`  wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))}`);
  writeSitemap(guides);
  console.log(`  wrote ${path.relative(ROOT, SITEMAP)}`);
  console.log('Done.');
}

main();
