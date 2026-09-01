#!/usr/bin/env node
// Unit + integration tests for the Microsoft Graph mail support added
// 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH):
//   - api/_lib/microsoft-oauth.js  (query translation, message normalisation,
//     token refresh, attachment decode, the makeMicrosoftClient() 401-retry)
//   - api/_lib/mail-client.js      (provider dispatcher)
//   - api/_lib/mail-provider-detect.js (checkout-time MX guard)
//
// All Supabase/Google/Microsoft network calls are mocked via a swapped-in
// global.fetch — no live credentials or network access required. Run with:
//   node scripts/carter-mail-oauth-dispatcher-test.js
//
// These tests do NOT exercise a real Azure app registration (that's the
// human-gated piece — see docs/ENV.md). They prove the code is correct
// GIVEN valid tokens/credentials, so the only thing left unverified once
// MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI are set in Vercel is Microsoft's
// own consent screen + token issuance, which only a live Azure app can prove.

'use strict';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.MICROSOFT_CLIENT_ID = 'fake-ms-client-id';
process.env.MICROSOFT_CLIENT_SECRET = 'fake-ms-client-secret';
process.env.GOOGLE_CLIENT_ID = 'fake-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

// --------------------------------------------------------------------------
// fetch mock harness — an ordered list of { match(url, init) => bool, respond(url, init) }
// --------------------------------------------------------------------------
const originalFetch = global.fetch;
let fetchLog = [];
let handlers = [];

