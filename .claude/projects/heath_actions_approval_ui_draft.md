# PENDING APPROVALS Panel — Jarvis HUD v5

## Schema (confirmed via Supabase query)

Table: `heath_actions`
- id (uuid, PK)
- tenant_id (uuid)
- title (text)
- body (text, nullable)
- source (text) — agent name
- priority (text) — "high", "medium", "low"
- deadline (timestamptz, nullable)
- status (text) — "pending", "approved", "rejected", "snoozed"
- created_at (timestamptz)
- completed_at (timestamptz, nullable)
- snoozed_until (timestamptz, nullable)
- evidence_url (text, nullable) — link to full context
- action_type (text, nullable) — "send_email", "execute_merge", "send_telegram"
- payload (jsonb, nullable) — action-specific data
- approved_at (timestamptz, nullable)
- executed_at (timestamptz, nullable)
- execution_result (jsonb, nullable)
- failure_reason (text, nullable)

## CSS insertion points

Add to stylesheet (after line ~750, before action-cards section):

```css
/* ===== PENDING APPROVALS PANEL (NEW) ===== */
.pending-approvals-title-row {
  display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
}
.approvals-count {
  font-family: 'Inter', sans-serif;
  font-size: 10px; letter-spacing: 0.18em;
  color: var(--cyan-bright);
  text-transform: uppercase;
  font-weight: 500;
  background: rgba(77, 208, 225, 0.15);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(77, 208, 225, 0.3);
}
.approvals-empty {
  font-size: 13px; color: var(--txt-mute);
  text-align: center; padding: 20px 0;
}
.approval-card {
  background: rgba(77, 208, 225, 0.04);
  border-left: 3px solid var(--cyan);
  border-top: 1px solid rgba(77, 208, 225, 0.15);
  border-right: 1px solid rgba(77, 208, 225, 0.15);
  border-bottom: 1px solid rgba(77, 208, 225, 0.15);
  border-radius: 10px;
  padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
  transition: all 0.2s ease;
  animation: approval-slide-in 0.3s ease-out;
}
.approval-card.high-priority { border-left-color: var(--fail); }
.approval-card.medium-priority { border-left-color: var(--gold); }
.approval-card.low-priority { border-left-color: var(--txt-faint); }
.approval-card.snoozed {
  opacity: 0.55;
  border-left-color: var(--txt-faint);
}
@keyframes approval-slide-in {
  from { opacity: 0; transform: translateX(12px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes approval-fade-out {
  to { opacity: 0; transform: translateX(-12px); }
}
.approval-card.removing { animation: approval-fade-out 0.3s ease-in forwards; }
.approval-header {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;
}
.approval-title {
  font-size: 13px; font-weight: 500;
  color: var(--txt-primary);
  line-height: 1.3;
  flex: 1;
}
.approval-badge {
  padding: 2px 6px; border-radius: 4px; font-size: 9px;
  letter-spacing: 0.14em; text-transform: uppercase;
  flex-shrink: 0;
  white-space: nowrap;
}
.approval-badge.high {
  background: rgba(232, 94, 94, 0.15);
  color: var(--fail);
  border: 1px solid rgba(232, 94, 94, 0.3);
}
.approval-badge.medium {
  background: rgba(201, 169, 110, 0.15);
  color: var(--gold);
  border: 1px solid rgba(201, 169, 110, 0.3);
}
.approval-badge.low {
  background: rgba(226, 244, 251, 0.08);
  color: var(--txt-mute);
  border: 1px solid rgba(226, 244, 251, 0.15);
}
.approval-desc {
  font-size: 11px; line-height: 1.4;
  color: var(--txt-mute);
  max-height: 60px; overflow-y: auto;
  word-wrap: break-word;
}
.approval-meta {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 10px; color: var(--txt-faint);
  letter-spacing: 0.1em; text-transform: uppercase;
}
.approval-time {
  color: var(--txt-faint);
}
.approval-source {
  color: var(--cyan-dim);
}
.approval-buttons {
  display: grid; grid-template-columns: 1fr 1fr auto;
  gap: 6px;
}
.approval-btn {
  font-family: inherit;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  padding: 8px 6px;
  background: transparent;
  border: 1px solid rgba(77, 208, 225, 0.25);
  border-radius: 6px;
  color: var(--cyan);
  cursor: pointer;
  transition: all 0.15s ease;
  font-weight: 500;
}
.approval-btn:hover {
  background: rgba(77, 208, 225, 0.12);
  border-color: var(--cyan-bright);
}
.approval-btn:disabled {
  opacity: 0.4; cursor: wait;
}
.approval-btn.approve {
  color: var(--ok);
  border-color: rgba(139, 168, 136, 0.3);
}
.approval-btn.approve:hover {
  background: rgba(139, 168, 136, 0.12);
  border-color: var(--ok);
}
.approval-btn.reject {
  color: var(--fail);
  border-color: rgba(232, 94, 94, 0.3);
}
.approval-btn.reject:hover {
  background: rgba(232, 94, 94, 0.12);
  border-color: var(--fail);
}
.approval-btn.snooze {
  color: var(--gold);
  border-color: rgba(201, 169, 110, 0.25);
  min-width: 44px;
}
.approval-btn.snooze:hover {
  background: rgba(201, 169, 110, 0.12);
  border-color: var(--gold);
}
@media (max-width: 500px) {
  .approval-buttons {
    grid-template-columns: 1fr 1fr;
  }
  .approval-btn.snooze {
    grid-column: 1 / -1;
  }
}
.approval-toast {
  position: fixed; bottom: 16px; right: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 12px;
  z-index: 1000;
  animation: toast-slide-in 0.3s ease-out;
  max-width: 300px;
}
@keyframes toast-slide-in {
  from { opacity: 0; transform: translateX(100px); }
  to   { opacity: 1; transform: translateX(0); }
}
.approval-toast.success {
  background: rgba(139, 168, 136, 0.2);
  border: 1px solid var(--ok);
  color: var(--ok);
}
.approval-toast.error {
  background: rgba(232, 94, 94, 0.2);
  border: 1px solid var(--fail);
  color: var(--fail);
}
.approval-toast.info {
  background: rgba(77, 208, 225, 0.2);
  border: 1px solid var(--cyan);
  color: var(--cyan);
}
```

