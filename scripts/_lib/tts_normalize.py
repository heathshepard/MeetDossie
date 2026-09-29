#!/usr/bin/env python3
"""Text normalization for the TTS INPUT ONLY.

WHY THIS EXISTS
---------------
2026-09-16: Heath watched the Dossie D1 short-form video and flagged the
voiceover. The script line was

    "I asked Dossie when the option period ends on 789 Ranch Rd."

and ElevenLabs read "Rd" as the two letters "R D" instead of "Road". That is
not a voice-settings problem and it is not fixable by retuning stability or
style -- the model is reading exactly the characters it was handed. The gap
is that nothing in the pipeline ever converted written-form text into
spoken-form text before synthesis.

THE ONE RULE THAT GOVERNS THIS FILE
-----------------------------------
Normalization applies to the SPOKEN string and NOTHING ELSE. The burned
captions, the on-screen card text and the social post caption all keep normal
written form -- "789 Ranch Rd.", "$999,000", "1,850 sqft". A caption that
reads "seven hundred eighty nine Ranch Road" is a worse video than the bug we
are fixing. This is the same rule the Texas place-name respelling map already
carries (scripts/config/tts-pronunciation-map.json: "NEVER apply this map to
on-screen text, captions, social post copy") -- this module generalises that
rule from place names to structure.

HOW THE CAPTION ASSERTION SURVIVES
----------------------------------
scripts/build-shortform-video.py enforces playbook §5a check 11 in code:
captions must be verbatim what was spoken. Once the spoken string differs
from the written string that assertion cannot be a string equality any more,
so normalization does not return a bare string. It returns a SEGMENT
ALIGNMENT: an ordered list of (written, spoken) pairs whose concatenations
reproduce the written text and the spoken text exactly. The compositor uses
it to walk ElevenLabs' character timings in spoken space while emitting
caption text in written space, so the verbatim check gets STRONGER, not
weaker -- it now proves the two strings are the same content under a declared
mapping, instead of proving they are the same bytes.

AMBIGUITY
---------
Two abbreviations are genuinely ambiguous in our content:

  * "Dr" -- Drive in an address, Doctor before a person's name. We have both
    (702 Fawndale ... and Dr. Crockett, the Nopalito buyer).
  * "St" -- Street in an address, Saint in a place name.

Address spans are matched FIRST and consume their characters, so anything
left over is free to be read as Doctor/Saint. That ordering implements
Heath's instruction directly: when it is genuinely ambiguous, prefer the
address reading, because addresses are what our content is made of.

EXTENDING THIS FILE
-------------------
Add a rule to RULES with a name, a compiled pattern and a function. Rules are
applied in list order and the first rule to claim a character range wins, so
position in that list IS the precedence. Add a case to
scripts/regression-tts-normalization.py in the same change -- a normalization
rule with no fixture is how "Rd" got to production in the first place.
"""

import json
import re
from pathlib import Path

PRONUNCIATION_MAP_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "tts-pronunciation-map.json"
)

# --------------------------------------------------------------- numbers ----

