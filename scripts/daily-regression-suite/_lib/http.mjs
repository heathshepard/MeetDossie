// scripts/daily-regression-suite/_lib/http.mjs
//
// Small fetch wrapper with:
//   - timeout via AbortController
//   - response-time measurement
//   - never throws (returns { ok, status, error, ms, body })

export async function probe(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10000,
    expectStatus, // number | number[] | fn(status) => bool
  } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const ms = Date.now() - start;
    let text = '';
    try { text = await res.text(); } catch { /* body-read failure ignored */ }
    let ok = res.ok;
    if (expectStatus !== undefined) {
      if (Array.isArray(expectStatus)) ok = expectStatus.includes(res.status);
      else if (typeof expectStatus === 'function') ok = !!expectStatus(res.status);
      else ok = res.status === expectStatus;
    }
    return { ok, status: res.status, ms, body: text.slice(0, 800), headers: Object.fromEntries(res.headers) };
  } catch (err) {
    const ms = Date.now() - start;
    return { ok: false, status: 0, ms, error: err.message || String(err) };
  } finally {
    clearTimeout(t);
  }
}

export function mkTest(id, category, tier, fn) {
  return { id, category, tier, fn };
}

// Runs a test-fn safely and returns the canonical result row.
export async function runOne(test, ctx) {
  const start = Date.now();
  try {
    const r = await test.fn(ctx);
    // normalise
    return {
      id: test.id,
      category: test.category,
      tier: test.tier,
      verdict: r?.verdict || (r?.ok ? 'PASS' : 'FAIL'),
      response_ms: r?.response_ms || (Date.now() - start),
      error: r?.error || null,
      detail: r?.detail || null,
      screenshot: r?.screenshot || null,
    };
  } catch (err) {
    return {
      id: test.id,
      category: test.category,
      tier: test.tier,
      verdict: 'FAIL',
      response_ms: Date.now() - start,
      error: `runner-crash: ${err.message || String(err)}`,
      detail: null,
      screenshot: null,
    };
  }
}
