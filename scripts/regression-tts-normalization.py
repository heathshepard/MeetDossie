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

# --- report ------------------------------------------------------------------
print(f"tts-normalization regression: {CHECKS - len(FAILURES)}/{CHECKS} checks passed")
if FAILURES:
    print(f"\n{len(FAILURES)} FAILURE(S):\n")
    for f in FAILURES:
        print(f"  [FAIL] {f}\n")
    sys.exit(1)
print("PASS")