_ONES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]
_SCALES = [(10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")]


def _under_hundred(n):
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")


def _under_thousand(n):
    if n < 100:
        return _under_hundred(n)
    hundreds, rest = divmod(n, 100)
    out = f"{_ONES[hundreds]} hundred"
    if rest:
        out += f" {_under_hundred(rest)}"
    return out


def int_words(n):
    """123456 -> 'one hundred twenty-three thousand four hundred fifty-six'."""
    if n == 0:
        return "zero"
    parts = []
    for value, name in _SCALES:
        if n >= value:
            count, n = divmod(n, value)
            parts.append(f"{_under_thousand(count)} {name}")
    if n:
        parts.append(_under_thousand(n))
    return " ".join(parts)


_ORDINAL_IRREGULAR = {
    "one": "first", "two": "second", "three": "third", "five": "fifth",
    "eight": "eighth", "nine": "ninth", "twelve": "twelfth",
}


def ordinal_words(n):
    """1 -> 'first', 21 -> 'twenty-first', 30 -> 'thirtieth'."""
    words = int_words(n)
    match = re.search(r"([a-z]+)$", words)
    last = match.group(1)
    if last in _ORDINAL_IRREGULAR:
        replacement = _ORDINAL_IRREGULAR[last]
    elif last.endswith("y"):
        replacement = last[:-1] + "ieth"
    else:
        replacement = last + "th"
    return words[: match.start(1)] + replacement


def year_words(y):
    """2026 -> 'twenty twenty-six'; 2005 -> 'two thousand five'.

    Years in 2000-2009 are said as 'two thousand five', not 'twenty oh five',
    which is why that decade falls through to the plain cardinal reading.
    """
    if 1100 <= y <= 1999 or 2010 <= y <= 2099:
        high, low = divmod(y, 100)
        if low == 0:
            return f"{int_words(high)} hundred"
        if low < 10:
            return f"{int_words(high)} oh {_ONES[low]}"
        return f"{int_words(high)} {_under_hundred(low)}"
    return int_words(y)


def decimal_words(text):
    """'2.5' -> 'two point five'. Digits after the point are read singly,
    which is how a rate or a lot size is actually spoken."""
    if "." not in text:
        return int_words(int(text.replace(",", "")))
    whole, frac = text.split(".", 1)
    whole_words = int_words(int(whole.replace(",", "")) if whole else 0)
    frac_words = " ".join(_ONES[int(d)] for d in frac if d.isdigit())
    return f"{whole_words} point {frac_words}"


def _digits_spoken(digits):
    return " ".join(_ONES[int(d)] for d in digits)


# ------------------------------------------------------------ vocabulary ----

STREET_SUFFIXES = {
    "Rd": "Road", "St": "Street", "Dr": "Drive", "Ln": "Lane",
    "Blvd": "Boulevard", "Ct": "Court", "Cir": "Circle", "Hwy": "Highway",
    "Pkwy": "Parkway", "Ave": "Avenue", "Trl": "Trail", "Pl": "Place",
    "Ter": "Terrace", "Sq": "Square", "Xing": "Crossing", "Plz": "Plaza",
    "Expy": "Expressway", "Fwy": "Freeway", "Cv": "Cove", "Bnd": "Bend",
    "Rdg": "Ridge", "Vly": "Valley", "Mnr": "Manor", "Cyn": "Canyon",
}
# Longest-first so "Blvd" is tried before any shorter prefix could win.
_SUFFIX_ALT = "|".join(sorted(STREET_SUFFIXES, key=len, reverse=True))

DIRECTIONALS = {
    "N": "North", "S": "South", "E": "East", "W": "West",
    "NE": "Northeast", "NW": "Northwest", "SE": "Southeast", "SW": "Southwest",
}
_DIR_ALT = "|".join(sorted(DIRECTIONALS, key=len, reverse=True))

MONTHS = {
    "jan": "January", "january": "January", "feb": "February",
    "february": "February", "mar": "March", "march": "March",
    "apr": "April", "april": "April", "may": "May", "jun": "June",
    "june": "June", "jul": "July", "july": "July", "aug": "August",
    "august": "August", "sep": "September", "sept": "September",
    "september": "September", "oct": "October", "october": "October",
    "nov": "November", "november": "November", "dec": "December",
    "december": "December",
}
_MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))
_MONTH_BY_NUMBER = ["", "January", "February", "March", "April", "May",
                    "June", "July", "August", "September", "October",
                    "November", "December"]

# Real-estate and in-house jargon. A value is what the model should SAY.
# Spaced single letters ("M L S") are how you force ElevenLabs to spell an
# initialism instead of attempting it as a word.
JARGON = {
    "TREC": "Trek",           # said "trek" by every Texas agent, never T-R-E-C
    "MLS": "M L S",
    "SABOR": "Say-bore",
    "HOA": "H O A",
    "HOAs": "H O A s",
    "POA": "P O A",
    "MUD": "M U D",
    "TC": "T C",
    "TCs": "T C s",
    "DOM": "days on market",
    "CMA": "C M A",
    "IABS": "I A B S",
    "SDN": "S D N",
    "FSBO": "fizz-bo",
    "REALTOR": "Realtor",
    "REALTORS": "Realtors",
    "ARV": "A R V",
    "LTV": "L T V",
    "HVAC": "H VAC",
    "PITI": "P I T I",
    "MoM": "month over month",
    "YoY": "year over year",
    "TX": "Texas",
    "E&O": "E and O",
    "P&S": "purchase and sale",
    "A/C": "A C",
    "sf": "square feet",
}

