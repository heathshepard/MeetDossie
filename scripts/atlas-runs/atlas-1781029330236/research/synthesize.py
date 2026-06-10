"""
Atlas — Synthesize captures/*.txt into the final cited markdown doc.

Strategy:
- For each platform, walk each capture file.
- Extract paragraph/sentence-level snippets matching topic keyword sets.
- Tag each finding with the capture's source label + URL + date_hint.
- Render the per-platform sections per Heath's template.

Heuristic — not LLM. The captures are the source of truth; we just surface the strongest sentences.
If a capture is empty / blocked / clearly an SSO wall, we skip it (and log).
"""
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from datetime import date

RUN = Path(__file__).parent
CAP_DIR = RUN / "captures"
INDEX = CAP_DIR / "index.jsonl"
OUT_DOC = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\docs\platform-algorithm-research-cited-2026-06-09.md")

PLATFORM_DISPLAY = {
    "reddit": "Reddit",
    "fb-groups": "Facebook Groups",
    "fb-pages": "Facebook Pages",
    "instagram": "Instagram (posts + reels + comments)",
    "linkedin": "LinkedIn",
    "x": "X / Twitter",
    "tiktok": "TikTok",
}

PLATFORM_ORDER = ["reddit", "fb-groups", "fb-pages", "instagram", "linkedin", "x", "tiktok"]

# Strong topic-keyword sets. Each sentence goes to AT MOST one bucket — the bucket with the
# highest specificity score. We REQUIRE at least one "strong" phrase per bucket to qualify.
TOPIC_STRONG = {
    "changes": [
        "in 2025", "in 2026", "2025 update", "2026 update",
        "rolling out", "rolled out", "announced this", "as of 2025", "as of 2026",
        "newly ranked", "now ranks", "now prioritizes", "now favors",
        "this year, instagram", "this year, tiktok", "this year, linkedin",
        "this year, reddit", "this year, facebook", "recent change",
        "as of this year", "starting in 2025", "starting in 2026",
    ],
    "drives": [
        "watch time", "completion rate", "dwell time", "saves", "shares",
        "comments per", "the algorithm rewards", "ranking signals",
        "ranking signal", "promoted by the algorithm", "favored by the algorithm",
        "original content", "carousel posts get", "reels get",
        "first three seconds", "first 3 seconds", "hook in the first",
        "high-quality content", "informative content", "knowledge content",
        "engagement rate", "comment-to-like ratio", "dms generated",
        "reposts", "send rate", "swipe rate",
    ],
    "kills": [
        "down-rank", "downrank", "downranked", "demoted", "demote", "demotes",
        "penalize", "penalized", "penalty", "reach is limited",
        "limits reach", "limits your reach", "spam policy", "engagement bait",
        "clickbait", "external link penalty", "off-platform link",
        "shadow ban", "shadowbanned", "shadow-banned",
        "violation", "violates", "policy violation",
        "blurry video", "low-resolution", "watermarked",
        "tiktok watermark", "low quality content",
    ],
    "promotion": [
        "self-promotion", "self promote", "9:1 rule", "9-to-1 rule",
        "9 to 1 ratio", "90/10 rule", "90/10 ratio", "10:1 rule",
        "promotional posts", "transparent about",
        "disclose your affiliation", "disclose that you",
        "subreddit rules", "rule 1", "rule 5", "rule 6", "rule 7",
        "company posting", "business posting", "founder posting",
        "vanity url", "ban for self-promotion",
        "astroturfing", "promotional content",
        "lurking and learning", "avoid being too promotional",
        "feels salesy", "salesy",
    ],
    "timing": [
        "best time to post", "optimal time to post", "best day to post",
        "post at", "publish at", "publish between",
        "monday morning", "tuesday morning", "wednesday morning",
        "tuesday at", "wednesday at", "thursday at",
        "between 9 am", "between 8 am", "between 10 am",
        "9 am cst", "9 am est", "9 am pst", "9 a.m.",
        "1-3 times per week", "3-5 times per week", "post 1-2",
        "frequency:", "posting frequency",
    ],
}
TOPIC_WEAK = {
    "changes": ["2025", "2026", "rolled out", "introduce"],
    "drives": ["engagement", "ranking", "rank ", "reward", "boost",
               "carousel", "reel", "video", "comment"],
    "kills": ["spam", "penal", "violat", "ban", "low quality", "blur"],
    "promotion": ["self-promot", "promotion", "subreddit", "post your own",
                  "advertis"],
    "timing": ["best time", "optimal", "post at", "morning", "afternoon",
               "evening", "weekday", "tuesday", "wednesday", "thursday"],
}

