'use strict';

// Quick probe: open the New Dossier modal on demo1 and dump its inputs/buttons.

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
})();

const OUT = path.join(__dirname, '..', '.tmp-qc', 'probe-onboarding');

async function inv(page, label) {
  const out = await page.evaluate(() => {
    function vis(el) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; }
    const btns = []; document.querySelectorAll('button,[role="button"]').forEach(el=>{ if(!vis(el))return; btns.push({text:(el.innerText||'').trim().slice(0,80), aria:el.getAttribute('aria-label')||''}); });
    const ins = []; document.querySelectorAll('input,textarea,select').forEach(el=>{ if(!vis(el))return; ins.push({type:el.getAttribute('type')||el.tagName, placeholder:el.getAttribute('placeholder')||'', name:el.getAttribute('name')||'', value:(el.value||'').toString().slice(0,80)}); });
    const headings = []; document.querySelectorAll('h1,h2,h3,h4').forEach(el=>{ if(!vis(el))return; headings.push({tag:el.tagName, text:(el.innerText||'').trim().slice(0,120)}); });
    return { headings, btns: btns.slice(0,80), ins: ins.slice(0,40), url:location.href };
  });
  fs.writeFileSync(path.join(OUT, `inv-${label}.json`), JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(OUT, `inv-${label}.png`), fullPage: true });
  console.log(`[probe] ${label}: ${out.btns.length} btns, ${out.ins.length} ins`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  // Pre-auth using same approach as the recorder
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method:'POST', headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'}, body: JSON.stringify({email:'demo@meetdossie.com', password: process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab'}) });
  const sess = await r.json();
  const session = { access_token:sess.access_token, token_type:'bearer', expires_in:sess.expires_in||3600, expires_at:sess.expires_at, refresh_token:sess.refresh_token, user:sess.user, weak_password:null };
  await page.goto('https://meetdossie.com/');
  await page.evaluate((s)=>localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  await page.goto('https://meetdossie.com/app', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(3000);
  await inv(page, 'pipeline-pre');
  // Tap Pipeline tab to navigate to Pipeline Dashboard
  await page.locator('[aria-label="Pipeline"]').first().click();
  await page.waitForTimeout(2000);
  await inv(page, 'pipeline-tab');
  // Click the existing buyer-side dossier (123 main street)
  const buyerCard = page.getByText(/123 main street/i).first();
  await buyerCard.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(()=>{});
  await page.waitForTimeout(500);
  if (await buyerCard.isVisible({timeout:5000}).catch(()=>false)) {
    await buyerCard.click();
    await page.waitForTimeout(2500);
    await inv(page, 'buyer-dossier-top');
    await page.evaluate(()=>window.scrollBy({top:600, behavior:'instant'}));
    await page.waitForTimeout(800);
    await inv(page, 'buyer-dossier-mid');
    await page.evaluate(()=>window.scrollBy({top:600, behavior:'instant'}));
    await page.waitForTimeout(800);
    await inv(page, 'buyer-dossier-bot');
  } else {
    console.log('[probe] 123 main street card not found');
  }
  await ctx.close(); await browser.close();
}

main().then(()=>console.log('done')).catch(e=>{console.error(e); process.exit(1);});