## HTML insertion (insert BEFORE AGENT STATUS panel at line ~2605)

```html
<!-- PENDING APPROVALS (NEW — 2026-06-25 Heath's HUD action queue UI) -->
<div class="panel" id="approvals-panel">
  <div class="panel-title pending-approvals-title-row">
    <span>PENDING APPROVALS</span>
    <span class="approvals-count" id="approvals-badge">—</span>
  </div>
  <div id="approvals-list">
    <div class="approvals-empty">Nothing waiting on you. ?</div>
  </div>
</div>
```

## JavaScript handlers (add to jarvis-pwa.html <script> section)

```javascript
// ===== PENDING APPROVALS PANEL =====
const approvalsPanel = {
  async init() {
    this.container = document.getElementById('approvals-list');
    this.badge = document.getElementById('approvals-badge');
    this.lastRefresh = 0;
    this.refreshInterval = 60000; // 60s auto-refresh
    
    // Initial load
    await this.loadPendingActions();
    
    // Set up polling
    setInterval(() => this.loadPendingActions(), this.refreshInterval);
  },

  async loadPendingActions() {
    try {
      const { data: actions, error } = await supabase
        .from('heath_actions')
        .select('*')
        .eq('tenant_id', TENANT_ID)
        .in('status', ['pending', 'snoozed'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Filter out snoozed actions that are still in future
      const now = new Date();
      const pending = actions.filter(a => {
        if (a.status === 'snoozed' && a.snoozed_until) {
          return new Date(a.snoozed_until) <= now;
        }
        return a.status === 'pending';
      });

      this.render(pending);
      this.badge.textContent = pending.length > 0 ? pending.length : '—';
    } catch (err) {
      console.error('loadPendingActions error:', err);
    }
  },

  render(actions) {
    if (actions.length === 0) {
      this.container.innerHTML = '<div class="approvals-empty">Nothing waiting on you. ?</div>';
      return;
    }

    const html = actions.map(action => this.renderCard(action)).join('');
    this.container.innerHTML = html;

    // Attach event listeners
    actions.forEach(action => {
      document.querySelector(`[data-action-id="${action.id}"] .approval-btn.approve`)
        ?.addEventListener('click', () => this.handleApprove(action.id));
      document.querySelector(`[data-action-id="${action.id}"] .approval-btn.reject`)
        ?.addEventListener('click', () => this.handleReject(action.id));
      document.querySelector(`[data-action-id="${action.id}"] .approval-btn.snooze`)
        ?.addEventListener('click', () => this.handleSnooze(action.id));
    });
  },

  renderCard(action) {
    const priorityClass = action.priority?.toLowerCase() || 'medium';
    const timeAgo = this.formatTimeAgo(new Date(action.created_at));
    const desc = action.body ? action.body.substring(0, 120) + (action.body.length > 120 ? '…' : '') : '—';

    return `
      <div class="approval-card ${priorityClass}-priority" data-action-id="${action.id}">
        <div class="approval-header">
          <div class="approval-title">${this.escapeHtml(action.title)}</div>
          <span class="approval-badge ${priorityClass}">${action.priority?.toUpperCase()}</span>
        </div>
        <div class="approval-desc">${this.escapeHtml(desc)}</div>
        <div class="approval-meta">
          <span class="approval-source">via ${this.escapeHtml(action.source)}</span>
          <span class="approval-time">queued ${timeAgo}</span>
        </div>
        <div class="approval-buttons">
          <button class="approval-btn approve">Approve</button>
          <button class="approval-btn reject">Reject</button>
          <button class="approval-btn snooze" title="Snooze 24h">?</button>
        </div>
      </div>
    `;
  },

  formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  },

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text?.replace(/[&<>"']/g, m => map[m]) || '';
  },

  async handleApprove(actionId) {
    const card = document.querySelector(`[data-action-id="${actionId}"]`);
    const btn = card.querySelector('.approval-btn.approve');
    btn.disabled = true;

    try {
      const res = await fetch('/api/approve-heath-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Animate out and remove
      card.classList.add('removing');
      setTimeout(() => {
        card.remove();
        this.badge.textContent = document.querySelectorAll('.approval-card').length || '—';
      }, 300);

      this.showToast('Action approved', 'success');
    } catch (err) {
      console.error('handleApprove error:', err);
      btn.disabled = false;
      this.showToast(`Error: ${err.message}`, 'error');
    }
  },

  async handleReject(actionId) {
    const card = document.querySelector(`[data-action-id="${actionId}"]`);
    const btn = card.querySelector('.approval-btn.reject');
    btn.disabled = true;

    try {
      const res = await fetch('/api/reject-heath-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId, reason: 'Rejected by Heath' }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      card.classList.add('removing');
      setTimeout(() => {
        card.remove();
        this.badge.textContent = document.querySelectorAll('.approval-card').length || '—';
      }, 300);

      this.showToast('Action rejected', 'info');
    } catch (err) {
      console.error('handleReject error:', err);
      btn.disabled = false;
      this.showToast(`Error: ${err.message}`, 'error');
    }
  },

  async handleSnooze(actionId) {
    const card = document.querySelector(`[data-action-id="${actionId}"]`);
    const btns = card.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);

    try {
      const res = await fetch('/api/snooze-heath-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId, duration_hours: 24 }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      card.classList.add('snoozed');
      card.classList.add('removing');
      setTimeout(() => {
        card.remove();
        this.badge.textContent = document.querySelectorAll('.approval-card:not(.snoozed)').length || '—';
      }, 300);

      this.showToast('Snoozed for 24 hours', 'info');
    } catch (err) {
      console.error('handleSnooze error:', err);
      btns.forEach(b => b.disabled = false);
      this.showToast(`Error: ${err.message}`, 'error');
    }
  },

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `approval-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toast-slide-in 0.3s ease-out reverse';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  if (window.supabase && TENANT_ID) {
    approvalsPanel.init();
  }
});
```

## Notes

- **Schema confirmed:** heath_actions table exists with all required fields
- **Priority colors:** high=red, medium=gold, low=grey; border-left accent
- **Empty state:** "Nothing waiting on you. ?"
- **Auto-refresh:** every 60s fetches new pending + snoozed actions
- **Animations:** slide-in on new cards, fade-out on approval/reject
- **Mobile:** buttons wrap on <500px (Approve/Reject on row 1, Snooze fills row 2)
- **Toasts:** bottom-right success/error/info notifications
- **Backend stubs:** downstream action wiring (email send, git merge) deferred — just updates status for now