_URL_TLDS = ("com", "net", "org", "io", "app", "ai", "co", "dev", "gov",
             "edu", "us", "me", "tv", "info", "biz")


# ----------------------------------------------------------- rule helpers ----

# Words that are capitalised because they start a sentence, not because they
# are part of a street name. Without this, "Near St. Mary's" reads as "Near
# Street. Mary's" and "The Dr. Crockett file" loses the title.
_ADDRESS_STOPWORDS = {
    "a", "an", "and", "at", "but", "by", "for", "from", "he", "her", "his",
    "i", "in", "is", "it", "its", "my", "near", "of", "on", "our", "she",
    "that", "the", "their", "they", "this", "to", "we", "with", "you", "your",
    "was", "were", "as", "or", "if", "so", "up", "out", "off", "per", "via",
}


def _all_stopwords(name):
    tokens = [t for t in re.split(r"\s+", (name or "").strip()) if t]
    return bool(tokens) and all(t.lower().rstrip(".") in _ADDRESS_STOPWORDS
                                for t in tokens)


def _expand_address_body(number, directional, name, suffix):
    """Shared by the number-led and name-led address rules."""
    out = []
    if number:
        out.append(number.strip())
    if directional:
        key = directional.strip().rstrip(".")
        out.append(DIRECTIONALS.get(key, key))
    if name:
        out.append(name.strip())
    out.append(STREET_SUFFIXES[suffix])
    return " ".join(p for p in out if p)


def _money(match):
    raw = match.group("num")
    cents = match.group("cents")
    scale = (match.group("scale") or "").lower()
    period = (match.group("period") or "").lower().lstrip("/ ")

    if scale:
        base = decimal_words(raw + (cents or ""))
        scale_word = {"k": "thousand", "m": "million", "b": "billion"}[scale]
        spoken = f"{base} {scale_word} dollars"
    else:
        whole = int(raw.replace(",", ""))
        spoken = f"{int_words(whole)} dollar" + ("" if whole == 1 else "s")
        if cents:
            cent_digits = cents.lstrip(".")
            cent_value = int(cent_digits.ljust(2, "0")[:2])
            if cent_value:
                spoken += f" and {int_words(cent_value)} cent" + (
                    "" if cent_value == 1 else "s")

    if period:
        period_word = {
            "mo": "a month", "month": "a month", "yr": "a year",
            "year": "a year", "seat": "per seat", "user": "per user",
            "sqft": "per square foot", "sq ft": "per square foot",
            "file": "per file", "door": "per door",
        }.get(period.replace(".", "").strip())
        if period_word:
            spoken += f" {period_word}"
    return spoken


def _url(match):
    host = match.group("host")
    path = match.group("path") or ""
    spoken = " dot ".join(host.split("."))
    if path:
        for part in path.strip("/").split("/"):
            if part:
                spoken += f" slash {part}"
    return spoken.replace("-", " dash ")


def _time(match):
    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3).upper()
    spoken = int_words(hour)
    if minute:
        spoken += f" oh {_ONES[minute]}" if minute < 10 else f" {_under_hundred(minute)}"
    return f"{spoken} {meridiem} M"


def _month_name_date(match):
    month = MONTHS[match.group(1).lower().rstrip(".")]
    day = ordinal_words(int(match.group(2)))
    year = match.group(3)
    spoken = f"{month} {day}"
    if year:
        spoken += f", {year_words(int(year))}"
    return spoken


