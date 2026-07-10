"use strict";
// Sends a user message through Talk to Dossie chat panel and waits for a tool result.
// Returns the last assistant response + parsed tool calls seen on network.

const path = require("path");

const CHAT_ROUTE_RE = /\/api\/chat($|\?)/;

async function openChatPanel(page) {
  // The Talk to Dossie panel is a permanent right-side rail on /workspace.html.
  // It's already open when the page loads, so we just need to verify the textarea
  // is present. On smaller viewports we may need to click the "Talk to Dossie"
  // header button to toggle it open.
  // First check: does the textarea already exist and is it visible?
  const existing = await page.$('textarea[placeholder*="Type a command"], textarea[placeholder*="mic"]').catch(() => null);
  if (existing) {
    const box = await existing.boundingBox().catch(() => null);
    if (box && box.width > 0) {
      return { ok: true, selector: "existing textarea", alreadyOpen: true };
    }
  }
  // Fallback: click the header "Talk to Dossie" button to toggle
  const candidates = [
    'button:has-text("Talk to Dossie")',
    'button[aria-label*="Dossie"]',
    'button[aria-label*="chat"]',
    'button[title*="Dossie"]',
    '[data-testid="talk-to-dossie"]',
    '[data-panel="talk-to-dossie"]',
  ];
  for (const sel of candidates) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(1200);
        // Verify textarea now available
        const ta = await page.$('textarea[placeholder*="Type a command"], textarea[placeholder*="mic"]').catch(() => null);
        if (ta) return { ok: true, selector: sel };
      }
    }
  }
  return { ok: false, reason: "Talk to Dossie panel/textarea not found (viewport may be too narrow — need >=1440px width)" };
}

async function findChatInput(page) {
  // Typing area — textarea or contenteditable
  const candidates = [
    'textarea[placeholder*="Type a command"]',
    'textarea[placeholder*="Type"]',
    'textarea[placeholder*="Dossie"]',
    'textarea[placeholder*="ask"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Message"]',
    'textarea',
    'div[contenteditable="true"]',
    'input[placeholder*="Dossie"]',
    'input[placeholder*="ask"]',
    'input[placeholder*="Type"]',
  ];
  for (const sel of candidates) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) return { el, selector: sel };
    }
  }
  return null;
}

async function findSendButton(page) {
  const candidates = [
    'button:has-text("Send"):visible',
    'button[aria-label*="send"]',
    'button[aria-label*="Send"]',
  ];
  for (const sel of candidates) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) return el;
    }
  }
  return null;
}

async function sendMessage(page, message, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const collected = { requests: [], responses: [], toolCalls: [] };

  const respHandler = async (resp) => {
    if (CHAT_ROUTE_RE.test(resp.url())) {
      try {
        const body = await resp.json();
        collected.responses.push({ url: resp.url(), status: resp.status(), body });
        // Recursively harvest tool calls from any known shape:
        //   Anthropic native: { content: [{ type: 'tool_use', name, input }] }
        //   Wrapper: { tool_calls: [{ name, input | arguments }] }
        //   Some Dossie routes: { action, actionArgs } or { intent, params }
        //   { message: { tool_calls: [...] } }
        function harvest(obj) {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) { obj.forEach(harvest); return; }
          if (obj.type === "tool_use" && obj.name) {
            collected.toolCalls.push({ name: obj.name, input: obj.input || obj.arguments });
          }
          if (obj.tool_calls && Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
              if (tc && tc.name) collected.toolCalls.push({ name: tc.name, input: tc.input || tc.arguments || tc.function });
            }
          }
          if (obj.action && (obj.actionArgs || obj.args || obj.params)) {
            collected.toolCalls.push({ name: obj.action, input: obj.actionArgs || obj.args || obj.params });
          }
          if (obj.intent && obj.intent !== obj.action) {
            // Some routes emit { intent: 'create_dossier', ... }
            collected.toolCalls.push({ name: `intent:${obj.intent}`, input: obj.params || obj.args || obj });
          }
          for (const k of Object.keys(obj)) {
            if (k === "tool_calls" || k === "content") continue;
            if (obj[k] && typeof obj[k] === "object") harvest(obj[k]);
          }
        }
        if (body && Array.isArray(body.content)) {
          for (const b of body.content) {
            if (b && b.type === "tool_use") collected.toolCalls.push({ name: b.name, input: b.input });
          }
        }
        harvest(body);
      } catch (_) {
        // non-json response
      }
    }
  };
  const reqHandler = (req) => {
    if (CHAT_ROUTE_RE.test(req.url())) {
      try {
        collected.requests.push({ url: req.url(), body: req.postDataJSON() });
      } catch (_) {
        collected.requests.push({ url: req.url() });
      }
    }
  };
  page.on("response", respHandler);
  page.on("request", reqHandler);

  const input = await findChatInput(page);
  if (!input) {
    page.off("response", respHandler);
    page.off("request", reqHandler);
    return { ok: false, reason: "chat input not found", collected };
  }

  // Focus first (some panels need focus before value change is honored)
  await input.el.focus().catch(() => {});
  await page.waitForTimeout(150);

  // React-safe value set: use the native descriptor + dispatch a real input event.
  // Playwright's .fill() and .type() bypass React's synthetic event system on
  // controlled inputs — the value gets set but React state never updates, so
  // the Send button stays disabled. This is the standard React-testing pattern.
  const setResult = await page.evaluate((msg) => {
    // Find visible textarea inside the Talk to Dossie panel
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const target = textareas.find((t) => {
      if (t.disabled) return false;
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!target) return { ok: false, reason: 'no visible textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(target, msg);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: target.value };
  }, message);
  if (!setResult.ok) {
    page.off("response", respHandler);
    page.off("request", reqHandler);
    return { ok: false, reason: `input value set failed: ${setResult.reason}`, collected };
  }
  await page.waitForTimeout(300);

  // Wait for the Send button to become enabled (React state settled)
  let sendReady = false;
  for (let i = 0; i < 20; i++) {
    const state = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Send');
      if (!btn) return { found: false };
      const r = btn.getBoundingClientRect();
      return { found: true, disabled: btn.disabled, visible: r.width > 0 && r.height > 0 };
    });
    if (state.found && !state.disabled && state.visible) {
      sendReady = true;
      break;
    }
    await page.waitForTimeout(150);
  }

  let sendMethod = null;
  if (sendReady) {
    // Click Send via DOM to bypass viewport clipping issues
    const clickResult = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Send');
      if (!btn || btn.disabled) return { ok: false, reason: 'send not clickable' };
      btn.click();
      return { ok: true };
    });
    sendMethod = clickResult.ok ? 'button-dom-click' : 'button-failed';
  }
  if (!sendReady || sendMethod === 'button-failed') {
    // Fallback: press Ctrl+Enter (many textarea handlers wire this as submit)
    await page.keyboard.press('Control+Enter').catch(() => {});
    sendMethod = sendMethod || 'ctrl-enter-fallback';
  }

  // Wait for /api/chat to resolve
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (collected.responses.length > 0) break;
    await page.waitForTimeout(500);
  }
  // Extra grace for tool-execution roundtrip (the chat endpoint may follow up)
  await page.waitForTimeout(2500);

  page.off("response", respHandler);
  page.off("request", reqHandler);

  return {
    ok: collected.responses.length > 0,
    reason: collected.responses.length === 0 ? `no /api/chat response within timeout (send method: ${sendMethod})` : null,
    sendMethod,
    collected,
  };
}

module.exports = { openChatPanel, findChatInput, sendMessage };
