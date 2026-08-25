const statusEl = document.getElementById('status')
const armBtn = document.getElementById('armBtn')
const pendingListEl = document.getElementById('pendingList')
const connEl = document.getElementById('conn')

function fmtParams(action, params) {
  if (action === 'navigate') return params.url
  if (action === 'click') return `click: ${params.selector}`
  if (action === 'type') return `type "${(params.text || '').slice(0, 60)}" into ${params.selector}`
  return JSON.stringify(params)
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'get_status' })

  if (st.armed && st.tab) {
    armBtn.textContent = 'Disarm'
    armBtn.className = 'armed'
    statusEl.innerHTML = `Armed on: <b>${escapeHtml(st.tab.title || st.tab.url)}</b><br>Cole can read/act on this tab.`
  } else {
    armBtn.textContent = 'Arm this tab'
    armBtn.className = 'disarmed'
    statusEl.textContent = 'Not armed. Cole cannot see or act in any tab right now.'
  }

  connEl.innerHTML = `<span class="dot ${st.connection}"></span>native host: ${st.connection}${st.lastError ? ' -- ' + escapeHtml(st.lastError) : ''}`

  pendingListEl.innerHTML = ''
  if (!st.pending || st.pending.length === 0) {
    const div = document.createElement('div')
    div.className = 'empty'
    div.textContent = 'No actions waiting for approval.'
    pendingListEl.appendChild(div)
  } else {
    for (const p of st.pending) {
      const div = document.createElement('div')
      div.className = 'pending'
      div.innerHTML = `
        <div class="action">${escapeHtml(p.action)}</div>
        <div class="detail">${escapeHtml(fmtParams(p.action, p.params || {}))}</div>
        <div class="pending-actions">
          <button class="approve" data-id="${p.id}">Approve</button>
          <button class="reject" data-id="${p.id}">Reject</button>
        </div>
      `
      pendingListEl.appendChild(div)
    }
    pendingListEl.querySelectorAll('.approve').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'resolve_pending', id: btn.dataset.id, approve: true })
        refresh()
      })
    })
    pendingListEl.querySelectorAll('.reject').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'resolve_pending', id: btn.dataset.id, approve: false })
        refresh()
      })
    })
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

armBtn.addEventListener('click', async () => {
  const st = await chrome.runtime.sendMessage({ type: 'get_status' })
  if (st.armed) {
    await chrome.runtime.sendMessage({ type: 'disarm' })
  } else {
    await chrome.runtime.sendMessage({ type: 'arm' })
  }
  refresh()
})

refresh()
// Live-update while the popup is open (e.g. a pending confirmation lands
// while Heath is looking at it).
setInterval(refresh, 2000)
