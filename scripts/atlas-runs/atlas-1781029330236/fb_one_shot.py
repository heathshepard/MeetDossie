"""One-shot FB group scan + Sage draft + Telegram approval.

Per Heath 2026-06-09: fire a REAL FB scan loop NOW.
- Pick the least-recently-posted active group from group_registry (skip
  Ginger Unger -- requires_heath_review=true, sensitive).
- PyAutoGUI drives Heath's real, logged-in Chrome to the group URL.
- Ctrl+A + Ctrl+C scrapes visible text.
- Split into post chunks, score each with relevance.score_text.
- Pick the BEST candidate (highest score, MIN_SCORE >= 3).
- Direct Anthropic API call (Sonnet) drafts a comment in Sage's voice per
  the FB Groups rules (founder voice, NO URL/CTA/hashtags, validates pain,
  names 1-3 verified Dossie capabilities).
- Insert into engagement_candidates with status='drafted'.
- Telegram DossieMarketingBot: two-message context + draft + Approve/Reject
  buttons matching the existing eng_approve / eng_reject callback contract.
- Telegram Claudy: ONE summary message to Heath.

This DOES NOT post. It waits for Heath's Approve tap.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv

# Make the unified-scanner package importable.
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

# Use importlib because the directory name has a hyphen.
import importlib
chrome = importlib.import_module("unified-scanner.chrome")
sb = importlib.import_module("unified-scanner.sb")
fb_groups_mod = importlib.import_module("unified-scanner.fb_groups")
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
log = logging.getLogger("fb_one_shot")

# Verified Dossie capabilities -- the ONLY ones Sage may reference.
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

SAGE_FB_GROUP_PROMPT = """You are Sage -- Heath Shepard's Head of Social Media for Dossie.

You are drafting ONE comment for Heath to post on a Facebook real estate group.
Heath built Dossie. He is a Texas REALTOR. The comment posts from his personal account.

VOICE: Heath is warm, casual, self-deprecating, genuine. Lower-case 'i' is fine.
Contractions. No corporate-speak. Never polished. Reads like a text from a friend.
Founder-as-author -- "I built Dossie because..." NOT "Dossie helps you..."

FACEBOOK GROUPS RULES (NON-NEGOTIABLE):
- NO URL, NO meetdossie.com, NO "DM me", NO link of any kind.
- NO hashtags (do nothing in FB Groups).
- NO emojis at all.
- NO em-dashes (use hyphens). No curly quotes.
- NO "Are you tired of...", "Check out", "Limited spots", "Game-changer", "Revolutionary", "Excited to announce".
- NO engagement-bait ("comment YES below").
- The pinned post on Heath's profile carries the link -- the comment's job is to make a Texas REALTOR curious enough to click his name.
- 100-300 words. Specific. One small story or specific scenario beats five generic claims.

PURPOSE OF THE COMMENT (must hit both):
1. Validate the OP's pain so they engage with you, not your product.
2. Mention 1-3 SPECIFIC Dossie capabilities so a reader who scrolls past thinks "wait, that's a thing?" and Googles Dossie or clicks Heath's profile.

CAPABILITY BEAT:
- Use the VERIFIED capability verb list below. Do NOT invent.
- Verbs: remembers, tracks, drafts, fills, sends, calculates, reminds, organizes, files, attaches, signs, scans, alerts, watches (inbox/deadline), surfaces, queues.
- Each capability you name must include a specific object (TREC option period, the title company reply, the executed contract, the brokerage compliance ZIP, etc).

{capabilities}

