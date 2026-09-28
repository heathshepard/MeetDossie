#!/usr/bin/env python3
"""
Read and send from one of Heath's connected mailboxes.

PRIMARY path: IMAP (read) + SMTP (send) using a Google App Password.
FALLBACK path: the OAuth-refresh-token Gmail API path (unchanged from before).
App password missing/rejected -> automatic fallback to OAuth, with a one-line
notice on stderr saying so. Never fails closed when a working credential
exists. This removes the OAuth-refresh-token single point of failure that
broke Heath's email 3 times in 3 weeks (2026-09).

Defaults to heath.shepard@kw.com; pass --account to use a different
connected address (e.g. heath.shepard@gmail.com) explicitly — the mailbox
used is NEVER implicit/guessed. Each account needs its own app-password env
var (see APP_PASSWORD_ENV below); an account with no app password configured
falls straight to OAuth for that account.

    python3 scripts/kw-mail.py profile
    python3 scripts/kw-mail.py search "in:sent to:heather" --limit 15
    python3 scripts/kw-mail.py read <messageId>
    python3 scripts/kw-mail.py voice --limit 40      # sent-mail sample for style
    python3 scripts/kw-mail.py send --to a@x.com,b@y.com --subject "Hi" \
        --body "text" --attach /path/one.pdf --attach /path/two.pdf
    python3 scripts/kw-mail.py send --to a@x.com --subject "Re: Hi" --body "text" \
        --reply-to <messageId>   # threads correctly: pulls In-Reply-To,
                                   # References (and threadId on OAuth) from
                                   # the message being replied to

    # Any command against the gmail.com mailbox instead of kw.com:
    python3 scripts/kw-mail.py --account heath.shepard@gmail.com profile
    # or: MAIL_ACCOUNT=heath.shepard@gmail.com python3 scripts/kw-mail.py profile

Message IDs are consistent across BOTH paths: IMAP search/read print the same
hex id the Gmail API would (Gmail's IMAP X-GM-MSGID extension value, decimal,
converted to hex) — so a --reply-to id from a `search` run under one path
works if a later `send` falls back to the other.

App password env vars (per account, see APP_PASSWORD_ENV):
    KW_MAIL_APP_PASSWORD      heath.shepard@kw.com   (Google Workspace)
    GMAIL_APP_PASSWORD        heath.shepard@gmail.com

Every send (either path) is logged to scripts/logs/kw-mail-send-log.jsonl —
timestamp, account, transport, to/cc, subject. Never the body, never a
credential. That file is gitignored (see .gitignore: bare `logs` pattern).

OAuth fallback needs SR_KEY (Supabase service role) in the environment.
Client id/secret are pulled from Vercel if GOOGLE_CLIENT_ID /
GOOGLE_CLIENT_SECRET aren't already set. OAuth sending needs the
gmail.compose scope on the stored token (granted as of 2026-08-05).
"""

import base64
import imaplib
import json
import mimetypes
import os
import re
import smtplib
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from email import policy as email_policy
from email.parser import BytesParser
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env_local():
    """Load MeetDossie/.env.local into os.environ, without clobbering
    anything already exported by the caller's shell.

    This script used to only see vars a human had `export`ed by hand — a
    var written to .env.local (the one place every other credential in this
    repo lives) was invisible to it, so KW_MAIL_APP_PASSWORD silently fell
    back to OAuth on EVERY run even though the password was sitting right
    there in .env.local. preflight-check.js reads .env.local through its
    own loader and was papering over exactly this gap by injecting the
    value into kw-mail.py's subprocess env — which meant preflight and this
    script could (and did) disagree about which credential path was really
    configured. This loader makes the script self-sufficient so both
    resolve the same way.

    `utf-8-sig` strips a leading UTF-8 BOM automatically if present — a BOM
    in this file has silently corrupted the first key before (see
    MEMORY.md: env-local-bom-breaks-first-var). Values may be quoted,
    unquoted, or contain internal spaces (Google displays app passwords as
    4 space-separated groups); quotes are stripped here. Internal spaces
    are left intact — this is a generic .env parser, not a
    KW_MAIL_APP_PASSWORD special case. Callers that need a space-free
    credential strip it themselves (see app_password() below).
    """
    env_path = os.path.join(REPO_ROOT, '.env.local')
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, 'r', encoding='utf-8-sig', errors='replace') as f:
            raw = f.read()
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        if not k:
            continue
        # Real shell-exported env always wins over .env.local.
        os.environ.setdefault(k, v)


