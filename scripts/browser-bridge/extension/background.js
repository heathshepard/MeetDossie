/**
 * Cole Browser Bridge -- background service worker (MV3).
 *
 * Role: the ONLY piece of this extension that talks to the native messaging
 * host (native-host/host.js on Windows). Receives commands from the host
 * (which itself is polling the browser-bridge Supabase Storage bucket for
 * work Cole queued), executes them against the currently-armed tab, and
 * sends results back to the host -> Supabase -> Cole.
 *
 * Arming model (per Heath's explicit requirement -- see the task brief):
 * this extension is NOT silently active on every tab all the time. Heath
 * clicks the toolbar icon to arm/disarm the CURRENT tab. Only an armed tab
 * accepts commands. Arming state lives in chrome.storage.session (cleared
 * automatically when Chrome closes) keyed by tabId, plus a friendly label
 * showing which tab is armed in the popup.
 *
 * Confirmation model: read-only actions (navigate, snapshot, screenshot)
 * execute immediately once the tab is armed. Anything that changes page
 * state (click, type) is queued and requires Heath to click "Approve" in
 * the popup before it fires -- this mirrors the repo's standing
 * draft-never-auto-send discipline (see CLAUDE.md /
 * feedback_draft-means-draft-never-send.md), applied to real-world browser
 * actions instead of client messages.
 *
 * Permissions / security trade-off (found by real testing, not assumed):
 * manifest.json declares host_permissions for http/https (all origins),
 * NOT just "activeTab". Tried activeTab-only first -- it broke immediately
 * in verification: activeTab's temporary grant is invalidated the moment a
 * tab navigates (documented Chrome behavior), so a `navigate` command
 * followed by `snapshot`/`click`/`type` on the SAME armed tab failed with
 * "Cannot access contents of the page" -- there is no way for this
 * background script to re-trigger the user-gesture that activeTab requires,
 * so every navigate would have silently broken every action after it. Since
 * this extension is loaded unpacked in developer mode (never published to
 * the Web Store), declared host_permissions are granted at load time with
 * no separate runtime prompt -- so the real security boundary here is NOT
 * "which origins can this extension technically script" (broad, by
 * necessity) but "which tab will this code actually act on", enforced
 * entirely by the armedTabId check below plus the arm/disarm toggle Heath
 * controls. Compromise of this extension's code or the Supabase bucket it
 * polls could act on whatever tab is currently armed -- same blast radius
 * as any other automation glued into a real logged-in session, which is
 * exactly why arming is manual, per-tab, and never on by default.
 */

const NATIVE_HOST_NAME = 'com.shepardventures.browser_bridge'

let port = null
let armedTabId = null // number | null -- the single tab this session may act on
let pendingConfirmations = new Map() // command_id -> { command, tabId }
let connectionStatus = 'disconnected' // 'disconnected' | 'connecting' | 'connected' | 'error'
let lastError = null

function log(...args) {
  console.log('[browser-bridge]', ...args)
}

function connectNative() {
  if (port) return
  connectionStatus = 'connecting'
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  } catch (err) {
    connectionStatus = 'error'
    lastError = String(err)
    log('connectNative threw', err)
    port = null
    return
  }
  port.onMessage.addListener(onNativeMessage)
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    connectionStatus = 'disconnected'
    lastError = err ? err.message : null
    log('native host disconnected', err)
    port = null
    // Reconnect lazily -- next command / popup open will call connectNative()
    // again. Don't hammer a retry loop if the host isn't installed.
  })
  connectionStatus = 'connected'
  lastError = null
  log('connected to native host')
}

function sendToHost(msg) {
  if (!port) connectNative()
  if (!port) return false
  try {
    port.postMessage(msg)
    return true
  } catch (err) {
    log('postMessage failed', err)
    return false
  }
}

async function onNativeMessage(msg) {
  log('from host:', msg)
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'command') {
    await handleCommand(msg.command)
  }
}