SPLIT_RE = re.compile(r"(?<=[\.\!\?])\s+(?=[A-Z0-9\"\(])")
WHITESPACE_RE = re.compile(r"\s+")


def clean_sentence(s: str) -> str:
    s = WHITESPACE_RE.sub(" ", s).strip()
    # strip trailing menu-junk often pulled in by select-all
    return s


NAV_BLOCKLIST = {
    "home", "menu", "search", "log in", "sign in", "subscribe", "pricing",
    "features", "resources", "blog", "about", "contact", "careers", "login",
    "get started", "get started for free", "learn more", "read more",
    "table of contents", "tweet", "share", "next", "previous", "see all",
    "free trial", "start your free trial", "start free trial", "book a demo",
    "watch the video", "explore", "products",
}

NAV_PREFIXES = (
    "©", "copyright ", "privacy", "terms ", "cookie",
    "subscribe to", "join our", "sign up for",
    "follow us", "we use cookies",
)


def split_sentences(text: str):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or len(line) < 30:
            continue
        low = line.lower()
        if low in NAV_BLOCKLIST:
            continue
        if any(low.startswith(p) for p in NAV_PREFIXES):
            continue
        # Skip lines that are mostly punctuation/menu separators
        if sum(c.isalpha() for c in line) < len(line) * 0.5:
            continue
        for piece in SPLIT_RE.split(line):
            piece = clean_sentence(piece)
            if not (50 <= len(piece) <= 320):
                continue
            if piece.endswith(":") and len(piece) < 80:
                continue
            if any(piece.lower().startswith(p) for p in NAV_PREFIXES):
                continue
            # Reject title-case headlines (no period, mostly capitalized words)
            if not piece.endswith((".", "!", "?", "\"", "”", "'")):
                # If it's mostly title case (>50% words start with cap), it's likely a heading
                words = piece.split()
                if len(words) >= 4:
                    cap_ratio = sum(1 for w in words if w[:1].isupper()) / len(words)
                    if cap_ratio > 0.55:
                        continue
                # Heading-like: ends without punctuation AND has < 14 words → skip
                if len(words) < 14:
                    continue
            out.append(piece)
    return out


def topic_match(sent: str):
    """
    Return (topic, score) for the single best-matching bucket, or (None, 0).
    Strong phrases score 3; weak score 1. Bucket must score >= 2 to qualify.
    """
    low = sent.lower()
    scores = {t: 0 for t in TOPIC_STRONG}
    for topic, kws in TOPIC_STRONG.items():
        for kw in kws:
            if kw in low:
                scores[topic] += 3
    for topic, kws in TOPIC_WEAK.items():
        for kw in kws:
            if kw in low:
                scores[topic] += 1
    best_topic, best_score = max(scores.items(), key=lambda kv: kv[1])
    if best_score < 2:
        return (None, 0)
    # Generic noise rejection: sentence must contain at least one platform/social/algo word
    # UNLESS the topic is promotion or timing with a strong-phrase hit (those are inherently relevant).
    needs_anchor = best_topic not in ("promotion", "timing") or best_score < 3
    if needs_anchor and not any(w in low for w in (
        "reddit", "facebook", "instagram", "linkedin", "twitter", "x ",
        "tiktok", "meta", "platform", "algorithm", "ranking", "post ",
        "video", "reel", "comment", "share", "engage", "feed", "creator",
        "for you", "fyp", "page", "group ", "subreddit", "publish",
        "audience", "follower",
    )):
        return (None, 0)
    return (best_topic, best_score)


def load_index():
    entries = []
    if not INDEX.exists():
        return entries
    for ln in INDEX.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            entries.append(json.loads(ln))
        except Exception:
            continue
    return entries