load_env_local()

SUPA = (os.environ.get('SUPABASE_URL') or 'https://pgwoitbdiyubjugwufhk.supabase.co').rstrip('/')

# Which mailbox this run talks to. Explicit, never guessed: defaults to KW,
# overridable via MAIL_ACCOUNT env var or --account <email> (main() below,
# extracted from argv before the module-level default below is ever read by
# a command). This is the ONLY place ACCOUNT is decided.
DEFAULT_ACCOUNT = 'heath.shepard@kw.com'
ACCOUNT = os.environ.get('MAIL_ACCOUNT') or DEFAULT_ACCOUNT

# Per-account app-password env var name. Adding a new mailbox = add one line
# here + set the env var; nothing else in this file changes. Never let the
# target mailbox be implicit: an account with no entry here always falls to
# OAuth rather than silently reusing another account's password.
APP_PASSWORD_ENV = {
    'heath.shepard@kw.com': 'KW_MAIL_APP_PASSWORD',
    'heath.shepard@gmail.com': 'GMAIL_APP_PASSWORD',
}

IMAP_HOST = 'imap.gmail.com'
IMAP_PORT = 993
SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 465

SEND_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs', 'kw-mail-send-log.jsonl')

# Row-pick filter shared by both reads below. The table is unique on
# (user_id, oauth_provider), NOT on google_email — a re-consent can leave
# multiple rows for this address, some dead. An unordered limit=1 used to grab
# whichever row came back first (live failure 2026-08-29: kept selecting a
# revoked row, every send died with invalid_grant). Require a refresh token
# and take the most recently updated row.
#
# This is only ever a "best guess at a cached token to try first" — it is
# NOT where the multi-row self-heal lives. If the row this picks turns out
# to be dead (401 -> refresh() below -> POST /api/gmail-refresh), the
# SERVER SIDE now walks EVERY row for this email newest->oldest and only
# gives up once all of them confirm invalid_grant (api/_lib/google-refresh-
# ladder.js, added 2026-09-28 after the newest-row-only version of this
# exact ROW_PICK pattern missed 2 chances to recover on 2026-09-28 — 3 rows
# existed, dated 9/12/9/19/9/26, and only the newest was ever tried). A
# successful server-side recovery bumps the winning row's updated_at and
# nulls refresh_token on confirmed-dead rows, so the NEXT time this exact
# ROW_PICK query runs it naturally lands on the row that actually works —
# no change needed here.
ROW_PICK = '&refresh_token=not.is.null&order=updated_at.desc&limit=1'

# In-process cache so a single CLI invocation that fires many Gmail calls
# (search -> per-message fetch, voice sampling, etc.) doesn't re-hit Supabase
# for the token on every call.
_state = {}


class MailAuthError(Exception):
    """App password missing/unreadable or rejected by Google. Callers catch
    this (and other connect/protocol errors) to trigger the OAuth fallback
    for read-only commands, or to fall back BEFORE anything is transmitted
    for send.

    `kind` distinguishes two very different failures so the fallback notice
    can be loud about the right one:
      'config'     — var not set / env.local unreadable. A wiring bug: the
                     password exists somewhere but this run can't see it.
                     Should be loud.
      'credential' — Google itself rejected the password. Not a wiring
                     issue — this run has the credential and it doesn't
                     work. Should be LOUDER — regenerate it.
    A plain connect/network error carries kind=None (unclassified)."""

    def __init__(self, message, kind=None):
        super().__init__(message)
        self.kind = kind


# ----------------------------------------------------------------- app pw --