def _numeric_date(match):
    month, day, year = int(match.group(1)), int(match.group(2)), match.group(3)
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    year_int = int(year)
    if year_int < 100:
        year_int += 2000
    return f"{_MONTH_BY_NUMBER[month]} {ordinal_words(day)}, {year_words(year_int)}"


# ------------------------------------------------------------------ rules ----
# ORDER IS PRECEDENCE. The first rule to claim a character range owns it.
# URLs run before anything that could swallow a dot; address spans run before
# the Doctor/Saint readings so an ambiguous "Dr"/"St" resolves to the address
# sense (Heath's instruction, 2026-09-16).

RULES = [
    ("url", re.compile(
        r"(?<![\w@/.])(?P<host>(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+"
        r"(?:" + "|".join(_URL_TLDS) + r"))"
        r"(?P<path>/[A-Za-z0-9._~\-/]*)?(?![\w.])"), _url),

    ("phone", re.compile(
        r"(?<!\d)(?:\+?1[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})(?!\d)"),
     lambda m: (f"{_digits_spoken(m.group(1))}, {_digits_spoken(m.group(2))}, "
                f"{_digits_spoken(m.group(3))}")),

    ("money", re.compile(
        # The scale letter is inside its own optional group: a bare `\s*`
        # ahead of an absent group still consumes the following space, which
        # glued "$999,000 - see" into "dollars- see".
        r"\$\s?(?P<num>\d{1,3}(?:,\d{3})+|\d+)(?P<cents>\.\d{1,2})?"
        # Reject a trailing word char, and a decimal point that still has
        # digits after it -- but NOT a sentence-ending period, which is what
        # `(?![\w.])` used to do to "$1.2M.".
        r"(?:\s?(?P<scale>[KkMmBb]))?(?!\w)(?!\.\d)"
        r"(?P<period>\s*/\s*(?:mo|month|yr|year|seat|user|sqft|sq ft|file|door)"
        r"|\s+per\s+(?:month|year|seat|user|square foot|file|door))?"), _money),

    ("percent", re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*%"),
     lambda m: f"{decimal_words(m.group(1))} percent"),

    ("time", re.compile(
        r"(?<!\d)(\d{1,2}):(\d{2})\s*([AaPp])\.?\s?[Mm]\.?(?![\w])"), _time),

    ("date_month_name", re.compile(
        r"\b(" + _MONTH_ALT + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?"
        r"(?:,?\s+(\d{4}))?\b", re.IGNORECASE), _month_name_date),

    ("date_numeric", re.compile(r"(?<!\d)(\d{1,2})/(\d{1,2})/(\d{2,4})(?!\d)"),
     _numeric_date),

    # ---- addresses: number-led, e.g. "789 Ranch Rd", "123 N Main St" ----
    ("address_numbered", re.compile(
        r"\b(?P<number>\d+[A-Za-z]?)\s+"
        r"(?P<dir>(?:" + _DIR_ALT + r")\.?\s+)?"
        r"(?P<name>(?:[A-Z][A-Za-z'’]*\.?\s+){0,4}?)"
        r"(?P<suffix>" + _SUFFIX_ALT + r")\b"),
     lambda m: _expand_address_body(m.group("number"), m.group("dir"),
                                   m.group("name"), m.group("suffix"))),

    # ---- ambiguous abbreviations, with the period that disambiguates them ----
    # These run BEFORE the name-led address rule and AFTER the number-led one.
    # "Near St. Mary's" used to become "Near Street. Mary's", because "Near"
    # is capitalised at the start of a sentence and looked like a street name.
    # A following ". Capital" is the Saint/Doctor signal; a house number in
    # front outranks it and has already consumed those characters.
    ("doctor", re.compile(r"\bDr\.(?=\s+[A-Z][a-z])"), lambda m: "Doctor"),
    ("saint", re.compile(r"\bSt\.(?=\s+[A-Z][a-z])"), lambda m: "Saint"),

    # ---- addresses: name-led, e.g. "Wild Cherry Ln", "Pfeiffers Gate Rd" ----
    ("address_named", re.compile(
        r"\b(?P<name>(?:[A-Z][A-Za-z'’]+\s+){1,3})"
        r"(?P<suffix>" + _SUFFIX_ALT + r")\b"),
     lambda m: None if _all_stopwords(m.group("name"))
     else _expand_address_body(None, None, m.group("name"), m.group("suffix"))),

    ("unit_suite", re.compile(r"\bSte\.?\s*(?=[\w#])"), lambda m: "Suite "),
    ("unit_apt", re.compile(r"\bApt\.?\s*(?=[\w#])"), lambda m: "Apartment "),

    # ---- measures ----
    ("sqft", re.compile(r"\b(?:sq\.?\s?ft\.?|sqft)(?![\w])", re.IGNORECASE),
     lambda m: "square feet"),
    ("acres", re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*(?:ac\.?|acres?)(?![\w])"),
     lambda m: f"{decimal_words(m.group(1))} acre"
               + ("" if m.group(1) in ("1", "1.0") else "s")),
    ("beds", re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*(?:bd|br)(?![\w])"),
     lambda m: f"{decimal_words(m.group(1))} bedroom"
               + ("" if m.group(1) == "1" else "s")),
    ("baths", re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*ba(?![\w])"),
     lambda m: f"{decimal_words(m.group(1))} bath"
               + ("" if m.group(1) == "1" else "s")),

    # ---- symbols / jargon ----
    ("paragraph", re.compile(r"¶\s*"), lambda m: "paragraph "),
    ("section", re.compile(r"§\s*"), lambda m: "section "),
    ("jargon", re.compile(
        r"(?<![\w&/])(" + "|".join(
            re.escape(k) for k in sorted(JARGON, key=len, reverse=True))
        + r")(?![\w&/])"), lambda m: JARGON[m.group(1)]),

    # A bare "Dr" (no period) before a name, once every address reading has
    # had its chance: "Dr Crockett confirmed".
    ("doctor_bare", re.compile(r"\bDr(?=\s+[A-Z][a-z])"), lambda m: "Doctor"),

    # ---- misc written shorthand ----
    ("with_slash", re.compile(r"\bw/(?=\s|\w)"), lambda m: "with "),
    ("ampersand", re.compile(r"\s*&\s*"), lambda m: " and "),
    ("eg", re.compile(r"\be\.g\.(?=\s|$)"), lambda m: "for example"),
    ("ie", re.compile(r"\bi\.e\.(?=\s|$)"), lambda m: "that is"),
    ("etc", re.compile(r"\betc\.(?=\s|$)"), lambda m: "et cetera"),
    ("vs", re.compile(r"\bvs\.?(?=\s)"), lambda m: "versus"),
    ("approx", re.compile(r"\bapprox\.(?=\s)"), lambda m: "approximately"),

    # ---- hyphenated counts: "3-day", "4-bedroom" ----
    ("hyphen_count", re.compile(
        r"(?<![\w.])(\d{1,3})-(day|week|month|year|bed|bedroom|bath|car|story|"
        r"acre|point|step|figure|unit|page|hour|minute)\b", re.IGNORECASE),
     lambda m: f"{int_words(int(m.group(1)))}-{m.group(2)}"),

    # ---- ordinals written as digits ----
    ("ordinal", re.compile(r"(?<![\w.])(\d{1,3})(?:st|nd|rd|th)\b"),
     lambda m: ordinal_words(int(m.group(1)))),

    # ---- bare small integers in prose ----
    # A number followed by a capitalised word is a house number on a street
    # we have no suffix for ("23 Nopalito"). Those stay as digits so every
    # address reads the same way whether or not it ends in "Rd"/"St".
    ("small_int", re.compile(
        r"(?<![\w.$,:/-])(\d{1,2})(?![\w.,:/%-])(?!\s+[A-Z][a-z])"),
     lambda m: int_words(int(m.group(1)))),
]


