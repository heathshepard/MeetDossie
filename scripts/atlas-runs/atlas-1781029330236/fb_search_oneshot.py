"""One-shot FB search + Sage draft + Telegram approval.

Pivot from the group-scanning approach because most groups in
group_registry are 'pending admin approval' for Heath -- the scrape
returns only the group header + about sidebar (500-1000 chars), no
actual feed.

The search surface (facebook.com/search/posts/?q=...) works without
requiring group membership and shows fresh public posts. Diagnostic
run confirmed real content: Anara Tolendi Realtor (Houston, 21h old)
talking about option period pain, plus Heath's own posts (skip those).

Strategy:
1. Try 3 queries in priority order until we find a non-Heath, fresh
   candidate with TC/TREC pain signal.
2. Use the existing relevance.score_text + a Heath-filter.
3. Sage draft via Anthropic API (Sonnet) with the FB Groups voice rules
   (the search-surface comments still post into someone's group/page
   feed -- same cultural rules apply).
4. Insert into engagement_candidates with platform='facebook'.
5. Telegram DossieMarketingBot with Approve/Reject buttons.
6. ONE Claudy summary to Heath.

Does NOT post the comment. Heath taps Approve, then the post_via_chrome
poster (run separately) submits via real Chrome.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import importlib
chrome = importlib.import_module("unified-scanner.chrome")
sb = importlib.import_module("unified-scanner.sb")
relevance = importlib.import_module("unified-scanner.relevance")

load_dotenv(_REPO_ROOT / ".env.local")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
TELEGRAM_MARKETING_BOT_TOKEN = os.getenv("TELEGRAM_MARKETING_BOT_TOKEN", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("fb_search_oneshot")

# ---- Queries in priority order ----
# Each one targets a different TC/TREC pain signal. We try them in order;
# the first one that yields a non-Heath, fresh, qualified candidate wins.
QUERIES = [
    "texas realtor option period",
    "transaction coordinator texas",
    "trec amendment",
    "texas tc help",
]

# Skip these author markers -- we don't comment on ourselves.
HEATH_MARKERS = (
    "heath shepard",
    "kw city view",
    "keller williams city view",
)

VERIFIED_CAPABILITIES = """Dossie's VERIFIED capabilities (only use these in the draft -- do NOT fabricate):

- calculates TREC option period and financing deadlines from the executed date, cited to the TREC paragraph
- drafts TREC amendments from voice (closing date, option extension, price change)
- fills AcroForm fields on TREC PDFs from voice input
- watches the agent's inbox for replies that move the deal forward (e.g. title company sending the CD)
- remembers TREC deadlines, transaction details, agent preferences
- tracks every deal, every deadline, every document
- sends signed packages to title companies, brokers, clients
- reminds the agent, the client, the title rep before the deadline
- organizes every file, every document, every audit trail
- files closed deals into a brokerage-compliant ZIP
- attaches the right form to the right deal automatically
- signs via DossieSign (DocuSeal-backed e-signature)
- scans uploaded PDFs into structured deal data
- alerts when a deadline is in the danger zone
- surfaces the one thing the agent needs to do today
- queues follow-ups that would otherwise fall through

Things Dossie does NOT do (NEVER claim these):
- lead nurture / lead scoring / lead routing
- buying signal detection / AI buyer intent / predictive analytics
- market analysis / CMA generation
- CRM features (contact management, drip campaigns)
- showings scheduling
- MLS integration
"""

SAGE_FB_PROMPT = """You are Sage -- Heath Shepard's Head of Social Media for Dossie.

You are drafting ONE comment that Heath will post on a Facebook post.
Heath built Dossie. He is a Texas REALTOR at Keller Williams City View
in San Antonio. The comment posts from his personal account.

VOICE: Heath is warm, casual, self-deprecating, genuine. Lower-case 'i'
is fine. Contractions. No corporate-speak. Never polished. Reads like a
text from a friend. Founder-as-author -- "I built Dossie because..." NOT
"Dossie helps you..."

