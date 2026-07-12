// Vercel Serverless Function: /api/dossie-voice-fill
// Takes voice transcript + visible fields, uses Claude to identify which field to update.
// Updates the field in Supabase, re-renders the PDF, returns updated PDF URL.
//
// POST {
//   dossier_id: string,
//   transcript: "option period 10 days",
//   visible_fields?: ["field_name", ...] // hint for LLM
// }
// Returns: {
//   ok: true,
//   field_name: "option_days",
//   new_value: "10",
//   updated_pdf_url: "https://..."
// } OR {
//   ok: false,
//   asked_clarification?: "Which field did you mean: option_days or earnest_money?"
// }
//
// Authorization: Bearer <supabase user JWT>

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { applyCorsHeaders } = require('./_middleware/cors');

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

// Common TREC field name mapping for user-friendly voice input
// Maps agent speech -> actual field names
const FIELD_ALIASES = {
  'option period': 'option_days',
  'option days': 'option_days',
  'option': 'option_days',
  'days': 'option_days',
  'option fee': 'option_fee',
  'option fee amount': 'option_fee',
  'option money': 'option_fee',
  'earnest money': 'earnest_money',
  'earnest': 'earnest_money',
  'money': 'earnest_money',
  'price': 'sale_price',
  'sale price': 'sale_price',
  'offer': 'sale_price',
  'purchase price': 'sale_price',
  'closing': 'closing_date',
  'closing date': 'closing_date',
  'close date': 'closing_date',
  'date': 'closing_date',
  'buyer': 'buyer_name',
  'buyer name': 'buyer_name',
  'seller': 'seller_name',
  'seller name': 'seller_name',
  'address': 'property_address',
  'property': 'property_address',
  'property address': 'property_address',
  'hoa': 'hoa_monthly_dues',
  'dues': 'hoa_monthly_dues',
  'survey': 'survey_existing_or_seller_pays',
  'as-is': 'as_is',
  'condition': 'as_is_with_repairs',
};

// Money fields — parsed as numeric (strip $, commas) before writing to DB.
// Prevents "$200" being stored as the string "$200" instead of the number 200.
const MONEY_FIELDS = new Set([
  'option_fee',
  'earnest_money',
  'sale_price',
  'hoa_monthly_dues',
  'option_fee_amount',
  'earnest_money_amount',
  'appraisal_value',
  'loan_amount',
  'down_payment',
]);