function replyResult(command, result, error) {
  sendToHost({
    type: 'result',
    command_id: command.id,
    ok: !error,
    result: error ? undefined : result,
    error: error ? String(error) : undefined,
  })
}

const STATE_CHANGING_ACTIONS = new Set(['click', 'type'])

async function handleCommand(command) {
  if (!command || !command.id || !command.action) {
    log('malformed command', command)
    return
  }

  if (armedTabId === null) {
    replyResult(command, null, 'not armed -- Heath has not armed this extension on any tab. Ask him to click the Cole Browser Bridge toolbar icon on the tab you want to act in.')
    return
  }

  // Confirm the armed tab still exists.
  let tab
  try {
    tab = await chrome.tabs.get(armedTabId)
  } catch {
    replyResult(command, null, 'armed tab no longer exists (closed or navigated away in a way that invalidated it) -- ask Heath to re-arm')
    armedTabId = null
    persistArmedTab()
    return
  }

  if (STATE_CHANGING_ACTIONS.has(command.action)) {
    // Queue for explicit human approval in the popup UI. Auto-expire after
    // 5 minutes so a stale, unapproved command doesn't sit around forever.
    pendingConfirmations.set(command.id, { command, tabId: armedTabId, queuedAt: Date.now() })
    notifyPopupOfPending()
    chrome.action.setBadgeText({ text: '1' })
    chrome.action.setBadgeBackgroundColor({ color: '#E8836B' })
    // Don't reply yet -- reply happens on approve/reject/timeout.
    setTimeout(() => {
      if (pendingConfirmations.has(command.id)) {
        pendingConfirmations.delete(command.id)
        replyResult(command, null, 'timed out waiting for Heath to approve/reject in the extension popup (5 min)')
        updateBadge()
      }
    }, 5 * 60 * 1000)
    return
  }

  // Read-only / navigation -- executes immediately.
  try {
    const result = await executeAction(tab.id, command)
    replyResult(command, result, null)
  } catch (err) {
    replyResult(command, null, err)
  }
}

function updateBadge() {
  const n = pendingConfirmations.size
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' })
}

function notifyPopupOfPending() {
  // Popup polls via getPending message; nothing to push here beyond the
  // badge, but keep this as a named hook in case a chrome.notifications
  // banner gets added later.
}

async function executeAction(tabId, command) {
  const { action, params = {} } = command
  switch (action) {
    case 'navigate': {
      if (!params.url) throw new Error('navigate requires params.url')
      await chrome.tabs.update(tabId, { url: params.url })
      // Wait for the tab to finish loading (bounded) before returning.
      await waitForTabComplete(tabId, 15000)
      return { navigated_to: params.url }
    }
    case 'snapshot': {
      return await execInPage(tabId, snapshotPage)
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(tabId)
      if (!tab.active) {
        // captureVisibleTab only works on the active tab of a window.
        await chrome.tabs.update(tabId, { active: true })
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      return { screenshot_data_url: dataUrl }
    }
    case 'click': {
      return await execInPage(tabId, clickSelector, [params.selector])
    }
    case 'type': {
      return await execInPage(tabId, typeIntoSelector, [params.selector, params.text ?? ''])
    }
    default:
      throw new Error(`unknown action: ${action}`)
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(finish, timeoutMs)
  })
}

async function execInPage(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return result
}

// ---- functions injected into the page (chrome.scripting.executeScript) ----
// These run in the page's isolated world -- no access to closures above,
// must be fully self-contained.

