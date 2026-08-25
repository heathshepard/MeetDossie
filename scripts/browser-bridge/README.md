# Cole Browser Bridge

Lets THIS live Claude Code session (the jarvis-bridge one, same session Heath
talks to via Jarvis and this terminal) read and act inside Heath's real,
logged-in Chrome browser on demand -- not a fresh, unauthenticated Playwright
session. Built 2026-08-24, Atlas.

## Why this exists

`chrome-devtools`/Playwright automation in this repo works fine for public
pages but cannot reach Heath's real authenticated sessions (Zillow, MLS
tools, Google, anything logged in) -- Chrome's app-bound cookie encryption +
Cloudflare bot detection wall those off from external automation, confirmed
repeatedly. A real Chrome **extension** runs *inside* Chrome's own trust
boundary with the real session already active, which is the only way to
close that gap without asking Heath to hand over credentials.

## Architecture

```
Cole (this session, WSL)          Heath's real Chrome (Windows)
  bridge-client.js                  extension/background.js  <--stdio-->  native-host/host.js
        |                                    ^  (armed tab only,               |
        v                                    |   read auto / write needs        v
  Supabase Storage bucket `browser-bridge` <--+   popup Approve click)   polls same bucket
  commands/<id>.json  {status, action, params, result}
```

- **Transport**: private Supabase Storage bucket `browser-bridge` (created
  2026-08-24, separate from `jarvis-bridge`'s bucket -- this is one-shot
  action requests, not conversational turns). Same proven shape as
  `scripts/jarvis-bridge/server.ts`: outbound HTTPS only, no exposed port,
  works through NAT/firewalls.
- **Extension** (`extension/`): Manifest V3. Background service worker talks
  to the native host over `chrome.runtime.connectNative`. A popup shows
  arm/disarm state and any actions waiting for approval.
- **Native messaging host** (`native-host/host.js` + `host.bat` wrapper):
  launched BY Chrome (standard Chrome behavior, not something Heath runs
  manually) the moment the extension connects. Polls the Storage bucket,
  relays commands to the extension over stdio, writes results back.
- **Command surface (MVP)**: `navigate {url}`, `snapshot {}` (visible text +
  interactive elements, like a Playwright accessibility snapshot),
  `screenshot {}`, `click {selector}`, `type {selector, text}`.

## Security model

- **Off by default.** The extension does nothing on any tab until Heath
  clicks its toolbar icon to arm the CURRENT tab. One armed tab at a time.
  Closing the armed tab auto-disarms.
- **Read/navigate auto-executes once armed**: `navigate`, `snapshot`,
  `screenshot`.
- **State-changing actions require a visible click, every time**: `click`
  and `type` queue in the extension popup and do NOT fire until Heath clicks
  "Approve" there. Verified live (see below) -- a real form field stayed
  empty until the popup Approve button was clicked, then filled. This
  mirrors the repo's standing draft-never-auto-send rule, applied to
  physical browser actions instead of client messages.
- **Host permissions trade-off (found by testing, documented in
  `background.js`)**: the extension declares `host_permissions` for
  `http(s)://*/*` rather than relying solely on `activeTab`. `activeTab`
  alone was tried first and broke immediately in verification -- its grant
  is invalidated the instant a tab navigates, so `navigate` followed by
  `snapshot`/`click`/`type` on the same armed tab failed with a permissions
  error, and there is no way for background.js to re-trigger the user
  gesture activeTab requires. Because this extension is loaded unpacked in
  developer mode (never published to the Web Store), the real security
  boundary is enforced by this extension's OWN code (the armedTabId check +
  the popup approval gate), not by which origins Chrome will technically let
  it script. Worth Heath knowing explicitly, not just buried in a comment.
- Extension ID is pinned via a fixed public "key" in `manifest.json`
  (`icbfnjkaoiplcfdmjjpdhbkfkimjklij`, standard Chrome mechanism for
  unpacked-extension ID stability -- not a secret) so the native host
  manifest's `allowed_origins` never needs updating across reloads/machines.

