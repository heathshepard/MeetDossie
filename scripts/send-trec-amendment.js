#!/usr/bin/env node
/**
 * send-trec-amendment.js — fill a blank TREC form, render it for eyes-on review, and
 * (optionally) send it for signature through DocuSeal.
 *
 * This is the FAST PATH. See memory `esign-fast-path-docuseal.md`. zipForm UI driving is the
 * exception, not the default — it costs ~1hr per document and has four separate failure modes.
 *
 * Usage:
 *   node scripts/send-trec-amendment.js --spec .tmp/<deal>/spec.json            # fill + render only
 *   node scripts/send-trec-amendment.js --spec .tmp/<deal>/spec.json --send     # also SENDS
 *
 * Spec file:
 * {
 *   "form": "scripts/_assets/trec-forms/TREC-39-11-blank.pdf",
 *   "out":  ".tmp/ridgebluff-extension/Amendment-507-RidgeBlf.pdf",
 *   "fields": { "Street Address and City": "507 Ridge Blf    San Antonio", "date 5": "October 9" },
 *   "checks": ["3 The date in Paragraph 9 of the contract is changed to"],
 *   "signers": [
 *     { "role": "Buyer 1", "name": "Nadia Kapoor",   "email": "nkapoor@mail.example",   "sig": [36,168,260,32] },
 *     { "role": "Buyer 2", "name": "Rohan Desai", "email": "rohandesai@mail.example", "sig": [35,125,262,32] }
 *   ],
 *   "subject": "507 Ridge Blf - Amendment",
 *   "body": "Hey Nadia and Rohan,\n\n...\n\nPlease sign here: {{submitter.link}}\n\nThanks,\nHeath",
 *
 *   // Optional, both for the Dossie write-back only — neither affects the send.
 *   "transaction_id": "<dossier uuid>",   // REQUIRED for the signed PDF + completion
 *                                         // certificate to be stored on completion:
 *                                         // documents.transaction_id is NOT NULL.
 *                                         // Without it you still get envelope tracking.
 *   "user_id": "<auth.users uuid>"        // defaults to heath.shepard@kw.com's profile
 * }
 *
 * `sig` is [x, y, w, h] in PDF points, y from the BOTTOM of the page (what pdf-lib reports for
 * the form's own signature widgets — see --map).
 *
 *   node scripts/send-trec-amendment.js --map <form.pdf>   # dump every field name + rectangle
 *
 * ALWAYS look at the rendered PNG before sending. TREC AcroForm field names lie — on 39-11 the
 * checkbox names are shifted by one from item (5) down. Map by rectangle (y descending = top of
 * page to bottom), then confirm visually.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');

function loadEnv() {
  const f = path.join(REPO, '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function dumpMap(formPath) {
  const doc = await PDFDocument.load(fs.readFileSync(formPath));
  const rows = [];
  for (const field of doc.getForm().getFields()) {
    for (const w of field.acroField.getWidgets()) {
      const r = w.getRectangle();
      rows.push({
        name: field.getName(),
        type: field.constructor.name.replace('PDF', ''),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
  }
  // y descending reads top of page to bottom — that is how you identify which item a box is.
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) console.log(`y=${String(r.y).padStart(3)} x=${String(r.x).padStart(3)} ${r.type.padEnd(9)} ${r.name}`);
}

async function fill(spec) {
  const doc = await PDFDocument.load(fs.readFileSync(path.resolve(REPO, spec.form)));
  const form = doc.getForm();
  for (const [name, value] of Object.entries(spec.fields || {})) form.getTextField(name).setText(String(value));
  for (const name of spec.checks || []) form.getCheckBox(name).check();
  form.flatten();
  const out = path.resolve(REPO, spec.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await doc.save());
  return out;
}

function render(pdfPath) {
  const prefix = pdfPath.replace(/\.pdf$/i, '-page');
  execFileSync('pdftoppm', ['-r', '110', '-png', pdfPath, prefix]);
  return fs.readdirSync(path.dirname(prefix))
    .filter((f) => f.startsWith(path.basename(prefix)))
    .map((f) => path.join(path.dirname(prefix), f))
    .sort();
}

async function docuseal(spec, pdfPath) {
  loadEnv();
  const key = process.env.DOCUSEAL_API_KEY;
  if (!key) throw new Error('DOCUSEAL_API_KEY missing from .env.local');
  const H = { 'X-Auth-Token': key, 'Content-Type': 'application/json' };
  // DocuSeal wants a top-origin fraction; the form's own widgets are bottom-origin.
  const area = ([x, y, w, h]) => ({
    x: +(x / 612).toFixed(6), y: +((792 - (y + h)) / 792).toFixed(6),
    w: +(w / 612).toFixed(6), h: +(h / 792).toFixed(6), page: 1,
  });
  const name = spec.subject || path.basename(pdfPath, '.pdf');

  const tRes = await fetch('https://api.docuseal.com/templates/pdf', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name,
      documents: [{
        name,
        file: fs.readFileSync(pdfPath).toString('base64'),
        fields: spec.signers.map((s) => ({
          name: `${s.role} Signature`, type: 'signature', role: s.role, required: true, areas: [area(s.sig)],
        })),
      }],
      submitters: spec.signers.map((s) => ({ name: s.role })),
    }),
  });
  const template = await tRes.json();
  if (!template.id) throw new Error(`template failed ${tRes.status}: ${JSON.stringify(template)}`);
  console.log(`template ${template.id}`);

  const sRes = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      template_id: template.id, send_email: true, order: 'random',
      message: { subject: spec.subject, body: spec.body },
      submitters: spec.signers.map((s) => ({ role: s.role, name: s.name, email: s.email })),
    }),
  });
  const sent = await sRes.json();
  const submitters = Array.isArray(sent) ? sent : sent.submitters || [];
  if (!submitters.length) throw new Error(`send failed ${sRes.status}: ${JSON.stringify(sent)}`);
  const submissionId = submitters[0].submission_id;

  // Never report "sent" off the POST response alone — read it back.
  const vRes = await fetch(`https://api.docuseal.com/submissions/${submissionId}`, { headers: { 'X-Auth-Token': key } });
  const v = await vRes.json();
  console.log(`submission ${submissionId} ${v.status}`);
  for (const s of v.submitters || []) console.log(`  ${s.name} <${s.email}> ${s.status} sent ${s.sent_at}`);

  // ── Dossie write-back (C1) ────────────────────────────────────────────────
  // STRICTLY SECONDARY TO THE SEND. Everything above this comment is the send
  // and its verification, unchanged. Everything below is bookkeeping: it runs
  // only after the submission has been created AND read back, it cannot alter
  // what was sent, and it is wrapped so that ANY failure — Supabase down,
  // schema drift, missing credential — is caught, printed as a warning, and
  // leaves the send reported exactly as it was before. The function still
  // returns submissionId on every path.
  //
  // Why it matters: api/esign-webhook.js keys on docuseal_submission_id. With
  // no row, a real completion arrives, matches nothing, and is dropped — which
  // is why 35 completed submissions produced zero signed PDFs, zero
  // certificates and zero audit trails in the product. With a row, the same
  // webhook stores the signed PDFs, DocuSeal's completion certificate, sha256
  // hashes and the event timeline.
  //
  // The row is flagged suppress_notifications: DocuSeal has already emailed
  // these signers (send_email: true above), so Dossie must not email them a
  // second time. See the migration for the full reasoning.
  try {
    const { recordSend } = require('./_lib/signature-request-writeback.js');
    const rec = await recordSend({
      submissionId,
      templateId: template.id,
      submitters: v.submitters || [],
      documentName: name,
      status: v.status || 'sent',
      sentPdfPath: pdfPath,
      userId: spec.user_id || null,
      transactionId: spec.transaction_id || null,
    });
    if (rec.ok && rec.skipped) console.log(`dossie   already tracked (${rec.id})`);
    else if (rec.ok) console.log(`dossie   tracked ${rec.id}${rec.warning ? ` (${rec.warning})` : ''}`);
    else console.warn(`dossie   NOT tracked — ${rec.reason}: ${rec.detail || ''}`.trim());
  } catch (err) {
    // Unreachable in practice (recordSend never throws), but the send is not
    // allowed to depend on that being true.
    console.warn(`dossie   NOT tracked — write-back threw: ${err && err.message}`);
  }

  return submissionId;
}

(async () => {
  const args = process.argv.slice(2);
  const mapIdx = args.indexOf('--map');
  if (mapIdx !== -1) return dumpMap(path.resolve(REPO, args[mapIdx + 1]));

  const specIdx = args.indexOf('--spec');
  if (specIdx === -1) {
    console.error('usage: send-trec-amendment.js --spec <spec.json> [--send]   |   --map <form.pdf>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(REPO, args[specIdx + 1]), 'utf8'));

  const pdfPath = await fill(spec);
  console.log(`filled  ${pdfPath}`);
  for (const png of render(pdfPath)) console.log(`render  ${png}`);

  if (!args.includes('--send')) {
    console.log('\nNot sent. Look at the render above, then re-run with --send.');
    return;
  }
  await docuseal(spec, pdfPath);
})().catch((err) => { console.error(err.message); process.exit(1); });
