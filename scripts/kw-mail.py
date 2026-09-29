#!/usr/bin/env python3
"""
Read and send from Heath's KW mailbox (heath.shepard@kw.com) through the Gmail API.

Uses the OAuth refresh token stored in user_integrations by
api/google-oauth-callback.js. Refreshes the access token automatically, so this
keeps working without another consent click.

    python3 scripts/kw-mail.py profile
    python3 scripts/kw-mail.py search "in:sent to:heather" --limit 15
    python3 scripts/kw-mail.py read <messageId>
    python3 scripts/kw-mail.py voice --limit 40      # sent-mail sample for style
    python3 scripts/kw-mail.py send --to a@x.com,b@y.com --subject "Hi" \
        --body "text" --attach /path/one.pdf --attach /path/two.pdf
    python3 scripts/kw-mail.py send --to a@x.com --subject "Re: Hi" --body "text" \
        --reply-to <gmailMessageId>   # threads correctly: pulls In-Reply-To,
                                       # References, and threadId from that message

Needs SR_KEY (Supabase service role) in the environment. Client id/secret are
pulled from Vercel if GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET aren't already set.
Sending needs the gmail.compose OAuth scope on the stored token (already
granted as of 2026-08-05 — covers users.messages.send, not just drafts).
"""

import base64
import json
import mimetypes
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

SUPA = (os.environ.get('SUPABASE_URL') or 'https://pgwoitbdiyubjugwufhk.supabase.co').rstrip('/')
ACCOUNT = 'heath.shepard@kw.com'

# Row-pick filter shared by both reads below. The table is unique on
# (user_id, oauth_provider), NOT on google_email — a re-consent can leave
# multiple rows for this address, some dead. An unordered limit=1 used to grab
# whichever row came back first (live failure 2026-08-29: kept selecting a
# revoked row, every send died with invalid_grant). Require a refresh token
# and take the most recently updated row.
ROW_PICK = '&refresh_token=not.is.null&order=updated_at.desc&limit=1'

# In-process cache so a single CLI invocation that fires many Gmail calls
# (search -> per-message fetch, voice sampling, etc.) doesn't re-hit Supabase
# for the token on every call.
_state = {}


def sb(path, method=None, body=None):
    """Minimal Supabase REST helper — stdlib only, no requests dependency."""
    key = os.environ.get('SR_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        sys.exit('need SR_KEY (or SUPABASE_SERVICE_ROLE_KEY) in the environment')
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        SUPA + '/rest/v1/' + path,
        data=data,
        method=method,
        headers={
            'apikey': key,
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def access_token():
    """Return a (likely) valid access token, pulling refresh_token into the
    cache too so refresh() doesn't need a second Supabase round-trip."""
    if 'at' in _state:
        return _state['at']
    rows = sb(
        'user_integrations?select=access_token,refresh_token,expires_at&google_email=eq.'
        + urllib.parse.quote(ACCOUNT)
        + ROW_PICK
    )
    if not rows:
        sys.exit('no user_integrations row (with refresh token) for ' + ACCOUNT)
    row = rows[0]
    _state['at'] = row.get('access_token')
    _state['rt'] = row.get('refresh_token')
    return _state['at']


def refresh(_refresh_token=None):
    """Refresh via /api/gmail-refresh.

    GOOGLE_CLIENT_SECRET is a Sensitive var in Vercel, so it is write-only and
    unusable locally. The endpoint does the exchange server-side and writes the
    new token to user_integrations; we just read it back.
    """
    cron_secret = os.environ.get('CRON_SECRET')
    if not cron_secret:
        sys.exit('need CRON_SECRET (npx vercel env pull) to refresh the token')
    url = 'https://meetdossie.com/api/gmail-refresh?email=' + urllib.parse.quote(ACCOUNT)
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + cron_secret})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'ignore')
        sys.exit('refresh failed: ' + detail[:300])
    if not data.get('ok'):
        sys.exit('refresh failed: ' + json.dumps(data))
    rows = sb(
        'user_integrations?select=access_token&google_email=eq.'
        + urllib.parse.quote(ACCOUNT)
        + ROW_PICK
    )
    at = rows[0]['access_token']
    _state['at'] = at
    return at