## Install (Heath, one time)

1. **Load the extension.**
   `chrome://extensions` -> enable "Developer mode" (top right) -> "Load
   unpacked" -> select
   `C:\Users\Heath\Projects\MeetDossie\scripts\browser-bridge\extension`.
2. **Register the native messaging host.**
   ```
   cd C:\Users\Heath\Projects\MeetDossie
   powershell -ExecutionPolicy Bypass -File scripts\browser-bridge\install-native-host.ps1
   ```
   This writes `%USERPROFILE%\.browser-bridge\com.shepardventures.browser_bridge.json`,
   registers it under `HKCU:\Software\Google\Chrome\NativeMessagingHosts\...`,
   and copies the two Supabase env values from jarvis-bridge's already-working
   config (via `\\wsl$\Ubuntu\...`) into `%USERPROFILE%\.browser-bridge\.env`
   -- no secrets to paste by hand unless that copy step warns it couldn't
   reach WSL.
3. **Reload the extension** (chrome://extensions -> reload icon on "Cole
   Browser Bridge") so it picks up the freshly-registered native host.
4. **Arm it.** Click the toolbar icon on the tab you want Cole to see/act in.
   The popup shows "Armed on: <page title>" and the native-host connection
   status.

That's it -- no restart of Claude Code / Jarvis needed on Cole's side.

## How Cole uses it

```
node scripts/browser-bridge/bridge-client.js snapshot '{}'
node scripts/browser-bridge/bridge-client.js navigate '{"url":"https://..."}'
node scripts/browser-bridge/bridge-client.js click '{"selector":"button.submit"}'
node scripts/browser-bridge/bridge-client.js type '{"selector":"input[name=q]","text":"hello"}'
node scripts/browser-bridge/bridge-client.js screenshot '{}'
```
Prints `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}` on stdout.
`click`/`type` block until Heath approves or rejects in the popup, or a 5
minute timeout expires.

## Uninstall / disarm

- Disarm any time: click the toolbar icon again, or just close the tab.
- Remove the extension: `chrome://extensions` -> Remove.
- Remove the native host registration:
  `Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shepardventures.browser_bridge' -Recurse`

## What's verified vs. what needs Heath's own test

See the build report for the full breakdown -- short version: the ENTIRE
pipeline (bridge-client -> Supabase -> native host -> extension -> real DOM
read/write, including the Approve-gate for state-changing actions) was
verified mechanically, end-to-end, against real public pages (example.com,
httpbin.org) using a real installed Chrome build and a real unpacked
extension load -- not just code review, not Playwright's own automation
pretending to be the extension.

**Update 2026-08-24 (Atlas, later same day):** `install-native-host.ps1` had
in fact already been run for real -- the registry key
`HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.shepardventures.browser_bridge`
exists on Heath's box, confirmed live. Two more things confirmed live in this
pass:
- `bridge-client.js` had a real bug: `process.env.SUPABASE_URL || envFromFile.SUPABASE_URL`
  let an ambient shell env var win even when its value was the literal string
  `"[SENSITIVE]"` (a Vercel `env pull` placeholder that had leaked into this
  session's environment) -- the file fallback never ran. Fixed: ambient vars
  equal to `[SENSITIVE]` are now treated as absent so `.env.local` is used
  instead of a poisoned placeholder erroring the whole client out.
- With that fixed, ran `snapshot` for real against Heath's already-armed tab
  and got back real interactive-element data from a live, logged-in-context
  `zillow.com` page (listing links, search box, nav) -- not example.com, the
  actual target this bridge exists for. The `navigate -> snapshot -> click/type`
  path against a real logged-in session is confirmed working end-to-end, not
  just plumbing to a public test page.

Still open: `status {}` is documented above and in the client's own header
comment but isn't implemented in `extension/background.js`'s action switch
(`snapshot`/`navigate`/`screenshot`/`click`/`type` only) -- calling it
returns `unknown action: status` from the real extension. Low priority since
`snapshot` already answers "is it armed and what's on screen," but the doc
oversells it as a working action today.