// Integer fields — parsed as integer (strip everything non-numeric) before write.
const INTEGER_FIELDS = new Set([
  'option_days',
  'financing_days',
  'bedrooms',
  'sqft',
  'year_built',
]);

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    body = body || {};

    const dossierId = sanitizeString(body.dossier_id, { maxLength: 200 });
    const transcript = sanitizeString(body.transcript, { maxLength: 500 });
    const visibleFields = Array.isArray(body.visible_fields) ? body.visible_fields : [];

    if (!dossierId) throw new ValidationError('dossier_id is required.');
    if (!transcript) throw new ValidationError('transcript is required.');

    // Initialize Supabase client (service role for DB access)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase config missing');
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the dossier to check ownership + capture form_type for re-render
    const { data: dealRow, error: dealError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', dossierId)
      .single();

    if (dealError || !dealRow) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }

    if (dealRow.user_id !== userId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized.' });
    }

    // Use Claude (Fable 5 via Anthropic SDK) to parse the transcript
    const client = new Anthropic();

    // Build visible fields context
    const fieldsContext = visibleFields.length > 0
      ? `Visible/nearby fields on the current screen: ${visibleFields.join(', ')}`
      : 'No field hint provided.';

    const systemPrompt = `You are Dossie interpreting a REALTOR's voice input for a TREC real estate contract.

${fieldsContext}

Given the agent's transcript, identify which contract field they are trying to update and extract the value.

Common field mappings:
- "option period" / "option days" / "days" → option_days (number)
- "option fee" / "option money" → option_fee (number, dollars)
- "earnest money" / "earnest" → earnest_money (number, dollars)
- "sale price" / "offer" → sale_price (number, dollars)
- "closing date" / "close" → closing_date (ISO date YYYY-MM-DD)
- "buyer" → buyer_name (string)
- "seller" → seller_name (string)
- "property" / "address" → property_address (string)
- "hoa dues" / "hoa" → hoa_monthly_dues (number)

CRITICAL — SET, do not ADD:
new_value must be the FINAL value the agent wants to SET, not an amount to ADD.
- "set option to 10 days" → new_value = "10" (final)
- "option period is 14 days" → new_value = "14" (final)
- If the agent says "extend it by 5" or "add 5 more days", you MUST compute the final value yourself (existing + 5) and return that final total as new_value. Never return a delta.

CRITICAL — money fields are numeric:
For option_fee, earnest_money, sale_price, hoa_monthly_dues, strip currency symbols and commas. "set option fee to $200" → new_value = "200" (no dollar sign).

Return a JSON response with ONLY one of these:
1. {
  "field_name": "option_days",
  "new_value": "10",
  "confidence": 0.95
}
2. {
  "ambiguous": true,
  "candidates": ["option_days", "earnest_money"],
  "clarification": "Did you mean option period or earnest money?"
}

Confidence > 0.7 means the field identification is clear. If ambiguous or confidence < 0.7, return the ambiguous object.
Do NOT guess. If you cannot determine the field, say so.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Agent's voice input: "${transcript}"`,
        },
      ],
    });

    const textContent = response.content.find((c) => c.type === 'text');
    if (!textContent) {
      return res.status(500).json({ ok: false, error: 'Claude response parsing failed.' });
    }

    let parsed;
    try {
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[dossie-voice-fill] Claude parse error:', e, 'text:', textContent.text);
      return res.status(500).json({ ok: false, error: 'Failed to parse Claude response.' });
    }

    // Check if ambiguous
    if (parsed.ambiguous) {
      return res.status(200).json({
        ok: false,
        asked_clarification: parsed.clarification || 'Not sure which field you meant. Try again.',
      });
    }

    if (!parsed.field_name || !parsed.new_value) {
      return res.status(200).json({
        ok: false,
        asked_clarification: 'I didn\'t understand what to update. Try again.',
      });
    }

    let fieldName = String(parsed.field_name).trim();
    // Apply alias mapping (agent may say "option fee" — map to option_fee).
    if (FIELD_ALIASES[fieldName.toLowerCase()]) {
      fieldName = FIELD_ALIASES[fieldName.toLowerCase()];
    }
    let newValue = String(parsed.new_value).trim();
    const confidence = parsed.confidence || 0;

    if (confidence < 0.7) {
      return res.status(200).json({
        ok: false,
        asked_clarification: `I'm not confident about field "${fieldName}". Could you be more specific?`,
      });
    }

    // Parse money fields as numbers (strip $, commas). Prevents "$200" being
    // stored as the string "$200" instead of the numeric 200.
    let typedValue = newValue;
    if (MONEY_FIELDS.has(fieldName)) {
      const cleaned = newValue.replace(/[^\d.-]/g, '');
      const n = parseFloat(cleaned);
      typedValue = Number.isFinite(n) ? n : 0;
    } else if (INTEGER_FIELDS.has(fieldName)) {
      const cleaned = newValue.replace(/[^\d-]/g, '');
      const n = parseInt(cleaned, 10);
      typedValue = Number.isFinite(n) ? n : 0;
    }

    // Targeted UPDATE — only touches the single field being changed.
    // Never read-then-write full row; this prevents concurrent field updates
    // from clobbering each other (Bug 1 race clobber fix).
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ [fieldName]: typedValue })
      .eq('id', dossierId);

    if (updateError) {
      console.error('[dossie-voice-fill] update error:', updateError);
      return res.status(500).json({ ok: false, error: 'Failed to save field update.' });
    }

    // Re-fetch the transaction after update so the PDF re-render below uses
    // the FRESH row (including any concurrent updates), not the stale dealRow
    // that was captured before this update. Prevents stale-row race clobber
    // in the PDF re-fill payload.
    const { data: freshRow, error: freshErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', dossierId)
      .single();
    if (!freshErr && freshRow) {
      Object.assign(dealRow, freshRow);
    }

    // Trigger PDF re-render for whichever forms are already filled for this dossier.
    // We look up form_types from the documents table (transactions has no form_type column).
    // Note: fill-form writes documents.document_type (snake_case, e.g. 'resale_contract')
    // but /api/fill-form's form_type argument is hyphenated ('resale-contract').
    // So we translate underscore → hyphen when picking the primary form to re-render.
    let updatedPdfUrl = null;
    let regenerateWarning = null;
    try {
      const { data: docRows, error: docErr } = await supabase
        .from('documents')
        .select('form_type, document_type, uploaded_at')
        .eq('transaction_id', dossierId)
        .eq('status', 'filled')
        .order('uploaded_at', { ascending: false });

      if (docErr) {
        regenerateWarning = `documents lookup error: ${docErr.message}`;
      } else if (!docRows || docRows.length === 0) {
        regenerateWarning = 'No filled documents found for this dossier; skipped re-render.';
      } else {
        // Prefer form_type if set; otherwise translate document_type (snake→hyphen).
        const seen = new Set();
        const formTypes = [];
        for (const r of docRows) {
          let ft = r.form_type;
          if (!ft && r.document_type) {
            ft = String(r.document_type).replace(/_/g, '-');
          }
          if (ft && !seen.has(ft)) {
            seen.add(ft);
            formTypes.push(ft);
          }
        }

        const primaryFormType = formTypes[0];
        if (!primaryFormType) {
          regenerateWarning = 'Filled documents exist but no form_type resolvable; skipped re-render.';
        } else {
          const fillFormUrl = `${
            process.env.VERCEL_URL
              ? (process.env.VERCEL_URL.startsWith('http')
                  ? process.env.VERCEL_URL
                  : `https://${process.env.VERCEL_URL}`)
              : 'https://meetdossie.com'
          }/api/fill-form`;

          // Use the freshly re-fetched dealRow (which already includes this
          // update AND any concurrent updates from parallel field changes).
          // The [fieldName]: typedValue override is redundant but kept as a
          // belt-and-suspenders guarantee against stale reads.
          const updatedTransaction = {
            ...dealRow,
            [fieldName]: typedValue,
          };

          // Forward the caller's user JWT so /api/fill-form's verifySupabaseToken
          // treats this as a legitimate user request. Service-role key is NOT a
          // valid user JWT (Supabase /auth/v1/user rejects it as expired).
          const forwardedAuth = req.headers.authorization || '';

          const fillResp = await fetch(fillFormUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: forwardedAuth,
            },
            body: JSON.stringify({
              transaction_id: dossierId,
              form_type: primaryFormType,
              field_values: updatedTransaction,
            }),
          });

          if (fillResp.ok) {
            const fillJson = await fillResp.json().catch(() => ({}));
            updatedPdfUrl = fillJson.signedUrl || fillJson.pdf_url || null;
          } else {
            const errText = await fillResp.text().catch(() => '');
            regenerateWarning = `fill-form ${fillResp.status}: ${errText.slice(0, 120)}`;
            console.warn('[dossie-voice-fill] PDF re-render non-OK:', regenerateWarning);
          }
        }
      }
    } catch (regenerateErr) {
      regenerateWarning = regenerateErr.message;
      console.warn(
        '[dossie-voice-fill] PDF re-render failed but field update succeeded:',
        regenerateErr.message
      );
    }

    const responsePayload = {
      ok: true,
      field_name: fieldName,
      new_value: typedValue,
      updated_pdf_url: updatedPdfUrl,
      confidence,
    };
    if (regenerateWarning) responsePayload.regenerate_warning = regenerateWarning;

    return res.status(200).json(responsePayload);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }

    console.error('[dossie-voice-fill] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