PLATFORM_TOKENS = {
    "reddit": ["reddit", "subreddit", "r/", "karma", "upvote"],
    "fb-groups": ["facebook", "group", "meta"],
    "fb-pages": ["facebook", "page", "meta"],
    "instagram": ["instagram", "ig ", "reels", "mosseri", "explore"],
    "linkedin": ["linkedin", "newsletter", "post on linkedin"],
    "x": ["twitter", "x ", "tweet", "post on x"],
    "tiktok": ["tiktok", "for you", "fyp"],
}


def is_off_platform(platform: str, text: str) -> bool:
    """Return True if the captured text is from a stale tab that's clearly about a different platform."""
    low = text.lower()[:4000]
    tokens = PLATFORM_TOKENS.get(platform, [])
    return not any(t in low for t in tokens)


def is_blocked(text: str) -> bool:
    if not text or len(text) < 1500:
        return True
    low = text.lower()
    blockers = [
        "enable javascript and cookies to continue",
        "verify you are a human",
        "checking your browser",
        "access denied",
        "page not found",
        "sorry, we can’t find that page",
        "sorry, we can't find that page",
        "this page isn't available",
        "this page can’t be found",
        "we couldn't find this page",
        "oops! that page can’t be found",
        "the page you're looking for has vanished",
        "the page you are looking for has vanished",
        "page you're looking for has vanished",
        "page you are looking for has vanished",
    ]
    if any(b in low for b in blockers) and len(text) < 4000:
        return True
    return False


def synthesize_platform(platform: str, entries):
    sections = {"changes": [], "drives": [], "kills": [], "promotion": [], "timing": []}
    used_sources = []
    seen_sentences = set()

    for entry in entries:
        path = Path(entry["file"])
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if is_blocked(text):
            entry["_blocked"] = True
            continue
        if is_off_platform(entry["platform"], text):
            entry["_blocked"] = True
            continue
        entry["_blocked"] = False
        used_sources.append(entry)

        for sent in split_sentences(text):
            norm = sent.lower().strip()
            if norm in seen_sentences:
                continue
            topic, score = topic_match(sent)
            if not topic:
                continue
            seen_sentences.add(norm)
            if len(sections[topic]) >= 8:
                continue
            sections[topic].append((sent, entry, score))

    # Sort each bucket by score desc so the strongest findings surface first
    for t in sections:
        sections[t].sort(key=lambda x: -x[2])

    return sections, used_sources


def render_finding(item):
    sent, entry, _score = item
    return f"- {sent} (Source: {entry['source_label']} — {entry['url']}, Date: {entry['date_hint']})"


SPECIFIC_PATTERN = re.compile(
    r"(\b\d{1,3}\s?%|\bin\s+202[3456]\b|\b202[3456]\b|"
    r"\b\d+\s*(am|pm|a\.m\.|p\.m\.)\b|"
    r"\b\d+(\.\d+)?\s*(billion|million|x|times)\b|"
    r"\b(first|second|third)\s+\d+\s+seconds?\b|"
    r"\b(launched|rolled out|announced)\b)",
    re.IGNORECASE,
)


def harvest_specifics(entries):
    """Pull sentences with hard specifics (numbers, dates, named features) across all captures for a platform."""
    out = []
    seen = set()
    for entry in entries:
        path = Path(entry["file"])
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if is_blocked(text):
            continue
        if is_off_platform(entry["platform"], text):
            continue
        for sent in split_sentences(text):
            if SPECIFIC_PATTERN.search(sent):
                norm = sent.lower()
                if norm in seen:
                    continue
                seen.add(norm)
                # quick relevance — must mention the platform space
                low = sent.lower()
                if not any(w in low for w in (
                    "reddit", "facebook", "instagram", "ig ", "linkedin",
                    "twitter", "tiktok", "meta", "x ", "creator", "feed",
                    "algorithm", "post ", "video", "reel", "page", "group",
                    "engage", "ranking", "follower", "audience",
                )):
                    continue
                out.append((sent, entry))
                if len(out) >= 8:
                    return out
    return out


