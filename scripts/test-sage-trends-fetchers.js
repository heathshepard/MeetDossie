// Standalone test for the new fetchers in api/cron-sage-trends.js
// Verifies Google Trends RSS + Reddit Atom feeds return real content from the
// machine running this script. Note: success here doesn't 100% prove Vercel's
// egress IPs aren't being rate-limited — staging cron run is the real APV.
//
// Usage:  node scripts/test-sage-trends-fetchers.js

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
function pickUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function decodeXmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ');
}
function tagText(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return decodeXmlEntities(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
}
function splitItems(xml, itemTag) {
  const re = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

async function fetchGoogleTrends() {
  const url = 'https://trends.google.com/trending/rss?geo=US-TX';
  const res = await fetch(url, {
    headers: {
      'User-Agent': pickUA(),
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  console.log(`Google Trends: HTTP ${res.status}`);
  if (!res.ok) return { topics: [], error: `http_${res.status}` };
  const xml = await res.text();
  const items = splitItems(xml, 'item');
  const topics = items.slice(0, 15).map((item) => {
    const query = tagText(item, 'title');
    const traffic = tagText(item, 'ht:approx_traffic');
    const newsBlocks = splitItems(item, 'ht:news_item');
    const relatedQueries = newsBlocks.slice(0, 3).map((nb) => tagText(nb, 'ht:news_item_title'));
    return { query, traffic, relatedQueries };
  }).filter((t) => t.query);
  return { topics };
}

async function fetchRedditPosts() {
  const subreddits = ['realestate', 'RealEstateTechnology'];
  const results = {};
  for (let i = 0; i < subreddits.length; i++) {
    const sub = subreddits[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    const url = `https://www.reddit.com/r/${sub}/.rss?sort=top&t=day`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': pickUA(),
        Accept: 'application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    console.log(`Reddit r/${sub}: HTTP ${res.status}`);
    if (!res.ok) { results[sub] = { posts: [], error: `http_${res.status}` }; continue; }
    const xml = await res.text();
    const entries = splitItems(xml, 'entry');
    const posts = entries.slice(0, 5).map((entry) => {
      const title = tagText(entry, 'title');
      const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/i);
      const u = linkMatch ? decodeXmlEntities(linkMatch[1]) : '';
      return { title, url: u };
    }).filter((p) => p.title);
    results[sub] = { posts };
  }
  return results;
}

(async () => {
  console.log('=== Google Trends ===');
  const g = await fetchGoogleTrends();
  console.log(`Topics found: ${g.topics ? g.topics.length : 0}`);
  if (g.topics && g.topics.length) {
    g.topics.slice(0, 5).forEach((t, i) => console.log(`  ${i+1}. ${t.query}${t.traffic ? ` (${t.traffic})` : ''}`));
  }
  console.log('');
  console.log('=== Reddit ===');
  const r = await fetchRedditPosts();
  for (const [sub, payload] of Object.entries(r)) {
    console.log(`r/${sub}: ${payload.posts.length} posts${payload.error ? ' (err: ' + payload.error + ')' : ''}`);
    payload.posts.slice(0, 3).forEach((p, i) => console.log(`  ${i+1}. ${p.title.slice(0, 100)}`));
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
