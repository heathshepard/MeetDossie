# Talking-head video script spec — machine-gated

Owner: Sage. Companion to `api/_lib/verify-video-script.js`, modeled directly on
`api/_lib/verify-video-quality.js` (same `addRule`/`rules`/`failedRules` shape, same
fail-closed posture, same "explain the incident that produced the rule" comment style).

**Why this exists.** Heath has had to reject scripts twice for dropping required elements —
once a script dropped the stake and the CTA that every shipped video had, once a script was
"significantly shorter than the others." Both were caught by a human re-reading, after the
script was already written. This spec makes those checks run on the file, before a human
has to notice.

This is a **content-shape gate**, not a fact gate. It cannot verify that a paragraph citation
is correct — that discipline is `MUST BE EXACT` / `MUST NOT SAY` tables, reviewed by a person
against the actual TREC PDF (see `docs/SCRIPTS-TREC-20-19-SERIES.md` for the pattern). What
this gate CAN verify mechanically: every structural element Heath has had to ask for by hand
is actually present, in the right place, at the right time.

---

## 1. File shape

One script = one `##`-or-deeper Markdown section. A file may hold multiple scripts (the
existing series docs do). The parser (`parseScriptSections()`) splits a file into sections at
every heading whose text starts with `SCRIPT` (case-insensitive) — e.g. `# VIDEO 7 — ...`
followed by a `### SCRIPT` subsection — or, for a single-script file, treats the whole file as
one section headed by its first `#`/`##` title.

Each section must carry:

| Field | Format | Purpose |
|---|---|---|
| Cover hook text | `**Cover hook text:** \`ALL CAPS PHRASE\`` | The frame-1 text overlay — never spoken, always on screen at 0.0s |
| Stake | `**Stake:** <sentence>` | What this costs an agent — dollars or a dead deal, stated in plain terms |
| Script body | fenced by a `### SCRIPT` heading, ends at the next `###`/`##`/`#` heading | The actual read-aloud text |

## 2. Tags inside the script body

Tags are markers, never spoken — same convention the TREC 20-19 series already uses for
`` `[FACE]` ``, `` `[SCREEN: ...]` ``, `` `[pause]` ``, `` `[CORE]` ``, `` `[OPTIONAL]` ``. This
spec adds three more, all required:

| Tag | Meaning | Placement rule |
|---|---|---|
| `` `[REHOOK]` `` | Marks the mid-video re-hook line — the "but…" that re-engages a viewer about to scroll off before the payoff | Must land between 50% and 80% of the way through the script's total spoken word count. The chunk it introduces must contain the word **"but"** (word-boundary, case-insensitive) within its first 8 words. |
| `` `[CTA]` `` | Marks the closing call-to-action chunk | Must be one of the last two spoken chunks in the script. |
| `` `[KEYWORD]` `` | Marks the sentence carrying the comment-trigger | Must appear at or after the `[CTA]` tag. The sentence must match natural speech, not an ad read: `comment <WORD>` where `<WORD>` is a short spoken-as-a-word trigger (letters only, 2-12 characters) — e.g. "Comment TREC and I'll send you the checklist." Written in call-and-response form, not "click the link" or "comment below." |

Everything else (frame-1 hook, no spoken lists) is checked directly against the spoken text,
no new tag required:

- **Frame-1 hook, no fade-in.** The `Cover hook text` field must be present and non-empty
  (this is what renders at frame 0.0s — see `hook_visible_frame0` in
  `api/_lib/verify-video-quality.js`, which grades the rendered output; this spec gates the
  script that produces it). The first two spoken lines of the script must not contain the word
  "fade" — a scripted fade direction is exactly what produced a blank frame 0 once already.
- **No spoken lists.** No spoken chunk may contain a markdown bullet/numbered-list line
  (`- item`, `* item`, `1. item`), and no chunk may contain two or more of the ordinal cues
  "first," "second," "third," "fourth" — Heath has rejected a script for reading as a spoken
  list before; a comma-separated run of short phrases (the existing series' own style) is
  fine, an enumerated list is not.

## 3. What is NOT machine-checked (stays human/Hadley review)

- Paragraph-number accuracy, exact quoted form language, and everything in `MUST BE EXACT` /
  `MUST NOT SAY` — those require reading the actual TREC PDF, not the script file.
- Whether a war story is on the `heath-verified-war-stories.md` allowlist.
- Runtime/pace at the measured wpm — that's `docs/DUAL-CUT-PRODUCTION.md` and the rendered-file
  gate in `verify-video-quality.js`, not this file-level check.

## 4. Rule → validator function map

| Rule name | Function |
|---|---|
| `cover_hook_text_present` | `checkCoverHookText()` |
| `frame1_no_fade_direction` | `checkNoFadeDirection()` |
| `stake_present` | `checkStakePresent()` |
| `rehook_present_and_placed` | `checkRehookPlacement()` |
| `cta_present_near_end` | `checkCtaPlacement()` |
| `keyword_trigger_natural` | `checkKeywordTrigger()` |
| `no_spoken_lists` | `checkNoSpokenLists()` |

`validateScript(sectionText)` runs all seven and returns the same
`{ pass, rules, failedRules, detail }` shape `checkVideoQuality()` returns, so any caller that
already knows how to read that shape (Telegram alert formatting, a future CI step) needs no new
code to consume this one.

Related: `docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md` (the full video rubric — hook/completion/
CTA research this spec's rules are drawn from), `feedback_every-video-needs-scroll-stopping-hook.md`,
`docs/SCRIPTS-TREC-20-19-SERIES.md` (the format this spec formalizes).
