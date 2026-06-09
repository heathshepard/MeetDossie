"""Keyword/relevance heuristics shared across platforms.

The scanners pass raw post text through ``score_text()`` -- it returns a
``(score, matched_keywords)`` tuple. Posts with score < ``MIN_SCORE`` are
dropped before any Supabase write happens.

The scoring matches what Cole's Reddit scanner already does, so candidates
from all four platforms compete on a single scale.
"""

from __future__ import annotations

from typing import Tuple, List


# Pain-point keywords -- core TC / dossier territory.
PAIN_KEYWORDS = [
    "transaction coordinator",
    " tc ",  # word boundary handled in score_text
    "tc quit",
    "tc fees",
    "tc cost",
    "drowning in paperwork",
    "drowning in deals",
    "drowning in files",
    "missed deadline",
    "missed the option period",
    "option period",
    "trec form",
    "trec amendment",
    "trec addendum",
    "zipforms",
    "ziplogix",
    "dotloop",
    "skyslope",
    "transactiondesk",
    "broker compliance",
    "compliance review",
    "too many tabs",
    "too many apps",
    "real estate software",
    "tc software",
    "deal coordinator",
    "deadline reminder",
    "closing checklist",
    "earnest money",
    "back to back closings",
    "behind on paperwork",
    "burned out",
    "burned-out",
    "behind on files",
    "office manager quit",
]

# Geographic signals -- bump score for Texas leads.
TEXAS_SIGNALS = [
    "texas",
    " tx ",
    "san antonio",
    "houston",
    "austin",
    "dallas",
    "fort worth",
    "dfw",
    "san marcos",
    "boerne",
    "new braunfels",
    "rio grande valley",
    "rgv",
    "kw ",
    "keller williams",
    "trec",
]

# Phrases that signal the agent is venting about a TC or a broker's compliance.
HOT_PHRASES = [
    "looking for a tc",
    "looking for transaction coordinator",
    "need a transaction coordinator",
    "anyone use a tc",
    "what tc do you use",
    "how do you handle paperwork",
    "i need help with my files",
    "broker requires",
    "broker won't accept",
    "broker won't sign off",
    "office said",
]

MIN_SCORE = 3


def _normalize(text: str) -> str:
    # Pad with spaces so " tc " / " tx " hits even at sentence boundaries.
    return " " + (text or "").lower().replace("\n", " ").replace("\t", " ") + " "


def score_text(text: str) -> Tuple[int, List[str]]:
    """Return ``(score, matched_keywords)`` for ``text``."""
    if not text:
        return 0, []

    normalized = _normalize(text)
    matched: List[str] = []
    score = 0

    for kw in PAIN_KEYWORDS:
        if kw in normalized:
            score += 2
            matched.append(kw.strip())

    for hp in HOT_PHRASES:
        if hp in normalized:
            score += 3
            matched.append(hp.strip())

    for sig in TEXAS_SIGNALS:
        if sig in normalized:
            score += 1
            matched.append(sig.strip())

    # Dedupe while preserving order
    seen = set()
    matched_unique: List[str] = []
    for m in matched:
        if m in seen:
            continue
        seen.add(m)
        matched_unique.append(m)

    return score, matched_unique


def is_relevant(text: str) -> bool:
    score, _ = score_text(text)
    return score >= MIN_SCORE