FACEBOOK RULES (NON-NEGOTIABLE):
- NO URL, NO meetdossie.com, NO "DM me", NO link of any kind.
- NO hashtags (do nothing in FB).
- NO emojis at all.
- NO em-dashes (use hyphens). No curly quotes. No ellipsis dots.
- NO "Are you tired of...", "Check out", "Limited spots",
  "Game-changer", "Revolutionary", "Excited to announce".
- NO engagement-bait ("comment YES below").
- The pinned post on Heath's profile carries the link -- the comment's
  job is to make a Texas REALTOR curious enough to click his name.
- 100-300 words. Specific. One small story or specific scenario beats
  five generic claims.

PURPOSE OF THE COMMENT (must hit both):
1. Validate the OP's pain / build on their point so they engage with
   you, not your product.
2. Mention 1-3 SPECIFIC Dossie capabilities so a reader who scrolls
   past thinks "wait, that's a thing?" and clicks Heath's profile.

CAPABILITY BEAT:
- Use the VERIFIED capability verb list below. Do NOT invent.
- Each capability you name must include a specific object (TREC option
  period, the title company reply, the executed contract, the
  brokerage compliance ZIP, etc).

{capabilities}

OUTPUT FORMAT:
Return ONLY the comment text. No preamble, no JSON, no quote marks, no
labels. Plain text, plain hyphens, straight quotes, no emojis, no
hashtags, no URLs.