OUTPUT FORMAT:
Return ONLY the comment text. No preamble, no JSON, no quote marks, no labels.
Plain text, plain hyphens, straight quotes, no emojis, no hashtags, no URLs.
"""


def call_anthropic(system_prompt: str, user_prompt: str) -> str:
    """Direct Anthropic API call. Use claude-sonnet-4-5 for drafting voice."""
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
    """Strip em-dashes, curly quotes per CLAUDE.md 15.7."""
    return (
        text
        .replace("—", "-")  # em-dash
        .replace("–", "-")  # en-dash
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("…", "...")
    )


def fetch_least_recent_groups(limit: int = 5) -> list:
    """Pull skip=false groups ordered by last_posted_at ASC (NULLS FIRST)."""
    url = (
        f"{SUPABASE_URL}/rest/v1/group_registry"
        "?skip=eq.false"
        "&requires_heath_review=eq.false"  # avoid Ginger Unger group
        "&select=id,group_name,group_url,last_posted_at"
        "&order=last_posted_at.asc.nullsfirst"
        f"&limit={limit}"
    )
    r = requests.get(
        url,
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        },
        timeout=10,
    )
    r.raise_for_status()
    return r.json() or []


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


def scan_one_group(group: dict, scanner_run_id: str) -> list:
    """Scan one group and return ranked candidate chunks.

    Returns list of dicts: [{score, matched, chunk, permalink}, ...]
    sorted by score desc.
    """
    name = group["group_name"]
    url = group["group_url"]
    log.info("Scanning FB group: %s (%s)", name, url)

    chrome.goto_url(url, settle_seconds=7.0)
    # Scroll a bit to load more content
    chrome.scroll(-1200)
    time.sleep(2.0)
    chrome.scroll(-1200)
    time.sleep(2.0)
    chrome.scroll(-1200)
    time.sleep(1.5)
    # Scroll back up a touch so the top of the page is in the clipboard too
    chrome.scroll_to_top()
    time.sleep(1.0)

    raw = chrome.copy_visible_text()
    log.info("Clipboard returned %d chars from %s", len(raw or ""), name)

    if not raw or len(raw) < 300:
        log.warning("Empty or near-empty scrape from %s", name)
        return []

    # Use the existing splitter
    posts = fb_groups_mod._split_posts(raw)
    log.info("Parsed %d post chunks from %s", len(posts), name)

    ranked = []
    for chunk in posts:
        score, matched = relevance.score_text(chunk)
        if score < relevance.MIN_SCORE:
            continue
        permalink = fb_groups_mod._extract_permalink(chunk) or url
        ranked.append({
            "score": score,
            "matched": matched,
            "chunk": chunk,
            "permalink": permalink,
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    log.info("Found %d relevance-qualified chunks in %s (top score=%s)",
             len(ranked), name, ranked[0]["score"] if ranked else 0)
    return ranked


def extract_author(chunk: str) -> str:
    """Best-effort first non-empty short line is usually the author."""
    for line in chunk.split("\n"):
        line = line.strip()
        if not line or len(line) > 80:
            continue
        if any(t in line.lower() for t in ("ago", "yesterday", "today", "min", "hr", "now", "shared", " · ", "anyone", "looking", "need ")):
            continue
        return line[:80]
    return ""


def main() -> int:
    if not all([ANTHROPIC_API_KEY, TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_BOT_TOKEN,
                TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY]):
        print("Missing env vars -- check .env.local", file=sys.stderr)
        return 2

    scanner_run_id = f"fb-one-shot-{uuid.uuid4().hex[:8]}"
    log.info("scanner_run_id=%s", scanner_run_id)

    groups = fetch_least_recent_groups(limit=5)
    if not groups:
        log.error("No active groups found")
        return 3

    log.info("Group candidates (ordered by last_posted_at ASC):")
    for g in groups:
        log.info("  - %s (last_posted_at=%s)", g["group_name"], g.get("last_posted_at"))

    best = None
    best_group = None
    attempts = 0
    # Try up to 4 groups; per task spec, escalate to Cole if 4 yield nothing.
    for group in groups[:4]:
        attempts += 1
        if chrome.kill_switch_check():
            log.error("Kill switch active -- aborting")
            return 4
        try:
            ranked = scan_one_group(group, scanner_run_id)
        except Exception as e:
            log.warning("scan failed for %s: %s", group["group_name"], e)
            ranked = []
        if ranked:
            top = ranked[0]
            if best is None or top["score"] > best["score"]:
                best = top
                best_group = group
            # If we found a very-high-score candidate, stop early
            if best and best["score"] >= 7:
                log.info("High-score candidate (score=%d) -- stopping scan",
                         best["score"])
                break
        time.sleep(3.0)

    if best is None:
        log.warning("No qualifying candidates in %d groups", attempts)
        # Per spec, tell Cole (= stdout / log) -- do NOT ping Heath.
        print(json.dumps({
            "ok": False,
            "reason": "no_qualifying_candidates",
            "groups_scanned": attempts,
        }))
        return 5

    log.info("Best candidate: score=%d from %s", best["score"], best_group["group_name"])
    log.info("Permalink: %s", best["permalink"])
    log.info("Snippet: %s", best["chunk"].replace("\n", " ")[:200])

    # ---- Sage draft via Anthropic ----
    snippet = best["chunk"][-1500:].strip()
    author = extract_author(snippet)

    system_prompt = SAGE_FB_GROUP_PROMPT.format(capabilities=VERIFIED_CAPABILITIES)
    user_prompt = (
        f"Group: {best_group['group_name']}\n"
        f"Platform: Facebook Group (Texas real estate community)\n"
        f"Author (best-effort): {author or 'unknown'}\n"
        f"Post text (latest of thread):\n\n{snippet}\n\n"
        f"---\n"
        f"Draft Heath's comment. Validate the OP's pain in the first sentence. "
        f"Mention 1-3 specific Dossie capabilities (verb + object) from the verified "
        f"list. No URL. No CTA. No hashtags. No emojis. 100-300 words. "
        f"Return ONLY the comment text."
    )

    log.info("Calling Sage (Anthropic) for draft...")
    draft_raw = call_anthropic(system_prompt, user_prompt)
    draft = clean_text(draft_raw).strip()
    log.info("Draft (%d chars): %s", len(draft), draft[:200])

    # ---- Insert into engagement_candidates ----
    row = sb.insert_candidate(
        platform="facebook",
        post_url=best["permalink"],
        post_text=snippet,
        author_handle=author,
        relevance_score=float(best["score"]),
        matched_keywords=best["matched"],
        scanner_run_id=scanner_run_id,
    )
    if not row or not row.get("id"):
        log.error("insert_candidate returned no row: %s", row)
        return 6

    candidate_id = row["id"]
    log.info("Inserted candidate id=%s", candidate_id)

    # PATCH the row with the comment_draft and flip status='drafted'
    ok = sb.update_candidate(candidate_id, {
        "comment_draft": draft,
        "status": "drafted",
    })
    if not ok:
        log.error("update_candidate(comment_draft) failed for id=%s", candidate_id)
        return 7

    # ---- Send approval messages to DossieMarketingBot ----
    matched_brief = ", ".join((best["matched"] or [])[:4])
    context_msg = (
        f"Facebook engagement candidate (score {best['score']})\n"
        f"Group: {best_group['group_name']}\n"
        f"Matched: {matched_brief}\n"
        f"Author: {author or 'unknown'}\n\n"
        f"\"{snippet[:280].replace(chr(10), ' ').strip()}\"\n\n"
        f"{best['permalink']}"
    )
    ctx_msg_id = telegram_send(TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID,
                               context_msg, reply_markup=None)
    time.sleep(0.7)

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
    draft_msg_id = telegram_send(TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID,
                                 draft_msg, reply_markup=reply_markup)

    # Flip status='sent_for_approval' + record telegram_message_id
    sb.update_candidate(candidate_id, {
        "status": "sent_for_approval",
        "telegram_sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "telegram_message_id": draft_msg_id,
    })

    # ---- ONE summary message to Heath via Claudy ----
    summary = (
        "Found a real FB candidate. Sage drafted per the rules. "
        "Tap Approve in DossieMarketingBot - comment lands on your real Chrome after."
    )
    telegram_send(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, summary, reply_markup=None)

    print(json.dumps({
        "ok": True,
        "candidate_id": candidate_id,
        "group": best_group["group_name"],
        "score": best["score"],
        "permalink": best["permalink"],
        "draft_message_id": draft_msg_id,
        "context_message_id": ctx_msg_id,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
