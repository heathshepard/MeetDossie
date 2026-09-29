#!/usr/bin/env python3
"""Regression: TTS spoken-form normalization (scripts/_lib/tts_normalize.py).

THE BUG THIS LOCKS DOWN
-----------------------
2026-09-16: the Dossie D1 short-form video shipped with the line

    "I asked Dossie when the option period ends on 789 Ranch Rd."

and ElevenLabs voiced "Rd" as the letters "R D". Nothing in the pipeline had
ever converted written-form text to spoken-form text before synthesis.

WHAT IS ASSERTED
----------------
1. The exact D1 sentence now speaks "Road".
2. The required mixed fixture -- address + price + TREC + sqft + URL in one
   sentence -- normalizes to its full expected spoken string.
3. The ambiguous abbreviations resolve by context: "Dr" is Drive in an
   address and Doctor before a name; "St" is Street in an address and Saint
   before a place name.
4. The segment alignment round-trips: its written column rebuilds the written
   text exactly and its spoken column rebuilds the spoken text exactly. This
   is the invariant build-shortform-video.py relies on to keep captions in
   written form -- if it breaks, captions silently start showing spoken text.
5. Captions are NEVER normalized: a caption rendered through the alignment
   comes back byte-identical to what the writer typed.

Run: python3 scripts/regression-tts-normalization.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))
from tts_normalize import normalize_for_speech, spoken_span_to_written  # noqa: E402

FAILURES = []
CHECKS = 0


def check(label, actual, expected):
    global CHECKS
    CHECKS += 1
    if actual != expected:
        FAILURES.append(f"{label}\n     expected: {expected!r}\n     actual  : {actual!r}")


def contains(label, haystack, needle, present=True):
    global CHECKS
    CHECKS += 1
    if (needle in haystack) is not present:
        FAILURES.append(
            f"{label}\n     {'missing' if present else 'unexpected'}: {needle!r}"
            f"\n     in: {haystack!r}")


# --- 1. the exact defect Heath reported -------------------------------------
D1 = "I asked Dossie when the option period ends on 789 Ranch Rd."
check("D1 line speaks 'Road'", normalize_for_speech(D1).spoken,
      "I asked Dossie when the option period ends on 789 Ranch Road.")

# --- 2. the required mixed fixture ------------------------------------------
FIXTURE = ("The TREC contract on 123 N Main St lists 1,850 sqft at $999,000 "
           "- details at rustfitness.app")
EXPECTED = ("The Trek contract on 123 North Main Street lists 1,850 square feet "
            "at nine hundred ninety-nine thousand dollars "
            "- details at rustfitness dot app")
check("mixed fixture (address + price + TREC + sqft + URL)",
      normalize_for_speech(FIXTURE).spoken, EXPECTED)

# --- 3. genuine ambiguity, resolved by context ------------------------------
check("Dr = Drive in an address",
      normalize_for_speech("Showing at 702 Fawndale Dr today.").spoken,
      "Showing at 702 Fawndale Drive today.")
check("Dr = Doctor before a name",
      normalize_for_speech("Dr. Crockett terminated.").spoken,
      "Doctor Crockett terminated.")
check("St = Street in an address",
      normalize_for_speech("Listed at 45 Oak St today.").spoken,
      "Listed at 45 Oak Street today.")
check("St = Saint before a place name",
      normalize_for_speech("Near St. Mary's downtown.").spoken,
      "Near Saint Mary's downtown.")

# --- 4. the coverage Heath named --------------------------------------------
for label, source, needle in [
    ("street suffixes", "100 Elm Blvd, 2 Pine Ct, 3 Ash Cir, 9 Fir Pkwy", "Boulevard"),
    ("suffix Ct", "2 Pine Ct here", "Court"),
    ("suffix Hwy", "9 Ranch Hwy here", "Highway"),
    ("unit Ste", "Ste 200", "Suite"),
    ("unit Apt", "Apt 4B", "Apartment"),
    ("directional", "123 SW Military Dr today", "Southwest"),
    ("MLS", "The MLS says", "M L S"),
    ("HOA", "The HOA dues", "H O A"),
    ("TC", "Her TC handles it", "T C"),
    ("DOM", "287 DOM total", "days on market"),
    ("P&S", "the P&S closed", "purchase and sale"),
    ("paragraph symbol", "See ¶ 7B", "paragraph"),
    ("acres", "on 5.5 ac total", "five point five acres"),
    ("beds/baths", "4 bd 3 ba home", "bedrooms"),
    ("percent", "a 2.5% fee", "two point five percent"),
    ("date", "Closing June 1, 2026 confirmed", "June first, twenty twenty-six"),
    ("numeric date", "ends 6/1/2026 sharp", "June first, twenty twenty-six"),
    ("time", "at 5:30 PM sharp", "five thirty P M"),
    ("phone", "call 830-446-3847 now", "eight three zero, four four six"),
    ("ordinal", "the 21st of June", "twenty-first"),
    ("url with path", "go to meetdossie.com/signup", "meetdossie dot com slash signup"),
    ("money per month", "it is $29/mo flat", "twenty-nine dollars a month"),
    ("money with cents", "it is $19.99 flat", "nineteen dollars and ninety-nine cents"),
    ("place name map", "out in Boerne today", "Bernie"),
]:
    contains(label, normalize_for_speech(source).spoken, needle)

# no letter-by-letter URL reading
contains("URL is not spelled letter by letter",
         normalize_for_speech("visit rustfitness.app").spoken, "r u s t", present=False)

# --- 5. alignment round-trip + captions stay written ------------------------
for source in [D1, FIXTURE, "Dr. Crockett saw 702 Fawndale Dr at 5:30 PM for $999,000."]:
    result = normalize_for_speech(source)
    check(f"alignment rebuilds written text: {source[:32]!r}",
          "".join(w for w, _ in result.segments), result.written)
    check(f"alignment rebuilds spoken text: {source[:32]!r}",
          "".join(s for _, s in result.segments), result.spoken)
    check(f"full-span caption is unchanged written form: {source[:32]!r}",
          spoken_span_to_written(result.segments, 0, len(result.spoken)), source)

# a caption must never leak spoken form
caption = spoken_span_to_written(normalize_for_speech(D1).segments, 0, 10 ** 6)
contains("caption keeps written 'Rd'", caption, "789 Ranch Rd.")
contains("caption does not leak spoken 'Road'", caption, "Ranch Road", present=False)

# --- 6. brand name: confirmed pronunciation, deliberately NO respelling -----
# Heath confirmed 2026-09-16 that "Dossie" is DOSS-ee, rhyming with "bossy".
# The D1 render really did say "DAW-see", but the cause was the model/settings,
# not the spelling: on eleven_v3 at the locked stability 0.3 / style 0.4 the
# plain spelling measures at the rhyme-control ceiling. The obvious respellings
# are WORSE ("Dossee"/"Dossy" were heard as "dossier"), so this asserts that
# nobody "helpfully" adds one later.
import json  # noqa: E402

_map = json.loads(
    (Path(__file__).resolve().parent / "config" / "tts-pronunciation-map.json")
    .read_text(encoding="utf-8"))

check("brand name is never substituted for TTS",
      normalize_for_speech("I asked Dossie one question.").spoken,
      "I asked Dossie one question.")

check("no active respelling entry exists for Dossie",
      [e for e in _map["entries"] if e.get("find", "").lower() == "dossie"], [])

_excluded = {e["word"]: e for e in _map.get("researched_but_excluded", [])}
CHECKS += 1
if "Dossie" not in _excluded:
    FAILURES.append("Dossie's confirmed pronunciation is missing from the map's "
                    "researched_but_excluded section -- it must stay recorded so the "
                    "finding is not lost and a bad respelling is not re-added.")
else:
    contains("confirmed pronunciation is recorded",
             _excluded["Dossie"].get("confirmed_pronunciation", ""), "DOSS-ee")
    contains("the do-not-add warning is recorded",
             _excluded["Dossie"].get("do_not_add", ""), "Do NOT add a respelling")

# --- 7. the model decision must not silently revert ------------------------
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "genvo", Path(__file__).resolve().parent / "gen-listing-voiceover.py")
_genvo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_genvo)

check("clone renders on eleven_v3", _genvo.MODEL_CLONE, "eleven_v3")
check("stock voices render on eleven_multilingual_v2",
      _genvo.MODEL_NARRATION, "eleven_multilingual_v2")
check("Heath's locked stability is applied, not re-tuned",
      _genvo.CLONE_LOCKED_STABILITY, 0.3)
check("Heath's locked style is applied, not re-tuned",
      _genvo.CLONE_LOCKED_STYLE, 0.4)
CHECKS += 1
if "turbo" in (_genvo.MODEL_CLONE + _genvo.MODEL_NARRATION):
    FAILURES.append("eleven_turbo_v2 is back in the video path -- it trades quality "
                    "for latency and these are pre-rendered assets.")

# --- report ------------------------------------------------------------------
print(f"tts-normalization regression: {CHECKS - len(FAILURES)}/{CHECKS} checks passed")
if FAILURES:
    print(f"\n{len(FAILURES)} FAILURE(S):\n")
    for f in FAILURES:
        print(f"  [FAIL] {f}\n")
    sys.exit(1)
print("PASS")