def app_password():
    """Return (env_var_name, stripped_password_or_None) for ACCOUNT. Google
    displays app passwords with spaces for readability; strip ALL whitespace
    before use — Google accepts the password with or without spaces, but
    only if what's sent is consistent. Never print/log the value anywhere,
    including error messages."""
    var_name = APP_PASSWORD_ENV.get(ACCOUNT)
    if not var_name:
        return None, None
    val = os.environ.get(var_name)
    if not val:
        return var_name, None
    return var_name, re.sub(r'\s+', '', val)


def imap_connect():
    var_name, pw = app_password()
    if not pw:
        raise MailAuthError(
            (var_name + ' not set/unreadable') if var_name else ('no app-password env var mapped for ' + ACCOUNT),
            kind='config',
        )
    M = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=20)
    try:
        M.login(ACCOUNT, pw)
    except imaplib.IMAP4.error as e:
        raise MailAuthError(
            'IMAP login rejected for ' + ACCOUNT + ' via ' + var_name + ': ' + str(e),
            kind='credential',
        )
    return M


def fallback_notice(context, e):
    """Build the one-line stderr notice printed right before falling back
    to OAuth. Deliberately differentiated by severity so a config bug (the
    password exists but this run can't see it — quiet, easy to miss) never
    reads the same as Google actually rejecting the credential (loud —
    means the app password needs to be regenerated)."""
    kind = getattr(e, 'kind', None)
    if kind == 'config':
        label = 'CONFIG'
    elif kind == 'credential' or isinstance(e, smtplib.SMTPAuthenticationError):
        label = 'CREDENTIAL REJECTED BY GOOGLE'
    else:
        label = 'CONNECTION'
    return '[' + label + ': app-password ' + context + ' (' + str(e)[:180] + ') — falling back to OAuth]'


def _imap_quit(M):
    try:
        M.logout()
    except Exception:
        pass


def imap_select_all_mail(M, readonly=True):
    """Try Gmail's virtual All Mail folder first (matches the OAuth path's
    default un-scoped search across the whole mailbox); INBOX if that folder
    name isn't available under this account's label settings."""
    for name in ('"[Gmail]/All Mail"', 'INBOX'):
        typ, data = M.select(name, readonly=readonly)
        if typ == 'OK':
            return name, (int(data[0]) if data and data[0] else 0)
    raise RuntimeError('could not SELECT any mailbox folder')


# Gmail's IMAP X-GM-MSGID extension returns the SAME message identifier the
# Gmail API uses, just decimal instead of hex. Converting between the two
# means a message id from a `search`/`read` under either path (IMAP or
# OAuth) works as a --reply-to target under either path.
def gmail_id_to_msgid(gmail_id_hex):
    return int(gmail_id_hex, 16)


def msgid_to_gmail_id(msgid_int):
    return format(msgid_int, 'x')


_GM_MSGID_RE = re.compile(rb'X-GM-MSGID (\d+)')


