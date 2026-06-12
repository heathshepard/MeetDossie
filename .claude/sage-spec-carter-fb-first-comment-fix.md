# Sage spec for Carter — FB group first-comment Dossie naming fix

**Owner:** Sage (Social) | **Implementer:** Carter | **Branch:** staging
**Date:** 2026-06-10
**Severity:** medium — 3 posts/day are getting validator-rejected at the approval gate; Dossie awareness is the entire point of the first comment.

---

## Root cause

`api/_lib/group-post-generator.js` Haiku prompt has **strong negative constraint** on Dossie in post body (Rule 2: "Do NOT mention Dossie in the post body. Ever.") but **only a weak parenthetical** on the first comment ("rewrite this too, keep Dossie mention natural").

Haiku interprets "natural" as "obfuscated" and outputs phrases like:
- "an AI tool I've been working with"
- "what changed the game for me was getting serious about automation"
- (third post had no AI mention at all, just described capabilities)

Compounding factor: several scaffold templates themselves don't name Dossie in the example `first_comment` field — A-4, B-3, C-1 (partial), E-1, E-2, D-1 use generic framing ("an AI"/"something I built"/"the system I landed on"). The model mirrors that style.

Validator at `api/group-post-callback.js:117` is case-sensitive `.includes('Dossie')`. Works correctly. Generator is the problem.

---

## Required changes — `api/_lib/group-post-generator.js`

### Change 1 — Rewrite the FIRST COMMENT section of the prompt

Current (lines 274-284):
```
FIRST COMMENT (rewrite this too, keep Dossie mention natural):
---
${template.first_comment || '(no first comment for this template)'}
---

Return STRICT JSON only. No markdown. No commentary.

{
  "post_body": "<the rewritten post, plain text, newlines allowed>",
  "first_comment_body": "<rewritten first comment with Dossie mention, or null if template has no first comment>"
}
```

Replace with:
```
FIRST COMMENT — DIFFERENT RULES FROM POST BODY:
---
${template.first_comment || '(no first comment for this template)'}
---

FIRST COMMENT RULES — NON-NEGOTIABLE:
A. The first comment MUST contain the literal word "Dossie" (capital D, exact spelling). This is the ONE place where the brand IS named.
B. The first comment MUST name ONE specific Dossie capability tied to the post's pain point. Pick from:
   - "Dossie auto-calculates every TREC deadline from the contract date"
   - "Dossie sends me a morning brief with every deal that needs attention today"
   - "Dossie tracks document uploads with timestamps"
   - "Dossie pings me on every pending document so nothing sits"
   - "Dossie handles the follow-up sequencing with title and lender"
   - "Dossie maps every transaction to a pipeline view I can see at a glance"
C. FORBIDDEN phrasings — do not use any of these:
   - "an AI tool I've been working with"
   - "a tool I've been using"
   - "something I built"
   - "the system I landed on"
   - "AI handling my [anything]"
   - any framing that describes Dossie without naming it
D. Tone: still casual and in Heath's voice. Naming Dossie is required; sounding corporate is not.
E. Include "meetdossie.com/founding" at the end of the first comment if (and only if) the scaffold's first_comment includes a URL.

Return STRICT JSON only. No markdown. No commentary.

{
  "post_body": "<the rewritten post, plain text, newlines allowed>",
  "first_comment_body": "<rewritten first comment that includes the literal word Dossie and ONE specific capability, or null if template has no first comment>"
}
```

### Change 2 — Pre-flight assertion + 1 retry with explicit feedback

In `runGroupPostGeneration`, after the `generatePostWithHaiku` call (around line 451), before the `dryRun` check and `insertRow`, add:

```javascript
// Sage rule: first_comment_body must include the literal word "Dossie".
// Validator at api/group-post-callback.js will block approval if it doesn't.
// Retry once with explicit feedback before giving up.
if (firstComment && !firstComment.includes('Dossie')) {
  log(`[group-post-generator] First comment for "${group.group_name}" missing "Dossie" - retrying with feedback`);

  const retryPrompt = `Your previous first_comment_body did not contain the word "Dossie".

The first comment is the ONE place where Dossie MUST be named explicitly. Rewrite the first comment to:
1. Include the literal word "Dossie" (capital D).
2. Name ONE specific Dossie capability tied to the post topic.
3. Match Heath's casual voice.
4. Do NOT use phrases like "an AI tool", "a tool I've been working with", "something I built". Those are forbidden.

Original post_body (do not change):
---
${postBody}
---

Original first_comment that failed:
---
${firstComment}
---

