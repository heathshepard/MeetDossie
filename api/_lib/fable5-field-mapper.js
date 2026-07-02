/**
 * api/_lib/fable5-field-mapper.js
 * Call Claude Fable 5 with page images to generate DossieSign field maps.
 * Includes post-processor to fix paired-Y/N inconsistencies per Hadley eval.
 * 
 * Usage:
 *   const { callFable5, postProcessFieldMap } = require('./fable5-field-mapper.js');
 *   const rawMap = await callFable5(pageImages, systemPrompt, docContext);
 *   const processedMap = postProcessFieldMap(rawMap);
 */

const https = require('https');
const { PDFDocument } = require('pdf-lib');

const SYSTEM_PROMPT = `You are Hadley, a Texas real estate contracts expert with 30+ years of practical broker/attorney experience. You are analyzing a real Texas real estate PDF to produce a machine-readable field map that a fill engine will use to auto-populate the form.

TASK: Given the page images of one PDF form, identify EVERY fillable field on EVERY page. For each field, return:

{
  "name": "snake_case_field_key",
  "type": "text" | "checkbox" | "date" | "signature" | "initial" | "radio" | "currency" | "percent" | "phone" | "email" | "number",
  "page": 1-indexed page number,
  "x_pct": 0-100 (horizontal % of page width, top-left of the widget),
  "y_pct": 0-100 (vertical % of page height, top-left of the widget),
  "w_pct": 0-100 (widget width as % of page width),
  "h_pct": 0-100 (widget height as % of page height),
  "party": "buyer" | "seller" | "listing_agent" | "buyer_agent" | "tenant" | "landlord" | "broker" | "escrow" | "attorney" | "either" | "system",
  "required": true|false,
  "paragraph": "the paragraph number or section heading this field belongs to",
  "radio_group_name": "only for type='radio' — shared name for mutually exclusive options (e.g., 'financing_type')",
  "rationale": "one sentence naming what this field represents and why you labeled it this way"
}

CRITICAL RULES:
1. Every fillable widget must be listed. Do not skip page numbers, header addresses, or receipt blocks.
2. For paired Y/N checkboxes on the SAME boolean (e.g., "will [ ] or [ ] will not apply the retainer"), use the SAME name for both boxes with a "checked_when" hint in the rationale.
3. For mutually exclusive N-way choices (e.g., three financing types), use type "radio" with the SAME radio_group_name for each option.
4. Multi-party contact blocks (broker vs agent vs buyer vs seller) MUST use party-prefixed names. NEVER collapse.
5. Use snake_case only. No dots, no dashes, no camelCase, no spaces.
6. Coordinates are approximate — aim for accuracy within ~2% of true position.
7. If a field is a signature block with the party name printed next to it, still emit it as type "signature" with the correct party.
8. Initial blocks (page-footer buyer/seller initials) are type "initial" with party; typically ~10% of page width, positioned near page bottom.
9. Radio buttons (mutually exclusive option indicators) are type "radio" with a shared radio_group_name; use for "check exactly one" scenarios.
10. Do NOT invent fields that aren't in the form. Do NOT skip fields you see.

OUTPUT FORMAT (strict):
Return a single JSON object, nothing else, no markdown fences. Shape:
{
  "doc_slug": "<slug>",
  "form_number": "<the printed form number if visible, e.g. 'TXR-1501', 'TREC 25-17', or 'unknown'>",
  "form_name": "<the printed form name>",
  "total_pages": N,
  "fields": [ { ... field object ... }, ... ],
  "notes": "one paragraph of observations for a human reviewer"
}`;

/**
 * Call Anthropic Fable 5 API with page images or a PDF document block.
 *
 * @param {Array} contentBlocks - Array of Anthropic content blocks. Either
 *   image blocks {type:'image', source:{...}} OR a single document block
 *   {type:'document', source:{type:'base64', media_type:'application/pdf', data:'...'}}
 * @param {String} docSlug - Document identifier for the response
 * @param {Object} context - {vertical?, requested_form_number?}
 * @returns {Promise<Object>} Parsed field map JSON
 */
