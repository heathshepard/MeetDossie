"""FB search-surface scan v2 + Sage draft + Telegram approval.

Pivot from group-feed scrape (which was returning 0-708 chars due to FB's
user-select restrictions on group chrome / Heath not joined). Use the
public-posts search surface, which renders post bodies in the DOM as plain
selectable text -- proven to return 2300+ chars on a single page.

Key differences from fb_search_oneshot.py:
- Clipboard timeout guard (pyperclip can hang on Windows clipboard contention).
- Fail-safe disabled at module load (Heath leaves cursor in corner).
- Pain-first query priority (closing chaos / TC quit / option period) -- skip
  "transaction coordinator texas" which mostly returns TCs pitching services.
- Stricter promo-post filter at the scrape-chunk level (drop chunks matching
  obvious sales phrasing before they reach Sage).
- Sage's SKIP behavior is RESPECTED -- if she returns SKIP we keep trying the
  next candidate in the ranked list before giving up entirely.
- Logs full draft text into a result.json so we can inspect after the fact.

Outputs:
- engagement_candidates row with platform='facebook', status='sent_for_approval'
- DossieMarketingBot context msg + draft msg with eng_approve/eng_reject buttons
- ONE Claudy summary to Heath chat
- result.json with full text of best candidate + draft
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
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
log = logging.getLogger("fb_rerun_v2")

# Pain-first queries -- pure pain language beats role-search language.
# Each one tries to surface a REAL agent venting, not a TC pitching.
QUERIES = [
    "texas option period stress",
    "texas closing nightmare",
    "trec deadline missed",
    "transaction coordinator quit",
    "texas realtor drowning",
    "trec amendment help",
    "texas tc help",
]

HEATH_MARKERS = (
    "heath shepard",
    "kw city view",
    "keller williams city view",
    "meetdossie",
)

# Promo / sales-pitch markers at the chunk level. If a chunk contains too many
# of these, skip it -- it's almost certainly someone selling, not someone in pain.
PROMO_MARKERS = (
    "extending my services",
    "i'm officially",
    "now booking",
    "now taking clients",
    "dm me to book",
    "let me handle",
    "i'm a licensed",
    "licensed transaction coordinator in",
    "offering my services",
    "let me take",
    "schedule a consultation",
    "book me today",
    "i specialize in",
    "open to new clients",
    "accepting new clients",
    "i can help you with",
    "let me know if you need",
    "credit repair",
    "fha approved",
    "first time home buyer credit",
    "💰", "💵", "🔑", "🏡", "🎉",
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

HARD STOPS (return literal "SKIP" if any apply):
- The post is from Heath himself (any reference to KW City View or meetdossie).
- The post is a service-provider promotion -- TC pitching her services,
  agent pitching listings, "I'm offering...", "Now booking...",
  "Licensed Transaction Coordinator extending my services...".
- The post is another agent / coach giving a tip / teaching peer-expertise
  ("hijacking" their post is against Heath's rules).
- The post is a meme / motivational / "happy Monday" / no substance.
- The OP has not actually asked a question or vented a real pain.

{capabilities}

OUTPUT FORMAT:
Return ONLY the comment text. No preamble, no JSON, no quote marks, no
labels. Plain text, plain hyphens, straight quotes, no emojis, no
hashtags, no URLs.

If the post fails any HARD STOP test above, respond with literal SKIP.
"""


# ---------- Clipboard timeout guard ----------

def safe_copy_visible_text(timeout: float = 6.0) -> str:
    """Call chrome.copy_visible_text() in a worker thread with timeout.

    pyperclip.paste() can hang on Windows when the clipboard is held by
    another process. The thread-with-timeout pattern lets us bail out
    rather than freeze the whole script.
    """
    result_box = {"text": ""}

    def worker():
        try:
            result_box["text"] = chrome.copy_visible_text()
        except Exception as e:
            log.warning("copy_visible_text worker exception: %s", e)
            result_box["text"] = ""

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        log.warning("copy_visible_text TIMED OUT after %.1fs", timeout)
        return ""
    return result_box.get("text", "")


