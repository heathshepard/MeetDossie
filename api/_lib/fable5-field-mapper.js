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
 * For PDFs > 4 pages: split via pdf-lib into 4-page chunks with 1-page overlap,
 *   call Fable 5 in parallel per chunk, merge fields with 1-indexed absolute
 *   page numbers, dedupe overlapping boundary-page fields.
 *
 * Return shape matches callFable5:
 *   { parsed: { doc_slug, form_number, form_name, total_pages, fields, notes,
 *               _chunks_processed }, usage, model_cost_cents }
 *
 * The frontend + dossiesign-auto-map.js only read parsed.fields, parsed.total_pages,
 * parsed.notes, and model_cost_cents — so this is a drop-in replacement.
 *
 * @param {Array} contentBlocks - Array of Anthropic content blocks. Expected
 *   shape from pdfToImages: [{ type:'document', source:{ type:'base64',
 *   media_type:'application/pdf', data:'<base64>' } }]
 * @param {String} docSlug - Document identifier
 * @param {Object} context - {vertical?, requested_form_number?, pageCount?}
 * @returns {Promise<Object>} Merged field map with all pages' fields
 */
async function callFable5Chunked(contentBlocks, docSlug, context = {}) {
  const isPdfDoc =
    Array.isArray(contentBlocks) &&
    contentBlocks.length === 1 &&
    contentBlocks[0] &&
    contentBlocks[0].type === 'document' &&
    contentBlocks[0].source &&
    contentBlocks[0].source.type === 'base64' &&
    contentBlocks[0].source.media_type === 'application/pdf' &&
    typeof contentBlocks[0].source.data === 'string';

  // Non-PDF input (already rasterized, or malformed) — no chunking possible.
  if (!isPdfDoc) {
    return callFable5(contentBlocks, docSlug, context);
  }

  const pdfBase64 = contentBlocks[0].source.data;
  let pageCount = context.pageCount || 0;

  // If caller didn't tell us the page count, probe with pdf-lib.
  if (!pageCount) {
    try {
      const pdfBytes = Buffer.from(pdfBase64, 'base64');
      const probeDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      pageCount = probeDoc.getPageCount();
    } catch (e) {
      // Can't probe — safest fallback is single-call and let Fable 5 handle it.
      console.log(`[fable5-field-mapper] callFable5Chunked: page-count probe failed (${e.message}); using single call.`);
      return callFable5(contentBlocks, docSlug, context);
    }
  }

  // Fast path: small PDFs go straight to a single Fable 5 call.
  if (pageCount <= 4) {
    return callFable5(contentBlocks, docSlug, context);
  }

  // Chunked path.
  const CHUNK_SIZE = 4;
  const OVERLAP = 1;
  const STRIDE = CHUNK_SIZE - OVERLAP; // = 3

  // Slice the PDF into overlapping 4-page chunks using pdf-lib.
  // Chunk boundaries below are 0-INDEXED page indices; we convert to 1-indexed
  // when merging so downstream page numbers match Fable 5's convention.
  const pdfBytes = Buffer.from(pdfBase64, 'base64');
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e) {
    console.log(`[fable5-field-mapper] callFable5Chunked: pdf-lib load failed (${e.message}); using single call.`);
    return callFable5(contentBlocks, docSlug, context);
  }

  const chunks = [];
  for (let startIdx0 = 0; startIdx0 < pageCount; startIdx0 += STRIDE) {
    const endIdx0Excl = Math.min(startIdx0 + CHUNK_SIZE, pageCount);
    const newDoc = await PDFDocument.create();
    const indices = Array.from({ length: endIdx0Excl - startIdx0 }, (_, i) => startIdx0 + i);
    const copiedPages = await newDoc.copyPages(srcDoc, indices);
    copiedPages.forEach((p) => newDoc.addPage(p));
    const chunkBytes = await newDoc.save();
    chunks.push({
      startPage1: startIdx0 + 1, // 1-indexed absolute page number of first page in chunk
      pageCount: endIdx0Excl - startIdx0,
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from(chunkBytes).toString('base64'),
        },
      },
    });
    if (endIdx0Excl >= pageCount) break;
  }

  console.log(
    `[fable5-field-mapper] callFable5Chunked: ${pageCount}p → ${chunks.length} chunks ` +
      `(${chunks.map((c) => `p${c.startPage1}-${c.startPage1 + c.pageCount - 1}`).join(', ')})`,
  );

  // Fire all chunks in parallel. Each chunk gets its own callFable5 call with the
  // same system prompt; downstream we normalize page numbers.
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      callFable5([chunk.block], docSlug, {
        ...context,
        // Do NOT propagate pageCount — the sub-PDF has its own (small) page count.
        pageCount: undefined,
      }).catch((e) => ({ __error: e.message })),
    ),
  );

  // If ANY chunk hard-failed, surface the first failure — same as callFable5 would.
  const firstFail = chunkResults.find((r) => r && r.__error);
  if (firstFail) {
    throw new Error(`Fable 5 chunk failed: ${firstFail.__error}`);
  }

  // Merge fields with absolute page numbers + dedupe boundary overlaps.
  const allFields = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostCents = 0;
  let formNumber = null;
  let formName = null;
  let firstNotes = null;
  let anySalvaged = false;

  const nearlyEqual = (a, b, tol) => Math.abs((a || 0) - (b || 0)) < tol;

  for (let i = 0; i < chunkResults.length; i++) {
    const chunk = chunks[i];
    const result = chunkResults[i] || {};
    const parsed = result.parsed || {};
    const chunkFields = Array.isArray(parsed.fields) ? parsed.fields : [];

    if (result.usage) {
      totalInputTokens += result.usage.input_tokens || 0;
      totalOutputTokens += result.usage.output_tokens || 0;
    }
    totalCostCents += result.model_cost_cents || 0;
    if (!formNumber && parsed.form_number && parsed.form_number !== 'unknown') formNumber = parsed.form_number;
    if (!formName && parsed.form_name) formName = parsed.form_name;
    if (!firstNotes && parsed.notes) firstNotes = parsed.notes;
    if (parsed._salvaged_from_truncated_response) anySalvaged = true;

    for (const field of chunkFields) {
      if (!field || typeof field !== 'object') continue;
      // Fable 5 returns 1-indexed page numbers relative to the chunk PDF.
      // Convert to 1-indexed absolute: absPage = chunk.startPage1 + (chunkPage - 1).
      const chunkPage1 = Number(field.page) || 1;
      const absolutePage = chunk.startPage1 + (chunkPage1 - 1);

      // Dedupe: if we already have a very-close field on the same absolute page
      // from the previous chunk's tail (overlap zone), skip it.
      const duplicate = allFields.find((f) =>
        f.page === absolutePage &&
        nearlyEqual(f.x_pct, field.x_pct, 5) &&
        nearlyEqual(f.y_pct, field.y_pct, 5) &&
        (f.name === field.name || nearlyEqual(f.w_pct, field.w_pct, 5)),
      );
      if (duplicate) continue;

      allFields.push({ ...field, page: absolutePage });
    }
  }

  return {
    parsed: {
      doc_slug: docSlug,
      form_number: formNumber || 'unknown',
      form_name: formName || '',
      total_pages: pageCount,
      fields: allFields,
      notes: firstNotes || '',
      _chunks_processed: chunks.length,
      _salvaged_from_truncated_response: anySalvaged || undefined,
    },
    usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
    model_cost_cents: totalCostCents,
  };
}

module.exports = { callFable5, callFable5Chunked, postProcessFieldMap, calculateCost, SYSTEM_PROMPT };