def _extract_text(parsed):
    """Walk a parsed email.message.EmailMessage for text/plain, falling back
    to stripped HTML — same preference order as the OAuth body_of() below."""
    plain, html = [], []

    def collect(part):
        if part.get_content_disposition() == 'attachment':
            return
        ctype = part.get_content_type()
        if ctype not in ('text/plain', 'text/html'):
            return
        try:
            payload = part.get_content()
        except Exception:
            return
        if not isinstance(payload, str):
            return
        (plain if ctype == 'text/plain' else html).append(payload)

    if parsed.is_multipart():
        for part in parsed.walk():
            if not part.is_multipart():
                collect(part)
    else:
        collect(parsed)

    if plain:
        return '\n'.join(plain)
    if html:
        text = '\n'.join(html)
        text = re.sub('<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text
    return ''


def cmd_profile_imap():
    M = imap_connect()
    try:
        label, total = imap_select_all_mail(M)
        print(ACCOUNT + ' — ' + str(total) + ' messages in ' + label + '  (IMAP app-password)')
    finally:
        _imap_quit(M)


def cmd_search_imap(q, limit=20):
    M = imap_connect()
    try:
        label, _ = imap_select_all_mail(M)
        safe_q = q.replace('\\', '\\\\').replace('"', '\\"')
        typ, data = M.uid('search', None, 'X-GM-RAW', '"' + safe_q + '"')
        if typ != 'OK':
            raise RuntimeError('IMAP X-GM-RAW search failed: ' + str(data))
        all_uids = data[0].split() if data and data[0] else []
        uids = list(reversed(all_uids))[: limit or len(all_uids)]
        print('query "' + q + '" -> ' + str(len(uids)) + ' of ' + str(len(all_uids)) + '  (IMAP app-password, ' + label + ')')
        for uid in uids:
            typ, msgdata = M.uid(
                'fetch', uid, '(X-GM-MSGID BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE)])'
            )
            raw_headers = b''
            gm_msgid = None
            for part in msgdata or []:
                if isinstance(part, tuple):
                    raw_headers += part[1] or b''
                    m = _GM_MSGID_RE.search(part[0] or b'')
                    if m:
                        gm_msgid = m.group(1)
                elif isinstance(part, (bytes, bytearray)):
                    m = _GM_MSGID_RE.search(part)
                    if m:
                        gm_msgid = m.group(1)
            parsed = BytesParser(policy=email_policy.default).parsebytes(raw_headers)
            gid = msgid_to_gmail_id(int(gm_msgid)) if gm_msgid else '?'
            print(gid + '  ' + str(parsed.get('Date', ''))[:24])
            print('    from: ' + str(parsed.get('From', ''))[:60])
            print('    to  : ' + str(parsed.get('To', ''))[:60])
            print('    subj: ' + str(parsed.get('Subject', ''))[:70])
    finally:
        _imap_quit(M)


def _fetch_full_message(M, uid):
    typ, msgdata = M.uid('fetch', uid, '(BODY.PEEK[])')
    if typ != 'OK':
        raise RuntimeError('IMAP FETCH failed for uid ' + (uid.decode() if isinstance(uid, bytes) else str(uid)))
    raw = b''
    for part in msgdata or []:
        if isinstance(part, tuple):
            raw += part[1] or b''
    return BytesParser(policy=email_policy.default).parsebytes(raw)


def cmd_read_imap(mid):
    M = imap_connect()
    try:
        label, _ = imap_select_all_mail(M)
        msgid_int = gmail_id_to_msgid(mid)
        typ, data = M.uid('search', None, 'X-GM-MSGID', str(msgid_int))
        if typ != 'OK' or not data or not data[0]:
            raise RuntimeError('message ' + mid + ' not found via IMAP (' + label + ')')
        uid = data[0].split()[0]
        parsed = _fetch_full_message(M, uid)
        print('From: ' + str(parsed.get('From', '')))
        print('To: ' + str(parsed.get('To', '')))
        print('Date: ' + str(parsed.get('Date', '')))
        print('Subject: ' + str(parsed.get('Subject', '')))
        print('-' * 60)
        print(_extract_text(parsed)[:15000])
    finally:
        _imap_quit(M)


def cmd_voice_imap(limit=40):
    """Dump his own sent prose, quoted replies stripped, for style analysis."""
    M = imap_connect()
    try:
        imap_select_all_mail(M)
        typ, data = M.uid('search', None, 'X-GM-RAW', '"in:sent -in:chats"')
        if typ != 'OK':
            raise RuntimeError('IMAP X-GM-RAW search failed: ' + str(data))
        all_uids = data[0].split() if data and data[0] else []
        uids = list(reversed(all_uids))[: limit or len(all_uids)]
        for uid in uids:
            parsed = _fetch_full_message(M, uid)
            body = _extract_text(parsed)
            body = re.split(r'\nOn .{5,80} wrote:|\n-{2,} ?Forwarded message|\n_{5,}', body)[0]
            body = re.sub(r'\n{3,}', '\n\n', body).strip()
            print('=== to ' + str(parsed.get('To', ''))[:45] + ' | ' + str(parsed.get('Subject', ''))[:55] + ' ===')
            print(body[:900])
            print()
    finally:
        _imap_quit(M)


def resolve_reply_headers_imap(reply_to_message_id):
    """IMAP equivalent of resolve_reply_headers() below: looks the target
    message up via X-GM-MSGID and returns (Message-ID, References) so the
    new message threads correctly, per RFC 2822."""
    M = imap_connect()
    try:
        label, _ = imap_select_all_mail(M)
        msgid_int = gmail_id_to_msgid(reply_to_message_id)
        typ, data = M.uid('search', None, 'X-GM-MSGID', str(msgid_int))
        if typ != 'OK' or not data or not data[0]:
            raise RuntimeError('reply-to message ' + reply_to_message_id + ' not found via IMAP (' + label + ')')
        uid = data[0].split()[0]
        typ, msgdata = M.uid('fetch', uid, '(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES)])')
        raw = b''
        for part in msgdata or []:
            if isinstance(part, tuple):
                raw += part[1] or b''
        parsed = BytesParser(policy=email_policy.default).parsebytes(raw)
        msg_id = str(parsed.get('Message-ID', '') or '')
        prior_refs = str(parsed.get('References', '') or '')
        refs = (prior_refs + ' ' + msg_id).strip() if prior_refs else msg_id
        return msg_id, refs
    finally:
        _imap_quit(M)


# ------------------------------------------------------------- shared MIME --

def build_email_message(to, subject, body, attachments=None, cc=None, in_reply_to=None, references=None):
    """Used by BOTH the SMTP and the OAuth send paths so attachment/threading
    handling is identical regardless of transport."""
    msg = MIMEMultipart()
    msg['To'] = to
    msg['From'] = ACCOUNT
    if cc:
        msg['Cc'] = cc
    msg['Subject'] = subject
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

    return msg


def log_send(transport, to, cc, subject):
    """Append-only audit line: who/what/when. NEVER the body, NEVER a
    credential. Failure to write the log never blocks or unwinds a send that
    already happened — it's an audit trail, not a gate."""
    try:
        os.makedirs(os.path.dirname(SEND_LOG_PATH), exist_ok=True)
        entry = {
            'ts': datetime.now(timezone.utc).isoformat(),
            'account': ACCOUNT,
            'transport': transport,
            'to': to,
            'cc': cc or '',
            'subject': subject,
        }
        with open(SEND_LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
    except Exception as e:
        print('[warn: send succeeded but audit log write failed: ' + str(e)[:150] + ']', file=sys.stderr)


# --------------------------------------------------------------- SMTP send --

def cmd_send_smtp(to, subject, body, attachments=None, cc=None, reply_to_message_id=None):
    """Primary send path. Falls back to OAuth ONLY for failures before
    anything is transmitted (missing/rejected app password, can't connect,
    can't resolve reply headers). Once smtp.sendmail() is actually called,
    any failure is reported as-is and NEVER silently retried on the OAuth
    path — an ambiguous send must never become a double-send."""
    var_name, pw = app_password()
    if not pw:
        missing = MailAuthError(
            (var_name + ' not set/unreadable') if var_name else ('no mapping for ' + ACCOUNT),
            kind='config',
        )
        print(fallback_notice('unavailable', missing)[:-1] + ', nothing was sent]', file=sys.stderr)
        return cmd_send_oauth(to, subject, body, attachments, cc, reply_to_message_id)

    try:
        in_reply_to = references = None
        if reply_to_message_id:
            in_reply_to, references = resolve_reply_headers_imap(reply_to_message_id)
        msg = build_email_message(to, subject, body, attachments, cc, in_reply_to, references)
        server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20)
        server.login(ACCOUNT, pw)
    except Exception as e:
        print(fallback_notice('SMTP prep/auth failed', e)[:-1] + ', nothing was sent]', file=sys.stderr)
        return cmd_send_oauth(to, subject, body, attachments, cc, reply_to_message_id)

    try:
        recipients = [a.strip() for a in to.split(',') if a.strip()]
        if cc:
            recipients += [a.strip() for a in cc.split(',') if a.strip()]
        server.sendmail(ACCOUNT, recipients, msg.as_bytes())
        server.quit()
    except Exception as e:
        sys.exit(
            'SMTP send failed AFTER authenticating — may have partially transmitted, NOT retrying '
            'automatically (never retry an unverified send). Check the mailbox Sent folder before '
            're-attempting. Error: ' + str(e)[:300]
        )

    log_send('smtp-app-password', to, cc, subject)
    print('sent via SMTP app-password: to=' + to + (' cc=' + cc if cc else '') + '  subject="' + subject + '"')


# ------------------------------------------------------- OAuth (fallback) --

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


def cmd_profile_oauth():
    data = g('profile')
    print(
        data.get('emailAddress', '')
        + ' — '
        + str(data.get('messagesTotal'))
        + ' messages, '
        + str(data.get('threadsTotal'))
        + ' threads  (OAuth Gmail API)'
    )


def cmd_search_oauth(q, limit=20):
    data = g('messages', q=q, maxResults=limit)
    msgs = data.get('messages') or []
    print('query "' + q + '" -> ' + str(len(msgs)) + ' of ~' + str(data.get('resultSizeEstimate')) + '  (OAuth Gmail API)')
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


def cmd_read_oauth(mid):
    msg = g('messages/' + mid, format='full')
    h = headers_of(msg)
    print('From: ' + h.get('from', ''))
    print('To: ' + h.get('to', ''))
    print('Date: ' + h.get('date', ''))
    print('Subject: ' + h.get('subject', ''))
    print('-' * 60)
    print(body_of(msg)[:15000])


def cmd_voice_oauth(limit=40):
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


def cmd_send_oauth(to, subject, body, attachments=None, cc=None, reply_to_message_id=None):
    thread_id = None
    in_reply_to = references = None
    if reply_to_message_id:
        in_reply_to, references, thread_id = resolve_reply_headers(reply_to_message_id)

    msg = build_email_message(to, subject, body, attachments, cc, in_reply_to, references)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode('ascii')
    payload = {'raw': raw}
    if thread_id:
        payload['threadId'] = thread_id
    result = g_post('messages/send', json.dumps(payload).encode(), 'application/json')
    log_send('oauth-gmail-api', to, cc, subject)
    print('sent via OAuth Gmail API: id=' + result.get('id', '') + ' threadId=' + result.get('threadId', ''))


# --------------------------------------------------- top-level dispatchers --
# These are what main() calls. Read commands fall back to OAuth on ANY
# app-password failure (safe — reads have no side effects). cmd_send has its
# own fallback logic above cmd_send_smtp, tighter for the reasons documented
# there.

def cmd_profile():
    try:
        return cmd_profile_imap()
    except Exception as e:
        print(fallback_notice('IMAP failed', e), file=sys.stderr)
        return cmd_profile_oauth()


def cmd_search(q, limit=20):
    try:
        return cmd_search_imap(q, limit)
    except Exception as e:
        print(fallback_notice('IMAP failed', e), file=sys.stderr)
        return cmd_search_oauth(q, limit)


def cmd_read(mid):
    try:
        return cmd_read_imap(mid)
    except Exception as e:
        print(fallback_notice('IMAP failed', e), file=sys.stderr)
        return cmd_read_oauth(mid)


def cmd_voice(limit=40):
    try:
        return cmd_voice_imap(limit)
    except Exception as e:
        print(fallback_notice('IMAP failed', e), file=sys.stderr)
        return cmd_voice_oauth(limit)


def cmd_send(to, subject, body, attachments=None, cc=None, reply_to_message_id=None):
    return cmd_send_smtp(to, subject, body, attachments, cc, reply_to_message_id)


# --------------------------------------------------------------------- cli --

def opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def extract_account(argv):
    """Pull a leading/anywhere `--account <email>` out of argv, explicit and
    required-if-present (never a guess). Returns (remaining_argv, email_or_None)."""
    if '--account' not in argv:
        return argv, None
    i = argv.index('--account')
    if i + 1 >= len(argv):
        sys.exit('usage: --account requires a value, e.g. --account heath.shepard@gmail.com')
    value = argv[i + 1]
    remaining = argv[:i] + argv[i + 2:]
    return remaining, value


def main():
    global ACCOUNT
    argv, account_override = extract_account(sys.argv[1:])
    if account_override:
        ACCOUNT = account_override
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