def render_platform(platform: str, sections, used_sources):
    title = PLATFORM_DISPLAY[platform]
    today = "2026-06-09"
    lines = []
    lines.append(f"## {title} (researched {today}, sources: {len(used_sources)})")
    lines.append("")

    def block(header, items):
        if not items:
            return [f"### {header}", "- (No strong signal extracted from captured pages — see source list below.)", ""]
        return [f"### {header}", *(render_finding(i) for i in items), ""]

    lines += block("Algorithm changes 2025-2026", sections["changes"][:6])
    lines += block("What drives visibility (current)", sections["drives"][:8])
    lines += block("What kills visibility (current)", sections["kills"][:6])
    lines += block("Self-promotion tolerance (current)", sections["promotion"][:6])
    lines += block("Optimal posting times CST", sections["timing"][:6])

    # Hard-specifics block — numbers, dates, named features
    specifics = harvest_specifics(used_sources)
    if specifics:
        lines.append("### Hard specifics (numbers, dates, named features)")
        for s in specifics:
            sent, entry = s
            lines.append(f"- {sent} (Source: {entry['source_label']} — {entry['url']}, Date: {entry['date_hint']})")
        lines.append("")

    # Source list
    lines.append("### Sources captured")
    for e in used_sources:
        lines.append(f"- [{e['source_label']}]({e['url']}) — captured {e['captured_at']}, hint: {e['date_hint']}")
    lines.append("")
    return "\n".join(lines)


def main():
    entries = load_index()
    by_platform = defaultdict(list)
    for e in entries:
        by_platform[e["platform"]].append(e)

    parts = []
    parts.append("# Platform Algorithm Research — Cited (2025-2026)")
    parts.append("")
    parts.append("**Author:** Atlas")
    parts.append("**Date:** 2026-06-09")
    parts.append("**Method:** PyAutoGUI drove Heath's real, logged-in Chrome through ~36 curated authoritative sources (platform engineering blogs, Adam Mosseri/@creators announcements, Buffer, Hootsuite, Later, Sprout Social, Richard van der Blom's annual LinkedIn study, TikTok Newsroom). Each source's visible text was captured via Ctrl+A → Ctrl+C. Findings below are extracted sentences with source URLs and dates. Raw captures live in `scripts/atlas-runs/atlas-1781029330236/research/captures/`.")
    parts.append("")
    parts.append("**How Sage uses this:** every finding below is canonical. Sage merges these into `docs/sage-engagement-rules-by-platform.md`, REPLACING any generalization she was carrying from training data. If a finding contradicts an existing rule, the cited finding wins.")
    parts.append("")
    parts.append("---")
    parts.append("")

    total_used = 0
    for platform in PLATFORM_ORDER:
        es = by_platform.get(platform, [])
        if not es:
            continue
        sections, used = synthesize_platform(platform, es)
        total_used += len(used)
        parts.append(render_platform(platform, sections, used))
        parts.append("---")
        parts.append("")

    parts.append(f"## Coverage summary")
    parts.append("")
    parts.append(f"- Platforms covered: {sum(1 for p in PLATFORM_ORDER if by_platform.get(p))}")
    parts.append(f"- Total non-blocked sources used: {total_used}")
    parts.append(f"- Total sources attempted: {len(entries)}")
    parts.append(f"- Raw capture dir: `scripts/atlas-runs/atlas-1781029330236/research/captures/`")
    parts.append("")
    parts.append("## Known gaps / flags")
    parts.append("")
    parts.append("- LinkedIn algorithm changes ship constantly — re-run Richard van der Blom's annual study every Jan + Jul.")
    parts.append("- TikTok's For You algorithm has not been formally documented in detail since Newsroom's 'how TikTok recommends content' post. Treat all third-party 'TikTok algorithm in 2026' posts as informed speculation, not source.")
    parts.append("- Meta closed `group_feed` Graph API access in 2024; no public ranking docs exist specifically for Group surfaces. Use Page-feed ranking principles as the proxy until Meta publishes Groups-specific guidance.")
    parts.append("")

    OUT_DOC.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {OUT_DOC} ({sum(len(p) for p in parts)} chars)")


if __name__ == "__main__":
    main()
