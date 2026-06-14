# Quinn -> Carter: Talk to Dossie 401 — CRITICAL FIX

**Severity:** CRITICAL — Heath's "Dossie isn't reliable" pain. Every voice command from the home view fails silently/uglily.

## Bug

On both `meetdossie.com/app` and `meetdossie.com/workspace`, typing any command into the Talk to Dossie composer and pressing Send (or pressing the Send button) results in:

```
POST /api/chat 401
{"ok":false,"error":"Missing or malformed Authorization header."}
```

The error surfaces to the user as: **"Couldn't act on that — Something went sideways — Missing or malformed Authorization header."**

That last sentence is a raw API error string leaking to the end user. Reads like a 1995 stack-trace; reads to Brittney like "this product is broken."

## Root cause (found in bundle)

`assets/workspace-Cf4tXxlZ.js` line ~146 minified — the Talk-to-Dossie composer's send handler does:

```js
const I = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },   // <-- NO Authorization
  body: JSON.stringify({
    mode: "action",
    message: m,
    messages: C,
    userId: q.id,                                     // sends userId in body
    deals: b,
  }),
});
```

But `api/chat.js` line 740 calls `verifySupabaseToken(req)` which reads the
Authorization header. The frontend passes `userId` in the body — that's
ignored. JWT must be in the header.

This is the same `supabase.auth.getSession()` pattern that's used elsewhere in
the bundle for Supabase REST calls (Authorization is added there). Whoever
wrote the Talk-to-Dossie composer forgot to copy that pattern.

## Fix

In `Dossie` repo (the React source), find the Talk-to-Dossie composer's
send handler. Change:

```js
const res = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, userId: user.id }),
});
```

to:

```js
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session?.access_token || ''}`,
  },
  body: JSON.stringify(payload),  // userId comes from JWT server-side
});
```

Apply the **same fix** to every other Talk-to-Dossie fetch (there are 4
references in the bundle — they're all the same component re-emit, but
verify in source there isn't a second composer in another file).

Also audit:
- `/api/speak` — currently 500-ing on the home view; user-facing UI silently
  swallows it with "[Jessica] audio failed, continuing loop silently". Add
  Authorization to that fetch too if it's there.
- `/api/leads` — 401 in console; may or may not need fixing depending on
  whether it's user-scoped.
- `/api/extract-form-fields` and `/api/fill-form` — same pattern; verify
  they also pass the JWT.
- `/api/voice/tts` — verify auth pattern.

## How to verify

After deploy to staging, run on Sarah Whitley's demo account:

```bash
# Log in to /app
# Type "What deadlines do I have today?" into Talk to Dossie
# Press Send
# Expect: 200 response, action=get_deals or answer_question, message shown in chat panel
# Network tab should show Authorization: Bearer ey... on /api/chat
```

If 200 — closed. If still 401, there's a second composer.

## Other UX cleanup (do at same time)

Even with the JWT fix, the error display strategy needs work:
- "Something went sideways — Missing or malformed Authorization header" reads bad
- Instead: "Lost my connection — could you try that again?"
- For 429 rate-limit errors: "I'm catching my breath — try again in a minute"
- For server errors: "Hit a snag on my end. Try again in a moment, or text Heath if it keeps happening."

Never surface raw API error strings to the user.

## Why this matters

This is THE bug. Heath said at 12:33 AM "Talk to Dossie isn't reliable enough
to trust." It isn't — because she's been answering NOTHING for an unknown
window of time. Every voice command from the home view = silent failure
with an ugly error message. This is the #1 belief-killer.

Fix this one and Heath's trust starts coming back. Everything else Quinn
finds is downstream noise compared to this.