# -------------------------------------------------------------- normalize ----

class NormalizedText:
    """The result of normalizing one piece of script text.

    written  -- the original, which is what captions and post copy must use
    spoken   -- what gets sent to the TTS API
    segments -- ordered (written, spoken) pairs; "".join of each column
                reproduces `written` and `spoken` exactly. This is what lets
                the compositor show written captions on spoken timings.
    fired    -- [(rule_name, written, spoken)] for logging what changed
    """

    __slots__ = ("written", "spoken", "segments", "fired")

    def __init__(self, written, spoken, segments, fired):
        self.written = written
        self.spoken = spoken
        self.segments = segments
        self.fired = fired

    def to_dict(self):
        return {
            "written": self.written,
            "spoken": self.spoken,
            "segments": [list(s) for s in self.segments],
            "fired": [list(f) for f in self.fired],
        }

    def __repr__(self):
        return f"NormalizedText(spoken={self.spoken!r}, rules={len(self.fired)})"


def _load_place_entries():
    """Texas place-name respellings (Boerne -> Bernie). Same TTS-input-only
    rule as everything else here; the file is the source of truth and is
    deliberately research-backed, never guessed."""
    if not PRONUNCIATION_MAP_PATH.exists():
        return []
    try:
        data = json.loads(PRONUNCIATION_MAP_PATH.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    return data.get("entries", [])


def _place_rules(entries):
    rules = []
    for entry in entries:
        find, say = entry.get("find"), entry.get("say")
        if not find or not say:
            continue
        rules.append((
            f"place:{find}",
            re.compile(r"\b" + re.escape(find) + r"\b"),
            (lambda s: (lambda m: s))(say),
        ))
    return rules


def normalize_for_speech(text, place_names=True, extra_rules=None):
    """Convert written script text into what the TTS engine should SAY.

    Returns a NormalizedText. Never mutate captions or post copy with the
    result -- use `.spoken` for the API call and `.written` for everything a
    human reads.
    """
    rules = list(RULES)
    if place_names:
        rules += _place_rules(_load_place_entries())
    if extra_rules:
        rules += extra_rules

    claimed = [False] * len(text)
    spans = []
    for name, pattern, render in rules:
        for match in pattern.finditer(text):
            start, end = match.span()
            if start == end or any(claimed[start:end]):
                continue
            try:
                replacement = render(match)
            except (KeyError, IndexError, ValueError):
                continue
            if replacement is None:
                continue
            spans.append((start, end, replacement, name))
            for i in range(start, end):
                claimed[i] = True

    spans.sort(key=lambda s: s[0])

    segments, fired, spoken_parts, cursor = [], [], [], 0
    for start, end, replacement, name in spans:
        if start > cursor:
            gap = text[cursor:start]
            segments.append((gap, gap))
            spoken_parts.append(gap)
        original = text[start:end]
        segments.append((original, replacement))
        spoken_parts.append(replacement)
        if original != replacement:
            fired.append((name, original, replacement))
        cursor = end
    if cursor < len(text):
        tail = text[cursor:]
        segments.append((tail, tail))
        spoken_parts.append(tail)

    return NormalizedText(text, "".join(spoken_parts), segments, fired)


def spoken_span_to_written(segments, spoken_start, spoken_end):
    """Map a character range in SPOKEN space back to the written text that
    covers it. Used to emit written-form captions on spoken-form timings.

    A partially-covered replacement segment yields the whole written form --
    a caption may not show half of "Road" as "Rd", so the phrase boundary is
    widened to the segment edge rather than split mid-token.
    """
    out, cursor = [], 0
    for written, spoken in segments:
        seg_start, seg_end = cursor, cursor + len(spoken)
        cursor = seg_end
        if seg_end <= spoken_start or seg_start >= spoken_end:
            continue
        if written == spoken:
            lo = max(seg_start, spoken_start) - seg_start
            hi = min(seg_end, spoken_end) - seg_start
            out.append(written[lo:hi])
        else:
            out.append(written)
    return "".join(out)


if __name__ == "__main__":
    import sys

    source = " ".join(sys.argv[1:]) or sys.stdin.read()
    result = normalize_for_speech(source)
    print("WRITTEN:", result.written)
    print("SPOKEN :", result.spoken)
    for name, was, now in result.fired:
        print(f"  [{name}] {was!r} -> {now!r}")