# ---------- Anthropic ----------

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


# ---------- Scrape + parse ----------

def ensure_page_focus():
    """After Ctrl+L navigation, focus is in the address bar. Move to page body.

    F6 cycles focus zones in Chrome (address bar -> page -> bookmarks).
    First F6 moves OUT of the address bar. We also click in the page center
    as a backup since FB's content frame sometimes ignores keyboard focus.
    """
    import pyautogui as _pg
    sw, sh = _pg.size()
    # F6 twice: address bar -> page area -> address bar again is a 3-step
    # cycle. One F6 is usually enough to land in the page body.
    _pg.press("f6")
    time.sleep(0.3)
    # Click into the page below the address bar but above the bottom edge.
    # FB's left sidebar is ~360px wide; click in the main feed area.
    _pg.click(x=sw // 2, y=sh // 2)
    time.sleep(0.4)


def search_scrape(query: str) -> str:
    q = urllib.parse.quote(query)
    url = f"https://www.facebook.com/search/posts/?q={q}"
    log.info("Searching FB: %s", url)
    chrome.goto_url(url, settle_seconds=10.0)
    time.sleep(4.0)
    # CRITICAL: after goto_url focus is in address bar -- move to page body.
    ensure_page_focus()
    for i in range(5):
        chrome.scroll(-1000)
        time.sleep(2.0)
    chrome.scroll_to_top()
    time.sleep(1.2)
    # One more focus-confirm before scrape.
    ensure_page_focus()
    raw = safe_copy_visible_text(timeout=8.0)
    if (not raw or len(raw) < 100) and not chrome.kill_switch_check():
        log.info("  first scrape empty -- retrying after second focus")
        time.sleep(1.0)
        ensure_page_focus()
        raw = safe_copy_visible_text(timeout=8.0)
    log.info("  scraped %d chars from query %r", len(raw or ""), query)
    return raw or ""


def split_search_results(raw_text: str) -> list:
    if not raw_text:
        return []
    # Strip leading FB chrome
    skip_tokens = {"search results", "filters", "see more", "posts",
                   "follow", "search facebook"}
    blocks = [b.strip() for b in raw_text.replace("\r\n", "\n").split("\n\n") if b.strip()]
    cur = []
    for b in blocks:
        bl = b.strip().lower()
        if bl in skip_tokens:
            continue
        # Drop the query echo
        for q in QUERIES:
            if bl == q.lower():
                break
        else:
            cur.append(b)
    text = "\n\n".join(cur)
    chunks = []
    cur_chunk = []
    for line in text.split("\n"):
        cur_chunk.append(line)
        joined = "\n".join(cur_chunk)
        if len(joined) > 600:
            chunks.append(joined)
            cur_chunk = []
    if cur_chunk and "\n".join(cur_chunk).strip():
        chunks.append("\n".join(cur_chunk))
    if not chunks and text:
        chunks = [text]
    return chunks


def is_heath_post(chunk: str) -> bool:
    cl = chunk.lower()
    return any(m in cl for m in HEATH_MARKERS)


def is_promo_post(chunk: str) -> tuple[bool, list[str]]:
    cl = chunk.lower()
    hits = [m for m in PROMO_MARKERS if m in cl]
    # Any emoji-marker is an instant promo signal; otherwise need 2+ phrase hits.
    has_emoji = any(m and ord(m[0]) > 0xFFFF for m in hits)
    return (len(hits) >= 2 or has_emoji, hits)


def extract_author(chunk: str) -> str:
    for line in chunk.split("\n"):
        s = line.strip()
        if not s or len(s) > 80:
            continue
        sl = s.lower()
        if any(t in sl for t in (
            "ago", "yesterday", "today", "follow", "search facebook",
            "filters", "see more", " . ", "shared", "min", "hr", "now",
            "posts", "people", "videos", "marketplace",
        )):
            continue
        # Skip query-echo lines
        if sl in [q.lower() for q in QUERIES]:
            continue
        if sl in ("search results",):
            continue
        return s[:80]
    return ""


def best_candidate_from_scrape(raw: str) -> dict | None:
    chunks = split_search_results(raw)
    log.info("  parsed %d candidate chunks", len(chunks))
    ranked = []
    for c in chunks:
        if is_heath_post(c):
            log.info("  skipping Heath self-post chunk")
            continue
        is_promo, promo_hits = is_promo_post(c)
        if is_promo:
            log.info("  skipping promo chunk (hits=%s): %s",
                     promo_hits[:3], c.replace("\n", " ")[:80])
            continue
        score, matched = relevance.score_text(c)
        if score < 4:
            continue
        ranked.append({
            "score": score,
            "matched": matched,
            "chunk": c,
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    return ranked


def write_result(path: Path, payload: dict):
    try:
        path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    except Exception as e:
        log.warning("write_result failed: %s", e)


# ---------- Main ----------

def main() -> int:
    if not all([ANTHROPIC_API_KEY, TELEGRAM_MARKETING_BOT_TOKEN,
                TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL,
                SUPABASE_SERVICE_ROLE_KEY]):
        print("Missing env vars", file=sys.stderr)
        return 2

    # Disable PyAutoGUI fail-safe + center the cursor.
    import pyautogui as _pg
    sw, sh = _pg.size()
    _pg.moveTo(sw // 2, sh // 2, duration=0.0)
    _pg.FAILSAFE = False
    log.info("Cursor centered to (%d, %d); PyAutoGUI fail-safe off.", sw // 2, sh // 2)

    # Focus Chrome (best-effort).
    focused = chrome.focus_chrome()
    log.info("Chrome focused: %s", focused)
    time.sleep(0.6)

    scanner_run_id = f"fb-rerun-v2-{uuid.uuid4().hex[:8]}"
    log.info("scanner_run_id=%s", scanner_run_id)

    result_path = Path(__file__).resolve().parent / "fb_rerun_v2_result.json"

    best = None
    used_query = None
    queries_attempted = []
    for q in QUERIES:
        if chrome.kill_switch_check():
            log.error("Kill switch active -- aborting")
            return 4
        queries_attempted.append(q)
        try:
            raw = search_scrape(q)
        except Exception as e:
            log.warning("search failed for %s: %s", q, e)
            continue
        ranked = best_candidate_from_scrape(raw)
        if ranked:
            log.info("  query %r yielded %d candidates; top score=%d",
                     q, len(ranked), ranked[0]["score"])
            # Try the top candidate; we'll let Sage's SKIP route us further
            # down the list if she rejects the top one.
            best_query_ranked = ranked
            used_query = q
            best = best_query_ranked
            break
        else:
            log.info("  query %r yielded no qualifying candidate", q)
        time.sleep(2.0)

    if best is None:
        log.warning("No qualifying candidates across %d queries", len(queries_attempted))
        write_result(result_path, {
            "ok": False,
            "reason": "no_candidates",
            "queries_attempted": queries_attempted,
        })
        print(json.dumps({"ok": False, "reason": "no_candidates",
                          "queries_attempted": queries_attempted}))
        return 5

    # Try up to TOP-3 candidates against Sage. If she SKIPs all 3 we give up.
    accepted_candidate = None
    accepted_draft = None
    for idx, candidate in enumerate(best[:3]):
        snippet = candidate["chunk"][:1500].strip()
        author = extract_author(snippet)
        log.info("Trying candidate %d/3: author=%s score=%d",
                 idx + 1, author, candidate["score"])
        log.info("  Snippet: %s", snippet.replace("\n", " ")[:300])

        system_prompt = SAGE_FB_PROMPT.format(capabilities=VERIFIED_CAPABILITIES)
        user_prompt = (
            f"Source: Facebook public posts search for query \"{used_query}\"\n"
            f"Author (best-effort): {author or 'unknown'}\n"
            f"Matched signals: {', '.join(candidate['matched'][:5])}\n\n"
            f"Post text (as scraped):\n\n{snippet}\n\n---\n"
            f"Draft Heath's comment now per all rules above. If this post "
            f"fails any HARD STOP test, respond with literal SKIP."
        )
        log.info("Calling Sage (Anthropic) on candidate %d...", idx + 1)
        try:
            draft_raw = call_anthropic(system_prompt, user_prompt)
        except Exception as e:
            log.warning("Anthropic call failed for candidate %d: %s", idx + 1, e)
            continue
        draft = clean_text(draft_raw).strip()
        log.info("Candidate %d draft (%d chars): %s", idx + 1, len(draft), draft[:240])

        if draft.upper().startswith("SKIP") or len(draft) < 80:
            log.info("  -> candidate %d SKIPPED by Sage; trying next.", idx + 1)
            continue

        # Accepted
        accepted_candidate = candidate
        accepted_candidate["snippet"] = snippet
        accepted_candidate["author"] = author
        accepted_draft = draft
        break

    if not accepted_candidate or not accepted_draft:
        log.warning("All top candidates SKIPped by Sage. Reporting no-go.")
        write_result(result_path, {
            "ok": False,
            "reason": "sage_skipped_all_top_candidates",
            "candidates_tried": min(3, len(best)),
            "queries_attempted": queries_attempted,
            "winning_query": used_query,
        })
        print(json.dumps({
            "ok": False,
            "reason": "sage_skipped_all",
            "queries_attempted": queries_attempted,
        }))
        return 6

    snippet = accepted_candidate["snippet"]
    author = accepted_candidate["author"]
    fallback_url = (
        f"https://www.facebook.com/search/posts/?q={urllib.parse.quote(used_query)}"
    )

    # Insert engagement_candidates row.
    row = sb.insert_candidate(
        platform="facebook",
        post_url=fallback_url,
        post_text=snippet,
        author_handle=author,
        relevance_score=float(accepted_candidate["score"]),
        matched_keywords=accepted_candidate["matched"],
        scanner_run_id=scanner_run_id,
    )
    if not row or not row.get("id"):
        log.error("insert_candidate returned no row: %s", row)
        return 7
    candidate_id = row["id"]
    log.info("Inserted candidate id=%s", candidate_id)

    sb.update_candidate(candidate_id, {
        "comment_draft": accepted_draft,
        "status": "drafted",
    })

    # Telegram approval message(s) to DossieMarketingBot.
    matched_brief = ", ".join((accepted_candidate["matched"] or [])[:4])
    context_msg = (
        f"Facebook engagement candidate (score {accepted_candidate['score']})\n"
        f"Source: FB search ({used_query!r})\n"
        f"Matched: {matched_brief}\n"
        f"Author: {author or 'unknown'}\n\n"
        f"\"{snippet[:280].replace(chr(10), ' ').strip()}\"\n\n"
        f"{fallback_url}"
    )
    ctx_id = telegram_send(TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID, context_msg)
    time.sleep(0.8)

    draft_msg = (
        "Draft comment (Sage):\n\n"
        f"{accepted_draft}\n\n"
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

    # ONE Claudy summary to Heath.
    summary = (
        f"Found FB group candidate: FB search ({used_query!r}) / "
        f"{author or 'unknown'}. Sage drafted per the rules. "
        f"Tap Approve in DossieMarketingBot."
    )
    telegram_send(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, summary)

    write_result(result_path, {
        "ok": True,
        "candidate_id": candidate_id,
        "author": author,
        "score": accepted_candidate["score"],
        "matched_keywords": accepted_candidate["matched"],
        "query": used_query,
        "snippet": snippet,
        "draft": accepted_draft,
        "draft_msg_id": draft_id,
        "context_msg_id": ctx_id,
        "fallback_url": fallback_url,
    })

    print(json.dumps({
        "ok": True,
        "candidate_id": candidate_id,
        "author": author,
        "score": accepted_candidate["score"],
        "query": used_query,
        "draft_msg_id": draft_id,
        "context_msg_id": ctx_id,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
