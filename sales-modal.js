/* sales-modal.js
 * Shared "Contact Sales" lead-capture modal for /agents and /coordinators.
 * Direct-fetch INSERT into Supabase public.sales_leads (anon-insert RLS),
 * then POST the inserted id to /api/notify-sales-lead so Heath's Telegram
 * fires with authoritative DB content.
 *
 * Usage:
 *   <script src="/sales-modal.js"></script>
 *   <button onclick="openSalesModal({ source: 'agents' })">Contact Sales</button>
 *
 * Direct-fetch + hardcoded anon JWT mirrors the waitlist flow already in use
 * (Cloudflare's email obfuscator broke supabase-js previously).
 */
(function () {
  if (window.openSalesModal) return;

  var SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE';

  var STYLE_ID = 'dossie-sales-modal-style';
  var ROOT_ID = 'dossie-sales-modal-root';

  var CSS = [
    '@keyframes dsm-fade-in { from { opacity: 0; } to { opacity: 1; } }',
    '@keyframes dsm-pop-in { from { opacity: 0; transform: translateY(16px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }',
    '.dsm-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(26,26,46,0.55); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 20px; animation: dsm-fade-in 0.18s ease-out; }',
    '.dsm-card { position: relative; width: 100%; max-width: 540px; max-height: calc(100vh - 40px); overflow-y: auto; background: #FFFFFF; border: 1px solid #E8E2D9; border-radius: 24px; padding: 40px 36px 32px; box-shadow: 0 30px 80px rgba(26,26,46,0.32); animation: dsm-pop-in 0.22s ease-out; font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif; color: #1A1A2E; }',
    '.dsm-card * { box-sizing: border-box; }',
    '.dsm-close { position: absolute; top: 14px; right: 14px; width: 36px; height: 36px; border: none; background: transparent; color: #7A7468; font-size: 22px; line-height: 1; border-radius: 999px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, color 0.15s; }',
    '.dsm-close:hover { background: #F0EBE3; color: #1A1A2E; }',
    '.dsm-eyebrow { font-size: 11px; letter-spacing: 2.2px; text-transform: uppercase; font-weight: 700; color: #6B8E68; margin-bottom: 10px; }',
    '.dsm-title { font-family: "Cormorant Garamond", Georgia, serif; font-size: 32px; font-weight: 600; line-height: 1.1; letter-spacing: -0.6px; color: #1A1A2E; margin: 0; }',
    '.dsm-title em { font-style: italic; color: #C08080; }',
    '.dsm-sub { margin-top: 10px; font-size: 14px; color: #7A7468; line-height: 1.55; }',
    '.dsm-form { margin-top: 22px; display: flex; flex-direction: column; gap: 14px; }',
    '.dsm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }',
    '.dsm-field { display: flex; flex-direction: column; gap: 6px; }',
    '.dsm-label { font-size: 12px; font-weight: 600; color: #2D2A26; letter-spacing: 0.2px; }',
    '.dsm-required { color: #C08080; margin-left: 2px; }',
    '.dsm-input, .dsm-textarea { font-family: inherit; font-size: 14px; color: #1A1A2E; background: #FDFCFA; border: 1px solid #E8E2D9; border-radius: 12px; padding: 11px 13px; outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; width: 100%; }',
    '.dsm-textarea { min-height: 96px; resize: vertical; line-height: 1.5; }',
    '.dsm-input:focus, .dsm-textarea:focus { border-color: #D4A0A0; box-shadow: 0 0 0 3px rgba(212,160,160,0.18); background: #FFFFFF; }',
    '.dsm-input.dsm-error, .dsm-textarea.dsm-error { border-color: #C9624A; box-shadow: 0 0 0 3px rgba(232,131,107,0.18); }',
    '.dsm-submit { margin-top: 6px; padding: 14px 22px; font-family: inherit; font-size: 15px; font-weight: 700; color: #FFFFFF; background: #C08080; border: none; border-radius: 999px; cursor: pointer; transition: background 0.15s, transform 0.15s, box-shadow 0.15s; box-shadow: 0 12px 28px rgba(192,128,128,0.28); }',
    '.dsm-submit:hover:not(:disabled) { background: #A86060; transform: translateY(-1px); box-shadow: 0 16px 34px rgba(192,128,128,0.36); }',
    '.dsm-submit:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }',
    '.dsm-error-banner { margin-top: 4px; padding: 10px 14px; background: #FCE4DC; border: 1px solid #E8836B; border-radius: 10px; color: #C9624A; font-size: 13px; line-height: 1.4; }',
    '.dsm-success { text-align: center; padding: 24px 12px 8px; }',
    '.dsm-success-icon { width: 56px; height: 56px; border-radius: 999px; background: #E4EDE2; color: #6B8E68; display: inline-flex; align-items: center; justify-content: center; font-size: 28px; margin-bottom: 18px; }',
    '.dsm-success-title { font-family: "Cormorant Garamond", Georgia, serif; font-size: 28px; font-weight: 600; color: #1A1A2E; line-height: 1.15; }',
    '.dsm-success-body { margin-top: 12px; font-size: 14.5px; color: #7A7468; line-height: 1.6; }',
    '.dsm-success-close { margin-top: 22px; padding: 12px 24px; font-family: inherit; font-size: 14px; font-weight: 600; color: #1A1A2E; background: #FDFCFA; border: 1px solid #E8E2D9; border-radius: 999px; cursor: pointer; transition: background 0.15s; }',
    '.dsm-success-close:hover { background: #F0EBE3; }',
    '@media (max-width: 540px) {',
    '  .dsm-card { padding: 32px 22px 24px; border-radius: 20px; }',
    '  .dsm-title { font-size: 26px; }',
    '  .dsm-row { grid-template-columns: 1fr; }',
    '}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function isValidEmail(e) {
    if (typeof e !== 'string') return false;
    var s = e.trim();
    if (s.length < 5 || s.length > 320) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function parseIntOrNull(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    var n = parseInt(s.replace(/[, ]/g, ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function close(root) {
    if (!root || !root.parentNode) return;
    root.parentNode.removeChild(root);
    document.removeEventListener('keydown', root._onKey);
    document.body.style.overflow = root._priorOverflow || '';
  }

  async function submitLead(payload) {
    // INSERT with Prefer: return=minimal. RLS allows anon INSERT but not
    // SELECT, so return=representation would 401 on the SELECT-back step.
    var insertRes = await fetch(SUPABASE_URL + '/rest/v1/sales_leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
    if (!insertRes.ok) {
      var errText = '';
      try { errText = await insertRes.text(); } catch (_e) {}
      throw new Error('insert ' + insertRes.status + ' ' + errText.slice(0, 200));
    }

    // Fire-and-best-effort Telegram ping. The endpoint will look up the row
    // server-side using email + recent created_at and use the DB content as
    // the source of truth for the message body.
    try {
      await fetch('/api/notify-sales-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: payload.email })
      });
    } catch (_e) {
      // Swallowed: the row is already in the DB; Heath can find it there.
    }
  }

  function buildModal(opts) {
    opts = opts || {};
    var source = opts.source || 'unknown';

    var nameInput = el('input', { type: 'text', class: 'dsm-input', name: 'name', autocomplete: 'name', placeholder: 'Jane Cooper' });
    var emailInput = el('input', { type: 'email', class: 'dsm-input', name: 'email', autocomplete: 'email', placeholder: 'jane@brokerage.com' });
    var brokerageInput = el('input', { type: 'text', class: 'dsm-input', name: 'brokerage', autocomplete: 'organization', placeholder: 'Acme Realty' });
    var agentCountInput = el('input', { type: 'number', class: 'dsm-input', name: 'agent_count', min: '0', step: '1', inputmode: 'numeric', placeholder: 'e.g. 12' });
    var txCountInput = el('input', { type: 'number', class: 'dsm-input', name: 'monthly_transactions', min: '0', step: '1', inputmode: 'numeric', placeholder: 'e.g. 30' });
    // Heard-from dropdown — same options + slugs as the founding form.
    var heardFromInput = el('select', { class: 'dsm-input', name: 'heard_from' });
    [
      ['', 'Select…', true],
      ['facebook_group', 'Facebook group post'],
      ['facebook_page', 'Facebook page'],
      ['instagram', 'Instagram'],
      ['tiktok', 'TikTok'],
      ['twitter_x', 'Twitter/X'],
      ['google_search', 'Google search'],
      ['word_of_mouth', 'Word of mouth / another agent'],
      ['trec_calculator', 'The TREC deadline calculator'],
      ['linkedin', 'LinkedIn'],
      ['other', 'Other'],
    ].forEach(function (opt) {
      var attrs = { value: opt[0] };
      if (opt[2]) { attrs.disabled = 'disabled'; attrs.selected = 'selected'; }
      heardFromInput.appendChild(el('option', attrs, [opt[1]]));
    });
    var messageInput = el('textarea', { class: 'dsm-textarea', name: 'message', placeholder: 'A few sentences on what you’re hoping Dossie can do for your team.' });

    var errorBanner = el('div', { class: 'dsm-error-banner', style: 'display:none' });
    var submitBtn = el('button', { type: 'submit', class: 'dsm-submit' }, ['Send Inquiry']);

    function setError(field, on) {
      if (on) field.classList.add('dsm-error'); else field.classList.remove('dsm-error');
    }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }
    function clearError() {
      errorBanner.textContent = '';
      errorBanner.style.display = 'none';
    }
    function clearFieldErrors() {
      [nameInput, emailInput, brokerageInput, agentCountInput, txCountInput, heardFromInput, messageInput].forEach(function (f) { setError(f, false); });
    }

    var form = el('form', { class: 'dsm-form', novalidate: 'novalidate' }, [
      el('div', { class: 'dsm-field' }, [
        el('label', { class: 'dsm-label' }, ['Name', el('span', { class: 'dsm-required' }, ['*'])]),
        nameInput
      ]),
      el('div', { class: 'dsm-field' }, [
        el('label', { class: 'dsm-label' }, ['Email', el('span', { class: 'dsm-required' }, ['*'])]),
        emailInput
      ]),
      el('div', { class: 'dsm-field' }, [
        el('label', { class: 'dsm-label' }, ['Brokerage name']),
        brokerageInput
      ]),
      el('div', { class: 'dsm-row' }, [
        el('div', { class: 'dsm-field' }, [
          el('label', { class: 'dsm-label' }, ['Number of agents']),
          agentCountInput
        ]),
        el('div', { class: 'dsm-field' }, [
          el('label', { class: 'dsm-label' }, ['Monthly transactions']),
          txCountInput
        ])
      ]),
      el('div', { class: 'dsm-field' }, [
        el('label', { class: 'dsm-label' }, ['How did you hear about Dossie?', el('span', { class: 'dsm-required' }, ['*'])]),
        heardFromInput
      ]),
      el('div', { class: 'dsm-field' }, [
        el('label', { class: 'dsm-label' }, ['What are you looking for?']),
        messageInput
      ]),
      errorBanner,
      submitBtn
    ]);

    var card = el('div', { class: 'dsm-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsm-title' }, [
      el('button', { type: 'button', class: 'dsm-close', 'aria-label': 'Close' }, ['×']),
      el('div', { class: 'dsm-eyebrow' }, ['Talk to Sales']),
      el('h2', { class: 'dsm-title', id: 'dsm-title' }, ['Let’s talk about your ', el('em', null, ['team.'])]),
      el('p', { class: 'dsm-sub' }, ['Tell us a little about what you’re running and Heath will personally reach out within 24 hours.']),
      form
    ]);

    var backdrop = el('div', { class: 'dsm-backdrop' }, [card]);
    backdrop.id = ROOT_ID;

    // Close handlers
    function doClose() { close(backdrop); }
    card.querySelector('.dsm-close').addEventListener('click', doClose);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) doClose(); });
    backdrop._onKey = function (e) { if (e.key === 'Escape') doClose(); };
    document.addEventListener('keydown', backdrop._onKey);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      clearError();
      clearFieldErrors();

      var name = nameInput.value.trim();
      var email = emailInput.value.trim();
      var brokerage = brokerageInput.value.trim();
      var agents = parseIntOrNull(agentCountInput.value);
      var tx = parseIntOrNull(txCountInput.value);
      var heardFrom = (heardFromInput.value || '').trim();
      var message = messageInput.value.trim();

      var bad = false;
      if (!name) { setError(nameInput, true); bad = true; }
      if (!isValidEmail(email)) { setError(emailInput, true); bad = true; }
      var heardOptions = ['facebook_group','facebook_page','instagram','tiktok','twitter_x','google_search','word_of_mouth','trec_calculator','linkedin','other'];
      if (heardOptions.indexOf(heardFrom) === -1) { setError(heardFromInput, true); bad = true; }
      if (bad) {
        showError('Name, a valid email, and how you heard about Dossie are required.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      try {
        await submitLead({
          name: name,
          email: email.toLowerCase(),
          brokerage: brokerage || null,
          agent_count: agents,
          monthly_transactions: tx,
          heard_from: heardFrom,
          message: message || null,
          source_page: source
        });

        // Replace card body with success state.
        card.innerHTML = '';
        var closeBtn = el('button', { type: 'button', class: 'dsm-close', 'aria-label': 'Close' }, ['×']);
        closeBtn.addEventListener('click', doClose);
        card.appendChild(closeBtn);
        card.appendChild(el('div', { class: 'dsm-success' }, [
          el('div', { class: 'dsm-success-icon' }, ['✓']),
          el('h2', { class: 'dsm-success-title' }, ['Thanks!']),
          el('p', { class: 'dsm-success-body' }, ['Heath will personally reach out within 24 hours.']),
          (function () {
            var b = el('button', { type: 'button', class: 'dsm-success-close' }, ['Close']);
            b.addEventListener('click', doClose);
            return b;
          })()
        ]));
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Inquiry';
        showError('Something went wrong sending your inquiry. Please try again, or email heath@meetdossie.com.');
        if (window.console && console.error) console.error('[sales-modal]', err && err.message);
      }
    });

    return backdrop;
  }

  window.openSalesModal = function (opts) {
    injectStyle();
    var existing = document.getElementById(ROOT_ID);
    if (existing) close(existing);
    var root = buildModal(opts);
    document.body.appendChild(root);
    root._priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus first field for keyboard users.
    setTimeout(function () {
      var first = root.querySelector('input, textarea');
      if (first) first.focus();
    }, 30);
  };
})();