Return STRICT JSON only:
{
  "first_comment_body": "<rewritten first comment that includes the literal word Dossie>"
}`;

  try {
    const retryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: retryPrompt }],
      }),
    });
    const retryText = await retryRes.text();
    if (retryRes.ok) {
      const retryData = JSON.parse(retryText);
      let r = (retryData?.content?.[0]?.text || '').trim();
      if (r.startsWith('```')) r = r.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
      const fb = r.indexOf('{');
      const lb = r.lastIndexOf('}');
      if (fb >= 0 && lb > fb) {
        const retryParsed = JSON.parse(r.slice(fb, lb + 1));
        const retryComment = retryParsed.first_comment_body
          ? String(retryParsed.first_comment_body).trim()
          : null;
        if (retryComment && retryComment.includes('Dossie')) {
          log(`[group-post-generator] Retry succeeded for "${group.group_name}"`);
          // Reassign for downstream insert
          // eslint-disable-next-line no-param-reassign
          result.first_comment_body = retryComment;
        } else {
          log(`[group-post-generator] Retry still missing "Dossie" for "${group.group_name}" - skipping insert`);
          skipped++;
          continue;
        }
      }
    }
  } catch (err) {
    log(`[group-post-generator] Retry error for "${group.group_name}": ${err.message} - skipping insert`);
    skipped++;
    continue;
  }
}

// Re-derive firstComment from possibly-updated result before insertRow
const finalFirstComment = result.first_comment_body
  ? String(result.first_comment_body).trim()
  : null;
```

Then update the `insertRow` to use `finalFirstComment` instead of `firstComment`.

### Change 3 — Tighten scaffold first_comment fields that talk around Dossie

Update these scaffolds so the model sees Dossie named in the example:

- **A-4** line 72: change `"Love seeing these answers - the spread is wild. For what it's worth, I've been using an AI that auto-calculates every TREC deadline from contract date and sends daily deal briefs. meetdossie.com/founding if you're in the B or C camp and want to try something different."` → `"Love seeing these answers - the spread is wild. I built Dossie for exactly this - it auto-calculates every TREC deadline from the contract date and sends me a morning brief on what's due. meetdossie.com/founding if you're in the B or C camp and want to try it."`

- **B-3** line 114: change `"For what it's worth, I've been tracking TREC updates pretty closely because I built a tool that auto-maps form versions to transactions. Happy to share what I've found on the new disclosures if useful."` → `"For what it's worth, I built Dossie to auto-map TREC form versions to transactions - July 1 updates are already in the system. Happy to share what I've found on the new disclosures if useful. meetdossie.com/founding"`

- **C-1** line 126: already names Dossie — leave.

- **D-1** line 163: change `"For what it's worth - I've been using AI to handle the ops layer. meetdossie.com/founding - Texas agents, founding pricing still open."` → `"For what it's worth - I built Dossie to handle the ops layer for solo agents. meetdossie.com/founding - Texas agents, founding pricing still open."`

- **E-1** line 197: change `"I built something to handle this for myself - AI transaction coordinator. Happy to share if anyone wants details."` → `"I built Dossie to handle this for myself - she auto-calculates TREC deadlines, sends morning briefs, and chases document signatures. meetdossie.com/founding"`

- **E-2** line 207: change `"For what it's worth - the system I landed on is AI handling my transaction ops. meetdossie.com/founding if you're curious what that looks like."` → `"For what it's worth - I built Dossie to handle my transaction ops. meetdossie.com/founding if you're curious what that looks like."`

---

## Backfill — the 3 stranded posts

After deploying to staging and confirming next generation cycle is clean, re-generate the 3 stranded drafts so they make today's posting window. Their IDs are below; **delete + re-run** for those specific groups using the `groupIdFilter` mechanism rather than a one-off SQL patch (so the new prompt is what produced them — audit trail stays clean).

```
| group_name                  | group_post_id                          | group_registry needed |
|-----------------------------|----------------------------------------|------------------------|
| All about Real Estate Houston | d8c6ce7d-bbc6-4056-bb36-477a3cacd1a8 | look up by group_name  |
| Texas Real Estate Network   | f01ecca2-6c9d-46ff-afd0-d8879027da8a   | look up by group_name  |
| Texas Real Estate Agents    | 2afe1200-81d1-439c-b91a-625d538bccf0   | look up by group_name  |
```

Steps:
1. After staging deploy, run a one-shot CLI:
   ```
   node scripts/generate-group-posts.js --group-id <REGISTRY_ID> --force
   ```
   for each of the 3 groups. (The script wraps `runGroupPostGeneration` with `groupIdFilter`.)
2. Mark the 3 stranded drafts as `status='rejected'` with a note `'sage_backfill_2026-06-10 — replaced by regen'` so they don't sit in Telegram forever.
3. Verify the 3 NEW drafts have `first_comment_body LIKE '%Dossie%'` before they hit Heath.

If `generate-group-posts.js` doesn't accept `--group-id`, Carter adds that flag (it should map to `groupIdFilter` in `runGroupPostGeneration` opts).

---

## QA gate — Sage will verify

After Carter pushes to staging:
1. Sage runs the generator in `dryRun=true` mode against 5 sample groups
2. Sage confirms every `first_comment_body` returned contains "Dossie"
3. Sage confirms none contain forbidden phrases ("an AI tool", "a tool I've been working with", "something I built", "the system I landed on")
4. Sage signs off; Quinn runs her gate; Heath merges to main

Report SHA + dry-run output to Cole.
