// Calculator widget — mounts the TREC deadline calculator UI inside any
// container element with id="dossie-calculator". Used by /calculator and
// every /guides/* page so we don't duplicate JS.
//
// Usage:
//   <div id="dossie-calculator" data-defaults="quick"></div>
//   <script src="/assets/trec-engine.js"></script>
//   <script src="/assets/calculator-widget.js"></script>
(function () {
  'use strict';

  var ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE';

  var INPUTS = ['effectiveDate', 'closingDate', 'optionDays', 'optionFeeDays', 'earnestDays', 'financingDays', 'surveyDays'];

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k.indexOf('data-') === 0) e.setAttribute(k, attrs[k]);
        else e[k] = attrs[k];
      }
    }
    if (kids) {
      kids.forEach(function (kid) {
        if (kid == null) return;
        if (typeof kid === 'string') e.appendChild(document.createTextNode(kid));
        else e.appendChild(kid);
      });
    }
    return e;
  }

  function todayISO(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function buildHTML(host) {
    host.innerHTML = '\n  <div class="dc-grid">\n    <section class="dc-panel">\n      <h2 class="dc-panel-title">Contract dates</h2>\n      <p class="dc-panel-sub">Match values from your TREC 20-17 contract.</p>\n      <label class="dc-field"><span class="dc-field-label">Effective date</span><input class="dc-field-input" type="date" id="dc-effectiveDate" required></label>\n      <label class="dc-field"><span class="dc-field-label">Closing date</span><input class="dc-field-input" type="date" id="dc-closingDate" required></label>\n      <label class="dc-field"><span class="dc-field-label">Option period (days)</span><input class="dc-field-input" type="number" id="dc-optionDays" min="0" step="1" value="10"><span class="dc-field-hint">¶ 5B. Calendar days — no weekend rollover.</span></label>\n      <div class="dc-row-2">\n        <label class="dc-field"><span class="dc-field-label">Option fee (days)</span><input class="dc-field-input" type="number" id="dc-optionFeeDays" min="0" step="1" value="3"></label>\n        <label class="dc-field"><span class="dc-field-label">Earnest money (days)</span><input class="dc-field-input" type="number" id="dc-earnestDays" min="0" step="1" value="3"></label>\n      </div>\n      <label class="dc-field"><span class="dc-field-label">Financing days (0 if cash)</span><input class="dc-field-input" type="number" id="dc-financingDays" min="0" step="1" value="21"><span class="dc-field-hint">Third Party Financing Addendum (40-11).</span></label>\n      <label class="dc-field"><span class="dc-field-label">Survey days (0 if waived)</span><input class="dc-field-input" type="number" id="dc-surveyDays" min="0" step="1" value="10"><span class="dc-field-hint">Per ¶ 6C.</span></label>\n    </section>\n    <section class="dc-panel">\n      <h2 class="dc-panel-title">Your TREC deadlines</h2>\n      <p class="dc-panel-sub" id="dc-resultsSub">Computed in real time. Weekend & holiday rollover applied per ¶ 23.</p>\n      <div class="dc-deadlines" id="dc-deadlinesList"></div>\n      <div class="dc-email-capture" id="dc-emailCapture" hidden>\n        <h3>Save your deadlines.</h3>\n        <p>Get an email reminder 3 days before each one — sent from a Texas REALTOR®, not a robot.</p>\n        <form class="dc-email-form" id="dc-emailForm" novalidate>\n          <input type="email" id="dc-emailInput" placeholder="you@example.com" autocomplete="email" required>\n          <button type="submit" id="dc-emailSubmit">Email me reminders</button>\n        </form>\n        <div class="dc-email-result" id="dc-emailResult" role="status" aria-live="polite"></div>\n        <div class="dc-email-cta-fallback">Want this automatic for every deal? <a href="/founding">Become a Dossie founding member →</a></div>\n      </div>\n    </section>\n  </div>\n  ';
  }

  function $(id) { return document.getElementById(id); }
  function readInputs() {
    var v = function (id) { return ($(id).value || '').trim(); };
    var n = function (id) { var x = parseInt(v(id), 10); return Number.isFinite(x) ? x : 0; };
    return {
      effectiveDate: v('dc-effectiveDate'),
      closingDate: v('dc-closingDate'),
      optionDays: n('dc-optionDays'),
      optionFeeDays: n('dc-optionFeeDays'),
      earnestDays: n('dc-earnestDays'),
      financingDays: n('dc-financingDays'),
      surveyDays: n('dc-surveyDays')
    };
  }

  function renderEmpty() {
    var list = $('dc-deadlinesList');
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'dc-empty' }, [
      el('div', { class: 'dc-empty-emoji' }, ['📅']),
      'Enter your contract dates to see deadlines.'
    ]));
    $('dc-emailCapture').hidden = true;
  }

  function renderResult(result) {
    var list = $('dc-deadlinesList');
    list.innerHTML = '';
    if (!result.ok) { renderEmpty(); return; }

    if (result.warnings && result.warnings.length > 0) {
      result.warnings.forEach(function (w) {
        list.appendChild(el('div', { class: 'dc-row', 'data-tone': 'urgent' }, [
          el('div', { class: 'dc-icon' }, ['⚠️']),
          el('div', { class: 'dc-body' }, [
            el('div', { class: 'dc-label' }, ['Heads up']),
            el('div', { class: 'dc-meta' }, [w])
          ]),
          el('div', {})
        ]));
      });
    }

    result.deadlines.forEach(function (d) {
      var children = [
        el('div', { class: 'dc-icon' }, [d.icon || '📅']),
        el('div', { class: 'dc-body' }, [
          el('div', { class: 'dc-label' }, [d.label]),
          el('div', { class: 'dc-meta' }, [d.dateDisplay]),
          el('div', { class: 'dc-paragraph' }, [d.paragraph || ''])
        ]),
        el('div', { class: 'dc-pill', 'data-tone': d.tone }, [d.pillLabel])
      ];
      if (d.rolledOver && d.rolloverReason) children.push(el('div', { class: 'dc-rollover' }, ['Rolled per ¶ 23: ' + d.rolloverReason]));
      if (d.warnings && d.warnings.length > 0) {
        d.warnings.forEach(function (w) { children.push(el('div', { class: 'dc-warning' }, [w])); });
      }
      list.appendChild(el('div', { class: 'dc-row', 'data-tone': d.tone }, children));
    });

    $('dc-resultsSub').textContent = result.deadlines.length + ' deadlines computed. Weekend & holiday rollover applied per ¶ 23.';
    $('dc-emailCapture').hidden = false;
  }

  var lastInputs = null;
  var lastDeadlines = null;
  function recompute() {
    var inputs = readInputs();
    lastInputs = inputs;
    if (!inputs.effectiveDate || !inputs.closingDate) {
      renderEmpty();
      lastDeadlines = null;
      return;
    }
    var result = window.TRECEngine.compute(inputs);
    lastDeadlines = result.ok ? result.deadlines : null;
    renderResult(result);
  }

  function wireEmailForm() {
    $('dc-emailForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var input = $('dc-emailInput');
      var btn = $('dc-emailSubmit');
      var result = $('dc-emailResult');
      var email = (input.value || '').trim();
      result.className = 'dc-email-result';
      result.textContent = '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        result.classList.add('err'); result.textContent = 'Please enter a valid email.'; return;
      }
      if (!lastDeadlines || !lastInputs) {
        result.classList.add('err'); result.textContent = 'Please calculate deadlines first.'; return;
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        var res = await fetch('/api/save-calculator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email,
            contract: lastInputs,
            deadlines: lastDeadlines.map(function (d) { return { id: d.id, label: d.label, paragraph: d.paragraph, date: d.date }; })
          })
        });
        try {
          await fetch('https://pgwoitbdiyubjugwufhk.supabase.co/rest/v1/waitlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, Prefer: 'return=minimal' },
            body: JSON.stringify({ email: email, source: 'calculator' })
          });
        } catch (_) {}
        if (res.ok) {
          result.classList.add('ok');
          result.textContent = 'Saved. We\'ll email you 3 days before each deadline.';
          input.value = '';
        } else {
          var msg = 'Could not save just now. Try again in a minute.';
          try { var body = await res.json(); if (body && body.error) msg = body.error; } catch (_) {}
          result.classList.add('err'); result.textContent = msg;
        }
      } catch (err) {
        result.classList.add('err'); result.textContent = 'Network error. Try again.';
      } finally {
        btn.disabled = false; btn.textContent = 'Email me reminders';
      }
    });
  }

  function mount() {
    var host = document.getElementById('dossie-calculator');
    if (!host) return;
    if (!window.TRECEngine) { console.error('TRECEngine missing — load /assets/trec-engine.js first'); return; }
    buildHTML(host);
    $('dc-effectiveDate').value = todayISO(0);
    $('dc-closingDate').value = todayISO(30);
    INPUTS.forEach(function (id) { $('dc-' + id).addEventListener('input', recompute); });
    wireEmailForm();
    recompute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