def g(path, **params):
    """GET against the Gmail API, auto-refreshing once on a 401."""
    for attempt in (1, 2):
        at = access_token()
        url = 'https://gmail.googleapis.com/gmail/v1/users/me/' + path
        if params:
            url += '?' + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + at})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 1:
                refresh(_state.get('rt'))
                continue
            detail = e.read().decode('utf-8', 'ignore')
            sys.exit('gmail GET failed (' + str(e.code) + '): ' + detail[:300])


def g_post(path, body_bytes, content_type='application/json'):
    """POST against the Gmail API, auto-refreshing once on a 401."""
    for attempt in (1, 2):
        at = access_token()
        url = 'https://gmail.googleapis.com/gmail/v1/users/me/' + path
        req = urllib.request.Request(
            url,
            data=body_bytes,
            method='POST',
            headers={'Authorization': 'Bearer ' + at, 'Content-Type': content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 1:
                refresh(_state.get('rt'))
                continue
            detail = e.read().decode('utf-8', 'ignore')
            sys.exit('send failed: ' + detail[:300])


def headers_of(msg):
    out = {}
    for h in (msg.get('payload') or {}).get('headers') or []:
        out[h.get('name', '').lower()] = h.get('value', '')
    return out


def _b64url_decode(data):
    if not data:
        return ''
    data = data.replace('-', '+').replace('_', '/')
    data += '=' * (-len(data) % 4)
    try:
        return base64.b64decode(data).decode('utf-8', 'ignore')
    except Exception:
        return ''


def body_of(msg):
    """Walk the MIME tree for text/plain, falling back to stripped HTML."""
    plain, html = [], []

    def walk(p):
        if not p:
            return
        mime = p.get('mimeType', '')
        data = (p.get('body') or {}).get('data')
        if mime == 'text/plain' and data:
            plain.append(_b64url_decode(data))
        elif mime == 'text/html' and data:
            html.append(_b64url_decode(data))
        for sub in p.get('parts') or []:
            walk(sub)

    walk(msg.get('payload'))
    if plain:
        return '\n'.join(plain)
    if html:
        text = '\n'.join(html)
        text = re.sub('<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text
    return msg.get('snippet', '')


def cmd_profile():
    data = g('profile')
    print(
        data.get('emailAddress', '')
        + ' — '
        + str(data.get('messagesTotal'))
        + ' messages, '
        + str(data.get('threadsTotal'))
        + ' threads'
    )


def cmd_search(q, limit=20):
    data = g('messages', q=q, maxResults=limit)
    msgs = data.get('messages') or []
    print('query "' + q + '" -> ' + str(len(msgs)) + ' of ~' + str(data.get('resultSizeEstimate')))
    for m in msgs:
        detail = g(
            'messages/' + m['id'],
            format='metadata',
            metadataHeaders=['Subject', 'From', 'To', 'Date'],
        )
        h = headers_of(detail)
        print(m['id'] + '  ' + h.get('date', '')[:24])
        print('    from: ' + h.get('from', '')[:60])
        print('    to  : ' + h.get('to', '')[:60])
        print('    subj: ' + h.get('subject', '')[:70])
        print('    ' + (detail.get('snippet') or '')[:150])


def cmd_read(mid):
    msg = g('messages/' + mid, format='full')
    h = headers_of(msg)
    print('From: ' + h.get('from', ''))
    print('To: ' + h.get('to', ''))
    print('Date: ' + h.get('date', ''))
    print('Subject: ' + h.get('subject', ''))
    print('-' * 60)
    print(body_of(msg)[:15000])


def cmd_voice(limit=40):
    """Dump his own sent prose, quoted replies stripped, for style analysis."""
    data = g('messages', q='in:sent -in:chats', maxResults=limit)
    for m in data.get('messages') or []:
        msg = g('messages/' + m['id'], format='full')
        h = headers_of(msg)
        body = body_of(msg)
        body = re.split(r'\nOn .{5,80} wrote:|\n-{2,} ?Forwarded message|\n_{5,}', body)[0]
        body = re.sub(r'\n{3,}', '\n\n', body).strip()
        print('=== to ' + h.get('to', '')[:45] + ' | ' + h.get('subject', '')[:55] + ' ===')
        print(body[:900])
        print()


def resolve_reply_headers(reply_to_message_id):
    """Given a Gmail message id being replied to, return
    (in_reply_to, references, thread_id) so the new message threads
    correctly under it, per RFC 2822 (In-Reply-To + References chain)."""
    msg = km_get_for_reply(reply_to_message_id)
    thread_id = msg.get('threadId')
    h = headers_of(msg)
    msg_id = h.get('message-id', '')
    prior_refs = h.get('references', '')
    refs = (prior_refs + ' ' + msg_id).strip() if prior_refs else msg_id
    return msg_id, refs, thread_id


def km_get_for_reply(mid):
    return g(
        'messages/' + mid,
        format='metadata',
        metadataHeaders=['Message-ID', 'References', 'In-Reply-To', 'Subject'],
    )


def cmd_send(to, subject, body, attachments=None, cc=None, reply_to_message_id=None):
    msg = MIMEMultipart()
    msg['To'] = to
    msg['From'] = ACCOUNT
    if cc:
        msg['Cc'] = cc
    msg['Subject'] = subject

    thread_id = None
    if reply_to_message_id:
        in_reply_to, references, thread_id = resolve_reply_headers(reply_to_message_id)
        if in_reply_to:
            msg['In-Reply-To'] = in_reply_to
        if references:
            msg['References'] = references

    msg.attach(MIMEText(body, 'plain'))

    for path in attachments or []:
        ctype, _ = mimetypes.guess_type(path)
        maintype, subtype = (ctype or 'application/octet-stream').split('/', 1)
        with open(path, 'rb') as fh:
            part = MIMEBase(maintype, subtype)
            part.set_payload(fh.read())
        encoders.encode_base64(part)
        part.add_header('Content-Disposition', 'attachment', filename=os.path.basename(path))
        msg.attach(part)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode('ascii')
    payload = {'raw': raw}
    if thread_id:
        payload['threadId'] = thread_id
    result = g_post('messages/send', json.dumps(payload).encode(), 'application/json')
    print('sent: id=' + result.get('id', '') + ' threadId=' + result.get('threadId', ''))


def opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    cmd = argv[0]
    rest = argv[1:]

    if cmd == 'profile':
        cmd_profile()
    elif cmd == 'search':
        q = rest[0] if rest else ''
        limit = int(opt(rest, '--limit', 20))
        cmd_search(q, limit)
    elif cmd == 'read':
        if not rest:
            sys.exit('usage: kw-mail.py read <messageId>')
        cmd_read(rest[0])
    elif cmd == 'voice':
        limit = int(opt(rest, '--limit', 40))
        cmd_voice(limit)
    elif cmd == 'send':
        to = opt(rest, '--to')
        subject = opt(rest, '--subject', '')
        body = opt(rest, '--body')
        body_file = opt(rest, '--body-file')
        if body_file:
            with open(body_file, 'r', encoding='utf-8') as bf:
                body = bf.read()
        cc = opt(rest, '--cc')
        reply_to = opt(rest, '--reply-to')
        attach = []
        for i, a in enumerate(rest):
            if a == '--attach' and i + 1 < len(rest):
                attach.append(rest[i + 1])
        if not to or body is None:
            sys.exit('usage: kw-mail.py send --to a@x.com --subject "Hi" --body "text" [--attach f1 --attach f2] [--cc x@y.com] [--reply-to <messageId>]')
        cmd_send(to, subject, body, attach, cc, reply_to)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