async function callFable5(contentBlocks, docSlug, context = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const isPdfDoc = contentBlocks.length === 1 && contentBlocks[0] && contentBlocks[0].type === 'document';
  const sourceDescription = isPdfDoc
    ? 'Below is the full PDF (all pages). Analyze EVERY page.'
    : `Below are ${contentBlocks.length} page images IN ORDER (page 1 first). Analyze EVERY page.`;

  const userText = [
    {
      type: 'text',
      text: `Doc slug you must return: "${docSlug}"\n\nVertical: ${context.vertical || 'unknown'}\nRequested form number: ${context.requested_form_number || 'unknown'}\n\n${sourceDescription} Return one JSON object per the system-prompt schema — the "fields" array must include every fillable widget from every page.`,
    },
  ];
  for (const block of contentBlocks) {
    userText.push(block);
  }

  const payload = {
    model: 'claude-fable-5',
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  };

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 600000,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Fable 5 HTTP ${res.statusCode}: ${chunks.slice(0, 200)}`));
        }
        try {
          const envelope = JSON.parse(chunks);
          const textContent = (envelope.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();

          const firstBrace = textContent.indexOf('{');
          const lastBrace = textContent.lastIndexOf('}');
          if (firstBrace < 0 || lastBrace <= firstBrace) {
            return reject(new Error('No JSON found in Fable 5 response'));
          }

          const candidate = textContent.slice(firstBrace, lastBrace + 1);
          let parsed;
          try {
            parsed = JSON.parse(candidate);
          } catch (parseErr) {
            // Truncation recovery: model likely ran out of output tokens mid-array.
            // Salvage the envelope + the trailing complete field objects.
            const salvaged = salvageTruncatedFieldMap(textContent, firstBrace);
            if (!salvaged) {
              return reject(new Error(`Failed to parse Fable 5 response: ${parseErr.message}`));
            }
            parsed = salvaged;
            parsed._salvaged_from_truncated_response = true;
          }
          resolve({ parsed, usage: envelope.usage, model_cost_cents: calculateCost(envelope.usage) });
        } catch (e) {
          reject(new Error(`Failed to parse Fable 5 response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Fable 5 API timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Salvage a truncated Fable 5 JSON response.
 *
 * When the model runs out of output tokens mid-response, the tail JSON is
 * malformed (unclosed object / array). This function finds the last complete
 * field object inside the "fields": [ ... ] array and closes the JSON there.
 *
 * @param {String} textContent - Full raw text from the model
 * @param {Number} firstBrace - Index of the first '{'
 * @returns {Object|null} Parsed envelope with a possibly-truncated fields[] or null
 */
function salvageTruncatedFieldMap(textContent, firstBrace) {
  try {
    // Find the "fields": [ marker
    const fieldsMarker = textContent.indexOf('"fields"', firstBrace);
    if (fieldsMarker < 0) return null;
    const arrOpen = textContent.indexOf('[', fieldsMarker);
    if (arrOpen < 0) return null;

    // Walk the array, tracking nested brace depth and string state.
    // Every time depth returns to 0 at a '}', mark that position as
    // the end of a complete field object.
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastCompleteEnd = -1; // position AFTER last complete top-level '}'

    for (let i = arrOpen + 1; i < textContent.length; i++) {
      const ch = textContent[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) lastCompleteEnd = i + 1;
      }
      else if (ch === ']' && depth === 0) {
        // Reached array close naturally — array is complete; not truncated
        return null;
      }
    }

    if (lastCompleteEnd < 0) return null;

    // Extract envelope preamble + salvaged array + close
    const preamble = textContent.slice(firstBrace, arrOpen + 1);
    const arrayBody = textContent.slice(arrOpen + 1, lastCompleteEnd);
    const rebuilt = preamble + arrayBody + `]}`;
    return JSON.parse(rebuilt);
  } catch {
    return null;
  }
}

/**
 * Post-processor: fix paired-Y/N inconsistencies.
 * Scans for _will/_will_not, _has/_has_not, _is/_is_not suffix pairs.
 * If both variants exist, merges them into a single field with the shared base name.
 * 
 * @param {Array} fields - Fable 5 field array
 * @returns {Array} Processed field array
 */