function snapshotPage() {
  function visible(el) {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  function cssPath(el) {
    if (el.id) return `#${el.id}`
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      let selector = node.tagName.toLowerCase()
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.')
        if (cls) selector += `.${cls}`
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName)
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(node) + 1})`
      }
      parts.unshift(selector)
      node = parent
    }
    return parts.join(' > ')
  }
  const interactiveSelectors = 'a[href], button, input, select, textarea, [role="button"], [onclick]'
  const interactive = Array.from(document.querySelectorAll(interactiveSelectors))
    .filter(visible)
    .slice(0, 150)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
      href: el.tagName === 'A' ? el.href : undefined,
      type: el.tagName === 'INPUT' ? el.type : undefined,
    }))
  const bodyText = document.body ? document.body.innerText.slice(0, 8000) : ''
  return {
    url: location.href,
    title: document.title,
    visible_text: bodyText,
    interactive_elements: interactive,
  }
}

function clickSelector(selector) {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`no element matched selector: ${selector}`)
  el.scrollIntoView({ block: 'center' })
  el.click()
  return { clicked: selector, tag: el.tagName.toLowerCase() }
}

function typeIntoSelector(selector, text) {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`no element matched selector: ${selector}`)
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if ('value' in el) {
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, text)
    else el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    el.textContent = text
  }
  return { typed_into: selector, length: text.length }
}

// ---- popup <-> background messaging ----------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    if (msg.type === 'arm') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      armedTabId = tab.id
      persistArmedTab()
      connectNative()
      sendResponse({ ok: true, tabId: tab.id, title: tab.title, url: tab.url })
    } else if (msg.type === 'disarm') {
      armedTabId = null
      persistArmedTab()
      sendResponse({ ok: true })
    } else if (msg.type === 'get_status') {
      let tabInfo = null
      if (armedTabId !== null) {
        try {
          const t = await chrome.tabs.get(armedTabId)
          tabInfo = { id: t.id, title: t.title, url: t.url }
        } catch {
          armedTabId = null
        }
      }
      sendResponse({
        armed: armedTabId !== null,
        tab: tabInfo,
        connection: connectionStatus,
        lastError,
        pending: Array.from(pendingConfirmations.entries()).map(([id, v]) => ({
          id,
          action: v.command.action,
          params: v.command.params,
          queuedAt: v.queuedAt,
        })),
      })
    } else if (msg.type === 'resolve_pending') {
      const entry = pendingConfirmations.get(msg.id)
      if (!entry) {
        sendResponse({ ok: false, error: 'not found (may have expired)' })
        return
      }
      pendingConfirmations.delete(msg.id)
      updateBadge()
      if (msg.approve) {
        try {
          const result = await executeAction(entry.tabId, entry.command)
          replyResult(entry.command, result, null)
          sendResponse({ ok: true, result })
        } catch (err) {
          replyResult(entry.command, null, err)
          sendResponse({ ok: false, error: String(err) })
        }
      } else {
        replyResult(entry.command, null, 'rejected by Heath in the extension popup')
        sendResponse({ ok: true, rejected: true })
      }
    } else if (msg.type === 'reconnect') {
      connectNative()
      sendResponse({ ok: true })
    }
  })()
  return true // keep the message channel open for the async response
})

function persistArmedTab() {
  chrome.storage.session.set({ armedTabId })
}

chrome.storage.session.get(['armedTabId']).then(v => {
  if (typeof v.armedTabId === 'number') armedTabId = v.armedTabId
})

// De-arm automatically if the armed tab is closed.
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === armedTabId) {
    armedTabId = null
    persistArmedTab()
  }
})

// Try to connect on service worker startup so a queued command doesn't have
// to wait for the popup to be opened first.
connectNative()

// MV3 service workers are ephemeral -- Chrome can suspend this one after
// ~30s idle with no open ports/listeners, and native messaging hosts are
// killed the moment the port that spawned them disconnects (Chrome closes
// the host's stdin). Net effect without a keep-alive: leave the popup
// closed and don't touch the tab for half a minute, and the native host
// process Chrome launched quietly exits -- the next queued command from
// Cole would just time out with no obvious cause. chrome.alarms firing is
// one of the documented ways to wake a suspended MV3 service worker; use it
// to periodically re-assert the native connection. connectNative() is a
// no-op if a port is already open, so this is safe to call on a timer.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }) // ~24s, under the ~30s suspend window
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepalive') connectNative()
})
