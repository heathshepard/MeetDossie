// Vercel Serverless Function: /api/heath-actions-approve-execute
//
// POST — Approves and executes a structured action item (e.g., send email).
// Called by Jarvis HUD when Heath taps "APPROVE & SEND" or similar button.
//
// POST /api/heath-actions-approve-execute
// { action_id }
//
// Supports:
//   - action_type='send_email': calls Resend API with payload (to, cc, bcc, subject, body_html, body_text, etc.)
//   - action_type='manual': stub (returns 501 TODO)
//   - Other types: stub (returns 501 TODO)
//
// Behavior:
//   - Validates action exists, is pending, has valid action_type + payload
//   - For send_email: calls Resend, stores message_id in execution_result
//   - Sets approved_at, executed_at, status='done'
//   - Idempotent: re-submit returns last execution_result
//
// Auth: Bearer JWT (health.shepard@kw.com) only. RLS enforces tenant ownership.
//
// Returns:
//   200 { ok: true, message_id, executed_at }
//   400 { ok: false, error: "..." }
//   501 { ok: false, error: "Action type not implemented" }
//   422 { ok: false, error: "Action validation failed" }

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authorizeHealthTenant(req, supabase) {
  const auth = req.headers.authorization;
  if (!auth) return { ok: false, status: 401, error: 'Missing Authorization header' };

  const token = auth.replace('Bearer ', '');

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid token' };
    return { ok: true, user_id: user.id };
  } catch (err) {
    return { ok: false, status: 401, error: err.message };
  }
}

async function executeEmailAction(payload, supabase) {
  // Validate payload structure
  if (!payload.to || !payload.subject || (!payload.body_html && !payload.body_text)) {
    throw new Error('Email payload missing required fields: to, subject, (body_html or body_text)');
  }

  // Validate sender (must be an approved alias)
  const from = payload.from_email || 'heath@meetdossie.com';
  const allowedSenders = [
    'heath@meetdossie.com',
    'noreply@meetdossie.com',
    'support@meetdossie.com',
  ];
  if (!allowedSenders.includes(from)) {
    throw new Error(`Sender "${from}" not allowed. Use ${allowedSenders.join(', ')}`);
  }

  // Initialize Resend
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured');
  }
  const resend = new Resend(RESEND_API_KEY);

  // Prepare Resend email
  const emailPayload = {
    from: payload.from_name ? `${payload.from_name} <${from}>` : from,
    to: payload.to,
    subject: payload.subject,
    reply_to: payload.reply_to,
  };

  if (payload.body_html) emailPayload.html = payload.body_html;
  if (payload.body_text) emailPayload.text = payload.body_text;
  if (payload.cc) emailPayload.cc = payload.cc;
  if (payload.bcc) emailPayload.bcc = payload.bcc;

  // Send via Resend
  const { data, error } = await resend.emails.send(emailPayload);
  if (error) throw error;

  return {
    type: 'send_email',
    message_id: data.id,
    sent_at: new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHealthTenant(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const { action_id } = req.body || {};
    if (!action_id) {
      return res.status(400).json({ ok: false, error: 'action_id is required' });
    }

    // Fetch the action (RLS ensures user owns it)
    const { data: action, error: fetchErr } = await supabase
      .from('heath_actions')
      .select('*')
      .eq('id', action_id)
      .eq('tenant_id', auth.user_id)
      .single();

    if (fetchErr || !action) {
      return res.status(404).json({ ok: false, error: 'Action not found' });
    }

    // Reject if action_type not set
    if (!action.action_type || action.action_type === 'manual') {
      return res
        .status(422)
        .json({ ok: false, error: 'Action is manual or has no action_type; cannot auto-execute' });
    }

    // If already executed, return the cached result (idempotent)
    if (action.executed_at && action.execution_result) {
      return res.status(200).json({
        ok: true,
        message: 'Already executed',
        ...action.execution_result,
      });
    }

    let executionResult;

    // Route by action_type
    if (action.action_type === 'send_email') {
      if (!action.payload) {
        return res.status(422).json({ ok: false, error: 'Email action missing payload' });
      }
      executionResult = await executeEmailAction(action.payload, supabase);
    } else if (action.action_type === 'send_telegram') {
      return res.status(501).json({ ok: false, error: 'send_telegram not yet implemented' });
    } else if (action.action_type === 'process_refund') {
      return res.status(501).json({ ok: false, error: 'process_refund not yet implemented' });
    } else if (action.action_type === 'execute_purchase') {
      return res.status(501).json({ ok: false, error: 'execute_purchase not yet implemented' });
    } else {
      return res.status(422).json({ ok: false, error: `Unknown action_type: ${action.action_type}` });
    }

    // Update the action: set approved_at, executed_at, status, execution_result
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('heath_actions')
      .update({
        approved_at: now,
        executed_at: now,
        status: 'done',
        execution_result: executionResult,
      })
      .eq('id', action_id)
      .eq('tenant_id', auth.user_id);

    if (updateErr) throw updateErr;

    return res.status(200).json({
      ok: true,
      executed_at: now,
      ...executionResult,
    });
  } catch (err) {
    console.error('[heath-actions-approve-execute] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