function postProcessFieldMap(fields) {
  if (!Array.isArray(fields)) return fields;

  // Build a map of base names to their variants
  const variants = {};
  const toKeep = new Set(fields.map((_, i) => i));

  fields.forEach((field, idx) => {
    if (!field || !field.name) return;
    
    const name = field.name;
    let base = null;
    let suffix = null;

    // Check for paired-boolean suffix patterns
    if (name.endsWith('_will_not')) {
      base = name.slice(0, -'_will_not'.length);
      suffix = 'will_not';
    } else if (name.endsWith('_will')) {
      base = name.slice(0, -'_will'.length);
      suffix = 'will';
    } else if (name.endsWith('_has_not')) {
      base = name.slice(0, -'_has_not'.length);
      suffix = 'has_not';
    } else if (name.endsWith('_has')) {
      base = name.slice(0, -'_has'.length);
      suffix = 'has';
    } else if (name.endsWith('_is_not')) {
      base = name.slice(0, -'_is_not'.length);
      suffix = 'is_not';
    } else if (name.endsWith('_is')) {
      base = name.slice(0, -'_is'.length);
      suffix = 'is';
    }

    if (base) {
      if (!variants[base]) variants[base] = {};
      variants[base][suffix] = idx;
    }
  });

  // For each base with both _will and _will_not (etc), keep only the _will variant,
  // mark _will_not for removal, and update the rationale
  Object.entries(variants).forEach(([base, suffs]) => {
    const hasWill = 'will' in suffs;
    const hasWillNot = 'will_not' in suffs;
    const hasHas = 'has' in suffs;
    const hasHasNot = 'has_not' in suffs;
    const hasIs = 'is' in suffs;
    const hasIsNot = 'is_not' in suffs;

    if (hasWill && hasWillNot) {
      const keepIdx = suffs.will;
      const removeIdx = suffs.will_not;
      fields[keepIdx].rationale = (fields[keepIdx].rationale || '') + ' [paired-boolean: both _will and _will_not merged into single field]';
      toKeep.delete(removeIdx);
    } else if (hasHas && hasHasNot) {
      const keepIdx = suffs.has;
      const removeIdx = suffs.has_not;
      fields[keepIdx].rationale = (fields[keepIdx].rationale || '') + ' [paired-boolean: both _has and _has_not merged into single field]';
      toKeep.delete(removeIdx);
    } else if (hasIs && hasIsNot) {
      const keepIdx = suffs.is;
      const removeIdx = suffs.is_not;
      fields[keepIdx].rationale = (fields[keepIdx].rationale || '') + ' [paired-boolean: both _is and _is_not merged into single field]';
      toKeep.delete(removeIdx);
    }
  });

  return fields.filter((_, i) => toKeep.has(i));
}

/**
 * Calculate cost in cents based on Fable 5 pricing: $3/M input, $15/M output.
 *
 * @param {Object} usage - {input_tokens, output_tokens}
 * @returns {Number} Cost in cents (e.g. 138 = $1.38)
 */
function calculateCost(usage) {
  if (!usage) return 0;
  const inputCost = (usage.input_tokens || 0) * (3 / 1_000_000);
  const outputCost = (usage.output_tokens || 0) * (15 / 1_000_000);
  return Math.round((inputCost + outputCost) * 100);
}

/**
 * Call Fable 5 with chunked processing for large PDFs.
 *
 * For PDFs ≤ 4 pages: single call (fast path)
 * For PDFs > 4 pages: split into 4-page chunks with 1-page overlap,
 *   call Fable 5 in parallel, merge results with page-offset adjustments,
 *   dedupe fields on boundary pages.
 *
 * @param {Array} contentBlocks - Array of Anthropic content blocks (same as callFable5)
 * @param {String} docSlug - Document identifier
 * @param {Object} context - {vertical?, requested_form_number?}
 * @returns {Promise<Object>} Merged field map JSON with all pages' fields
 */
async function callFable5Chunked(contentBlocks, docSlug, context = {}) {
  // Single PDF document block — extract page count from pdfToImages wrapper
  const isPdfDoc = contentBlocks.length === 1 && contentBlocks[0]?.type === 'document';

  if (!isPdfDoc) {
    // Not a PDF doc block (e.g., already rasterized images) — use single call
    return callFable5(contentBlocks, docSlug, context);
  }

  // For now, detect page count by calling pdfToImages first (which is already done upstream in dossiesign-auto-map)
  // If this is being called from dossiesign-auto-map, the pageCount is already known and passed separately.
  // For pure chunking, we'd need to extract pageCount from the PDF. For v1, assume it's passed via context.

  const pageCount = context.pageCount || 0;

  // Fast path: ≤ 4 pages, use single call
  if (pageCount <= 4) {
    return callFable5(contentBlocks, docSlug, context);
  }

  // Chunked path: split into 4-page chunks with 1-page overlap
  // Each chunk = [startPage, endPage] with 1-page overlap with adjacent chunks
  const chunks = [];
  for (let start = 1; start <= pageCount; start += 4) {
    const end = Math.min(start + 4 - 1, pageCount);
    chunks.push({ start, end });
  }

  // In a real implementation, we'd need to re-rasterize PDFs per chunk range.
  // For now, this is a stub that falls back to single call for proper chunking support.
  // The actual chunking requires pdf-lib or similar to slice the PDF and re-wrap it.
  // Blocking issue: Vercel has maxDuration 300s; we're relying on Fable 5 to handle full PDF in <60s.

  // TODO: implement proper chunking once we have a PDF slicing utility (e.g., via pdf-lib).
  // For now, return the non-chunked result and document the future path.
  console.log(`[fable5-field-mapper] callFable5Chunked: PDF is ${pageCount} pages (>4). Chunking not yet implemented; using single call.`);
  return callFable5(contentBlocks, docSlug, context);
}

module.exports = { callFable5, callFable5Chunked, postProcessFieldMap, calculateCost, SYSTEM_PROMPT };