function mockFetch(url, init = {}) {
  fetchLog.push({ url: String(url), init });
  for (const h of handlers) {
    if (h.match(String(url), init)) return Promise.resolve(h.respond(String(url), init));
  }
  throw new Error(`mockFetch: no handler matched ${url}`);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function resetMocks() {
  fetchLog = [];
  handlers = [];
  global.fetch = mockFetch;
}

const msOauth = require('../api/_lib/microsoft-oauth');
const { parseGmailStyleQuery, matchesFromNeedles, graphMessageToGmailShape } = msOauth._internal;
const { headerMap, parseFromHeader, bodyOfMessage } = require('../api/_lib/gmail-oauth');
const { makeMailClient } = require('../api/_lib/mail-client');
const { detectMailProvider } = require('../api/_lib/mail-provider-detect');

async function main() {
  // ========================================================================
  // query parsing (pure, no mocking needed)
  // ========================================================================
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const afterEpoch = nowSec - 900; // 15 min ago, matches cron-email-to-dossier.js's real usage
    const q1 = [`after:${afterEpoch}`, '-in:sent', '-in:drafts', '-in:spam', '-in:trash', '-in:chats'].join(' ');
    const parsed1 = parseGmailStyleQuery(q1);
    check('after: query -> correct sinceIso', parsed1.sinceIso === new Date(afterEpoch * 1000).toISOString(), parsed1);
    check('after: query -> no from needles', parsed1.fromNeedles.length === 0, parsed1);

    const q2 = '(from:authentisign.com OR from:lonewolf.com OR from:docusign.net) newer_than:3d';
    const parsed2 = parseGmailStyleQuery(q2);
    check('newer_than: query -> from needles extracted',
      JSON.stringify(parsed2.fromNeedles) === JSON.stringify(['authentisign.com', 'lonewolf.com', 'docusign.net']), parsed2.fromNeedles);
    const expectedCutoff = nowSec - 3 * 86400;
    const actualCutoffSec = Math.floor(new Date(parsed2.sinceIso).getTime() / 1000);
    check('newer_than:3d -> sinceIso ~3 days ago', Math.abs(actualCutoffSec - expectedCutoff) <= 2, { actualCutoffSec, expectedCutoff });

    const q3 = '(from:showingtime.com OR from:showingsuite.com) newer_than:3d';
    const parsed3 = parseGmailStyleQuery(q3);
    check('showingtime query -> both from needles', parsed3.fromNeedles.length === 2, parsed3.fromNeedles);

    check('matchesFromNeedles: substring match on domain', matchesFromNeedles('notify@mail.docusign.net', ['docusign.net']) === true);
    check('matchesFromNeedles: no match', matchesFromNeedles('someone@example.com', ['docusign.net']) === false);
    check('matchesFromNeedles: empty needles matches everything (after: query case)', matchesFromNeedles('anyone@example.com', []) === true);
  }

  // ========================================================================
  // Graph message -> Gmail-shape normalisation, round-tripped through the
  // SAME headerMap/parseFromHeader/bodyOfMessage the crons import.
  // ========================================================================
  {
    const graphMsg = {
      id: 'AAMk-graph-id-123',
      subject: 'Re: 104 Wild Cherry Ln — repair amendment',
      from: { emailAddress: { name: 'Jane Title Officer', address: 'jane@example-title.com' } },
      receivedDateTime: '2026-08-30T14:22:00Z',
      bodyPreview: 'Attached is the signed amendment...',
      body: { contentType: 'text', content: 'Attached is the signed amendment for your review.' },
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att-1', name: 'Amendment.pdf', contentType: 'application/pdf', size: 88123 },
      ],
    };

    const normalised = graphMessageToGmailShape(graphMsg);
    check('normalised has id', normalised.id === 'AAMk-graph-id-123');
    check('normalised has snippet from bodyPreview', normalised.snippet === graphMsg.bodyPreview);

    const hdr = headerMap(normalised.payload.headers);
    const { name, email } = parseFromHeader(hdr['from']);
    check('parseFromHeader recovers name from Graph from.emailAddress.name', name === 'Jane Title Officer', name);
    check('parseFromHeader recovers email from Graph from.emailAddress.address', email === 'jane@example-title.com', email);
    check('Date header round-trips through new Date()', !isNaN(new Date(hdr['date']).getTime()), hdr['date']);

    const body = bodyOfMessage(normalised);
    check('bodyOfMessage decodes the base64url-encoded plain text part', body === graphMsg.body.content, body);

    const attPart = normalised.payload.parts.find((p) => p.filename === 'Amendment.pdf');
    check('attachment part carries attachmentId for later download', !!attPart && attPart.body.attachmentId === 'att-1', attPart);
    check('attachment part carries mimeType', !!attPart && attPart.mimeType === 'application/pdf', attPart);
  }

  // ========================================================================
  // loadMicrosoftTokensForUser / persistAccessToken — provider-scoped
  // ========================================================================
  {
    resetMocks();
    handlers.push({
      match: (url) => url.includes('/rest/v1/user_integrations') && url.includes('oauth_provider=eq.microsoft_graph'),
      respond: () => jsonResponse(200, [{ access_token: 'at-1', refresh_token: 'rt-1', expires_at: '2026-09-01T00:00:00Z', microsoft_email: 'agent@brokerage.com' }]),
    });
    const tokens = await msOauth.loadMicrosoftTokensForUser('user-123');
    check('loadMicrosoftTokensForUser filters on oauth_provider=microsoft_graph', !!tokens && tokens.microsoft_email === 'agent@brokerage.com', tokens);
    check('loadMicrosoftTokensForUser query never mentions google_email', !fetchLog.some((f) => f.url.includes('google_email')));
  }

  // ========================================================================
  // refreshMicrosoftToken — success + invalid_grant
  // ========================================================================
  {
    resetMocks();
    handlers.push({
      match: (url) => url.includes('login.microsoftonline.com'),
      respond: () => jsonResponse(200, { access_token: 'new-at', refresh_token: 'rt-1', expires_in: 3600 }),
    });
    const refreshed = await msOauth.refreshMicrosoftToken('rt-1');
    check('refreshMicrosoftToken success returns access_token', refreshed.access_token === 'new-at', refreshed);

    resetMocks();
    handlers.push({
      match: (url) => url.includes('login.microsoftonline.com'),
      respond: () => jsonResponse(400, { error: 'invalid_grant', error_description: 'AADSTS700082: refresh token expired' }),
    });
    try {
      await msOauth.refreshMicrosoftToken('dead-rt');
      check('refreshMicrosoftToken throws on invalid_grant', false);
    } catch (err) {
      check('refreshMicrosoftToken throws on invalid_grant', true);
      check('refreshMicrosoftToken sets isInvalidGrant=true', err.isInvalidGrant === true, err.message);
    }
  }

  // ========================================================================
  // makeMicrosoftClient — list -> 401 triggers refresh -> retry succeeds
  // ========================================================================
  {
    resetMocks();
    const accessTokenSeen = [];
    let refreshCalls = 0;

    handlers.push({
      match: (url) => url.includes('graph.microsoft.com') && url.includes('/me/mailFolders/inbox/messages'),
      respond: (url, init) => {
        accessTokenSeen.push(init.headers.Authorization);
        if (init.headers.Authorization === 'Bearer stale-token') {
          return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
        }
        return jsonResponse(200, {
          value: [
            { id: 'm1', from: { emailAddress: { address: 'a@authentisign.com' } } },
            { id: 'm2', from: { emailAddress: { address: 'nobody@unrelated.com' } } },
          ],
        });
      },
    });
    handlers.push({
      match: (url) => url.includes('login.microsoftonline.com'),
      respond: () => { refreshCalls++; return jsonResponse(200, { access_token: 'fresh-token', refresh_token: 'rt-1', expires_in: 3600 }); },
    });
    handlers.push({
      match: (url) => url.includes('/rest/v1/user_integrations'),
      respond: () => jsonResponse(200, []),
    });

    const client = msOauth.makeMicrosoftClient({ userId: 'user-123', tokens: { access_token: 'stale-token', refresh_token: 'rt-1' } });
    const listResp = await client('messages', { q: '(from:authentisign.com) newer_than:3d', maxResults: '10' });
    check('makeMicrosoftClient auto-refreshes on 401', refreshCalls === 1, refreshCalls);
    check('makeMicrosoftClient retries with the new token', accessTokenSeen.includes('Bearer fresh-token'), accessTokenSeen);
    check('makeMicrosoftClient list filters by from: needle', listResp.messages.length === 1 && listResp.messages[0].id === 'm1', listResp);
  }

  // ========================================================================
  // attachment content: Graph's standard-base64 contentBytes re-encoded to
  // base64url, matching what downloadAttachment() in cron-esign-events.js
  // expects to Buffer.from(data, 'base64url').
  // ========================================================================
  {
    resetMocks();
    const rawBytes = Buffer.from('%PDF-1.4 fake pdf bytes >>?~');
    const standardBase64 = rawBytes.toString('base64');
    handlers.push({
      match: (url) => url.includes('/attachments/att-1'),
      respond: () => jsonResponse(200, { contentBytes: standardBase64, size: rawBytes.length }),
    });
    const client = msOauth.makeMicrosoftClient({ userId: 'user-123', tokens: { access_token: 'tok', refresh_token: 'rt' } });
    const att = await client('messages/m1/attachments/att-1');
    const decoded = Buffer.from(att.data, 'base64url');
    check('attachment bytes survive base64 -> base64url re-encode', decoded.equals(rawBytes), { got: decoded.toString(), want: rawBytes.toString() });
  }

  // ========================================================================
  // mail-client.js — provider dispatcher
  // ========================================================================
  {
    resetMocks();
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('google_email=not.is.null'),
      respond: () => jsonResponse(200, [{ access_token: 'g-at', refresh_token: 'g-rt', google_email: 'agent@gmail.com' }]),
    });
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('oauth_provider=eq.microsoft_graph'),
      respond: () => jsonResponse(200, []),
    });
    const mailGoogle = await makeMailClient({ userId: 'user-1' });
    check('dispatcher picks google when only Google connected', !!mailGoogle && mailGoogle.provider === 'google', mailGoogle);
    check('dispatcher surfaces the connected email (google)', !!mailGoogle && mailGoogle.email === 'agent@gmail.com', mailGoogle);

    resetMocks();
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('google_email=not.is.null'),
      respond: () => jsonResponse(200, []),
    });
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('oauth_provider=eq.microsoft_graph'),
      respond: () => jsonResponse(200, [{ access_token: 'm-at', refresh_token: 'm-rt', microsoft_email: 'agent@brokerage.com' }]),
    });
    const mailMs = await makeMailClient({ userId: 'user-2' });
    check('dispatcher picks microsoft when only Microsoft connected', !!mailMs && mailMs.provider === 'microsoft', mailMs);
    check('dispatcher surfaces the connected email (microsoft)', !!mailMs && mailMs.email === 'agent@brokerage.com', mailMs);

    resetMocks();
    handlers.push({ match: () => true, respond: () => jsonResponse(200, []) });
    const mailNone = await makeMailClient({ userId: 'user-3' });
    check('dispatcher returns null when nothing is connected', mailNone === null, mailNone);

    resetMocks();
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('google_email=not.is.null'),
      respond: () => jsonResponse(200, [{ access_token: 'g-at', refresh_token: 'g-rt', google_email: 'agent@gmail.com' }]),
    });
    handlers.push({
      match: (url) => url.includes('user_integrations') && url.includes('oauth_provider=eq.microsoft_graph'),
      respond: () => jsonResponse(200, [{ access_token: 'm-at', refresh_token: 'm-rt', microsoft_email: 'agent@brokerage.com' }]),
    });
    const mailBoth = await makeMailClient({ userId: 'user-4' });
    check('dispatcher tie-break: Google wins when both connected', !!mailBoth && mailBoth.provider === 'google', mailBoth);
  }

  // ========================================================================
  // mail-provider-detect.js — checkout-time MX guard
  // ========================================================================
  {
    const dns = require('node:dns');
    const originalResolveMx = dns.promises.resolveMx;
    dns.promises.resolveMx = async (domain) => {
      if (domain === 'kw.com') return [{ exchange: 'aspmx.l.google.com', priority: 1 }];
      if (domain === 'phyllisbrowning.com') return [{ exchange: 'phyllisbrowning-com.mail.protection.outlook.com', priority: 10 }];
      if (domain === 'somecustomdomain.example') return [{ exchange: 'mx1.somehost.example', priority: 10 }];
      if (domain === 'nodns.example') throw new Error('ENOTFOUND');
      return [];
    };

    const google = await detectMailProvider('heath@kw.com');
    check('detectMailProvider: kw.com MX -> google', google.provider === 'google', google);

    const microsoft = await detectMailProvider('tgill@phyllisbrowning.com');
    check('detectMailProvider: outlook MX -> microsoft', microsoft.provider === 'microsoft', microsoft);

    const unsupported = await detectMailProvider('someone@somecustomdomain.example');
    check('detectMailProvider: unrecognised MX -> unsupported', unsupported.provider === 'unsupported', unsupported);

    const failedLookup = await detectMailProvider('someone@nodns.example');
    check('detectMailProvider: DNS failure -> unknown (fail open)', failedLookup.provider === 'unknown', failedLookup);

    const noDomain = await detectMailProvider('not-an-email');
    check('detectMailProvider: malformed email -> unknown (fail open)', noDomain.provider === 'unknown', noDomain);

    dns.promises.resolveMx = originalResolveMx;
  }

  global.fetch = originalFetch;
  console.log(`\n${fail === 0 ? 'ALL MAIL-OAUTH DISPATCHER TESTS PASSED' : 'MAIL-OAUTH DISPATCHER TESTS FAILED'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exit(1);
});