If the post you are commenting on is from Heath himself, or is a sales
post from someone selling a product (not a real agent with a real pain
or a real question), respond with the literal string SKIP and nothing
else. We will not draft on that candidate.
"""


# ---------- Helpers ----------

def call_anthropic(system_prompt: str, user_prompt: str) -> str:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY missing")
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-5",
            "max_tokens": 800,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        },
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    text = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            text += block.get("text", "")
    return text.strip()


def clean_text(text: str) -> str:
    return (
        text
        .replace("—", "-")
        .replace("–", "-")
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("…", "...")
    )


def telegram_send(token: str, chat_id: str, text: str, reply_markup: dict | None = None) -> int | None:
    if not token or not chat_id:
        return None
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text[:4090],
                "disable_web_page_preview": True,
                "reply_markup": reply_markup,
            },
            timeout=15,
        )
        data = r.json()
        return data.get("result", {}).get("message_id")
    except Exception as e:
        log.warning("telegram_send failed: %s", e)
        return None


def search_scrape(query: str) -> str:
    q = urllib.parse.quote(query)
    url = f"https://www.facebook.com/search/posts/?q={q}"
    log.info("Searching FB: %s", url)
    chrome.goto_url(url, settle_seconds=12.0)
    time.sleep(5.0)
    # Scroll to load 3-4 batches of posts.
    for i in range(5):
        chrome.scroll(-1000)
        time.sleep(2.5)
    time.sleep(2.0)
    chrome.scroll_to_top()
    time.sleep(1.5)
    raw = chrome.copy_visible_text()
    log.info("  scraped %d chars from query %s", len(raw or ""), query)
    return raw or ""


def split_search_results(raw_text: str) -> list:
    """Split FB search-results dump into rough per-post blocks.

    Heuristic: each post in the search surface starts with the
    author/group name and a date-ish line, then body. Blank line plus a
    capital-letter line that isn't 'Search results'/'Filters' is a
    reasonable boundary. Easier: split on double newlines and discard
    chrome.
    """
    if not raw_text:
        return []
    parts = []
    # Drop the leading "search results / filters" lines.
    skip_tokens = {"search results", "filters", "transaction coordinator texas",
                   "texas realtor option period", "trec amendment", "texas tc help"}
    blocks = [b.strip() for b in raw_text.replace("\r\n", "\n").split("\n\n") if b.strip()]
    cur = []
    for b in blocks:
        if any(t == b.strip().lower() for t in skip_tokens):
            continue
        cur.append(b)
    # Reassemble into chunks of ~4-7 lines each.
    text = "\n\n".join(cur)
    # Split on " · " date markers ("5 hours ago", "April 28", etc.) by
    # falling back to chunking via two-newline blocks of >= 80 chars.
    chunks = []
    cur_chunk = []
    for line in text.split("\n"):
        cur_chunk.append(line)
        joined = "\n".join(cur_chunk)
        if len(joined) > 200 and (
            "ago" in line.lower() or
            "follow" in line.lower() and len(cur_chunk) > 3
        ):
            # End of this post header section -- next lines are body
            # until we hit another author. For our purposes we just keep
            # accumulating and emit a chunk when length is meaningful.
            pass
        if len(joined) > 600:
            chunks.append(joined)
            cur_chunk = []
    if cur_chunk:
        chunks.append("\n".join(cur_chunk))
    # If chunking failed (too few separators), fall back to a single chunk.
    if not chunks and text:
        chunks = [text]
    return chunks


def extract_author(chunk: str) -> str:
    """Best-effort: first short line that looks like a person/page name."""
    for line in chunk.split("\n"):
        s = line.strip()
        if not s or len(s) > 80:
            continue
        sl = s.lower()
        if any(t in sl for t in ("ago", "yesterday", "today", "follow",
                                  "search facebook", "filters",
                                  "see more", " · ", "shared",
                                  "min", "hr", "now")):
            continue
        # Skip query-echo lines
        if sl in ("search results", "transaction coordinator texas",
                  "texas realtor option period", "trec amendment"):
            continue
        return s[:80]
    return ""


def is_heath_post(chunk: str) -> bool:
    cl = chunk.lower()
    return any(m in cl for m in HEATH_MARKERS)


def best_candidate_from_scrape(raw: str) -> dict | None:
    chunks = split_search_results(raw)
    log.info("  parsed %d candidate chunks", len(chunks))
    ranked = []
    for c in chunks:
        if is_heath_post(c):
            log.info("  skipping Heath self-post chunk")
            continue
        score, matched = relevance.score_text(c)
        # We want at least 4 (so it's not just generic Texas mention).
        # The search-result chunks are short; the matched keywords carry
        # more signal than length.
        if score < 4:
            continue
        ranked.append({
            "score": score,
            "matched": matched,
            "chunk": c,
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    return ranked[0] if ranked else None


def main() -> int:
    if not all([ANTHROPIC_API_KEY, TELEGRAM_MARKETING_BOT_TOKEN,
                TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL,
                SUPABASE_SERVICE_ROLE_KEY]):
        print("Missing env vars", file=sys.stderr)
        return 2

    scanner_run_id = f"fb-search-{uuid.uuid4().hex[:8]}"
    log.info("scanner_run_id=%s", scanner_run_id)

    best = None
    used_query = None
    for q in QUERIES:
        if chrome.kill_switch_check():
            log.error("Kill switch active -- aborting")
            return 4
        try:
            raw = search_scrape(q)
        except Exception as e:
            log.warning("search failed for %s: %s", q, e)
            continue
        cand = best_candidate_from_scrape(raw)
        if cand:
            log.info("  query %r yielded candidate score=%d", q, cand["score"])
            best = cand
            used_query = q
            break
        else:
            log.info("  query %r yielded no qualifying candidate", q)
        time.sleep(2.0)

    if best is None:
        log.warning("No qualifying candidates across %d queries", len(QUERIES))
        print(json.dumps({"ok": False, "reason": "no_candidates"}))
        return 5

    snippet = best["chunk"][:1500].strip()
    author = extract_author(snippet)
    # The "permalink" for a search-surface candidate -- we don't easily
    # have it (FB search doesn't expose post IDs in clipboard scrape).
    # Use the search URL so the poster opens to the same view Heath sees.
    fallback_url = f"https://www.facebook.com/search/posts/?q={urllib.parse.quote(used_query)}"
    log.info("Best candidate: author=%s score=%d query=%r",
             author, best["score"], used_query)
    log.info("Snippet: %s", snippet.replace("\n", " ")[:300])

    # ---- Sage draft ----
    system_prompt = SAGE_FB_PROMPT.format(capabilities=VERIFIED_CAPABILITIES)
    user_prompt = (
        f"Source: Facebook public posts search for query \"{used_query}\"\n"
        f"Author (best-effort): {author or 'unknown'}\n"
        f"Matched signals: {', '.join(best['matched'][:5])}\n\n"
        f"Post text (as scraped):\n\n{snippet}\n\n---\n"
        f"Draft Heath's comment now. If this is not a real REALTOR with a "
        f"real pain or a real teaching point (e.g. it's spam, a job ad, or "
        f"Heath himself), respond with the literal string SKIP and nothing "
        f"else."
    )
    log.info("Calling Sage (Anthropic)...")
    draft_raw = call_anthropic(system_prompt, user_prompt)
    draft = clean_text(draft_raw).strip()
    log.info("Draft (%d chars): %s", len(draft), draft[:200])

    if draft.upper().startswith("SKIP") or len(draft) < 80:
        log.warning("Sage refused or returned short draft; not queueing.")
        print(json.dumps({
            "ok": False, "reason": "sage_refused_or_short",
            "draft_preview": draft[:120],
        }))
        return 6

    # ---- Insert candidate ----
    row = sb.insert_candidate(
        platform="facebook",
        post_url=fallback_url,
        post_text=snippet,
        author_handle=author,
        relevance_score=float(best["score"]),
        matched_keywords=best["matched"],
        scanner_run_id=scanner_run_id,
    )
    if not row or not row.get("id"):
        log.error("insert_candidate returned no row: %s", row)
        return 7
    candidate_id = row["id"]
    log.info("Inserted candidate id=%s", candidate_id)

    sb.update_candidate(candidate_id, {
        "comment_draft": draft,
        "status": "drafted",
    })

    # ---- Telegram approval ----
    matched_brief = ", ".join((best["matched"] or [])[:4])
    context_msg = (
        f"Facebook engagement candidate (score {best['score']})\n"
        f"Source: FB search ({used_query!r})\n"
        f"Matched: {matched_brief}\n"
        f"Author: {author or 'unknown'}\n\n"
        f"\"{snippet[:280].replace(chr(10), ' ').strip()}\"\n\n"
        f"{fallback_url}"
    )
    ctx_id = telegram_send(TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID, context_msg)
    time.sleep(0.8)

    draft_msg = (
        "Draft comment:\n\n"
        f"{draft}\n\n"
        "Approve = post via real Chrome on next poster run."
    )
    reply_markup = {
        "inline_keyboard": [[
            {"text": "Approve", "callback_data": f"eng_approve:{candidate_id}"},
            {"text": "Reject",  "callback_data": f"eng_reject:{candidate_id}"},
        ]],
    }
    draft_id = telegram_send(TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID,
                             draft_msg, reply_markup=reply_markup)

    sb.update_candidate(candidate_id, {
        "status": "sent_for_approval",
        "telegram_sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "telegram_message_id": draft_id,
    })

    # ---- Claudy summary ----
    summary = (
        "Found a real FB candidate. Sage drafted per the rules. "
        "Tap Approve in DossieMarketingBot - comment lands on your real "
        "Chrome after."
    )
    telegram_send(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, summary)

    print(json.dumps({
        "ok": True,
        "candidate_id": candidate_id,
        "author": author,
        "score": best["score"],
        "query": used_query,
        "draft_msg_id": draft_id,
        "context_msg_id": ctx_id,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
