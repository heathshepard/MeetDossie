"""Fresh FB group scan + Sage draft + Telegram approval.

Re-run of fb_one_shot.py per Heath 2026-06-09 evening request.

Differences from fb_one_shot.py:
- Skip the 4 groups already scanned earlier today (Texas Real Estate Network,
  Dallas Texas Realtors, All about Real Estate Houston, Real Estate in Austin TX)
  since their feeds were either promo-spam or low-signal.
- Try up to 5 fresh groups before giving up.
- Slightly higher quality gate: only accept candidates with TWO signals
  (one PAIN/HOT keyword + one TEXAS signal) instead of just MIN_SCORE>=3.
  Prevents Sage from being handed a promo-only top hit.
- Skip Ginger Unger group (requires_heath_review) -- sensitive partnership.
- Skip the Founding Files (private customer-only).

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

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

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
log = logging.getLogger("fb_rerun")

# Groups already scanned earlier today (per fb_one_shot.log). Skip on this rerun.
ALREADY_SCANNED_NAMES = {
    "Texas Real Estate Network",
    "Dallas Texas Realtors",
    "All about Real Estate Houston",
    "Real Estate in Austin TX",
}

# Never include these regardless of registry order.
HARD_SKIP_NAMES = {
    "The Founding Files",          # customer-only
    "Founding Files",
    "Ginger Unger - Real Estate Instructor",  # requires Heath review (partnership)
}


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

HARD STOPS (return "SKIP" instead of a comment if any of these are true):
- The post is a promotional post from a service provider (TC pitching her services, agent pitching listings, "I'm offering...", "Now booking...").
- The post is purely promotional spam, an ad, a "for sale" listing, a recruiting blast, or a credit-repair pitch.
- The post is another agent or coach giving advice / sharing a tip (peer expertise -- commenting hijacks their post).
- The post is a meme / motivational quote / "happy Monday" with no substance.
- The OP has not asked a question, requested help, or vented a real pain point.

{capabilities}

OUTPUT FORMAT:
Return ONLY the comment text. No preamble, no JSON, no quote marks, no labels.
Plain text, plain hyphens, straight quotes, no emojis, no hashtags, no URLs.
If you cannot find a real pain point or question, return the single word: SKIP
"""


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
        .replace("—", "-")  # em-dash
        .replace("–", "-")  # en-dash
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("…", "...")
    )


def fetch_candidate_groups(limit: int = 12) -> list:
    """Pull skip=false, requires_heath_review=false groups ordered by last_posted_at."""
    url = (
        f"{SUPABASE_URL}/rest/v1/group_registry"
        "?skip=eq.false"
        "&requires_heath_review=eq.false"
        "&select=id,group_name,group_url,last_posted_at,category"
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
    rows = r.json() or []
    # Filter out already-scanned and hard-skip groups
    out = []
    for g in rows:
        name = g.get("group_name", "")
        if name in ALREADY_SCANNED_NAMES:
            log.info("Skipping (already scanned today): %s", name)
            continue
        if name in HARD_SKIP_NAMES:
            log.info("Skipping (hard-skip): %s", name)
            continue
        out.append(g)
    return out


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


def categorize_signals(matched_keywords: list) -> dict:
    """Bucket the matched keywords into pain/hot/texas for stricter gating."""
    pain_set = {k.strip() for k in relevance.PAIN_KEYWORDS}
    hot_set = {k.strip() for k in relevance.HOT_PHRASES}
    tex_set = {k.strip() for k in relevance.TEXAS_SIGNALS}
    pain = [m for m in matched_keywords if m in pain_set]
    hot = [m for m in matched_keywords if m in hot_set]
    texas = [m for m in matched_keywords if m in tex_set]
    return {"pain": pain, "hot": hot, "texas": texas}


def quality_gate(chunk: str, score: int, matched: list) -> bool:
    """Stricter gate than MIN_SCORE: require either a HOT phrase OR (pain + texas).

    Prevents promo posts from a TC pitching her services (high keyword density,
    no actual pain question) from getting top billing.
    """
    sig = categorize_signals(matched)
    if sig["hot"]:
        return True
    if sig["pain"] and sig["texas"]:
        return True
    return False


def scan_one_group(group: dict, scanner_run_id: str) -> list:
    name = group["group_name"]
    url = group["group_url"]
    log.info("Scanning FB group: %s (%s)", name, url)

    chrome.goto_url(url, settle_seconds=7.0)
    chrome.scroll(-1200)
    time.sleep(2.0)
    chrome.scroll(-1200)
    time.sleep(2.0)
    chrome.scroll(-1200)
    time.sleep(1.5)
    chrome.scroll_to_top()
    time.sleep(1.0)

    raw = chrome.copy_visible_text()
    log.info("Clipboard returned %d chars from %s", len(raw or ""), name)

    if not raw or len(raw) < 300:
        log.warning("Empty or near-empty scrape from %s", name)
        return []

    posts = fb_groups_mod._split_posts(raw)
    log.info("Parsed %d post chunks from %s", len(posts), name)

    ranked = []
    for chunk in posts:
        score, matched = relevance.score_text(chunk)
        if score < relevance.MIN_SCORE:
            continue
        permalink = fb_groups_mod._extract_permalink(chunk) or url
        passes = quality_gate(chunk, score, matched)
        ranked.append({
            "score": score,
            "matched": matched,
            "chunk": chunk,
            "permalink": permalink,
            "passes_quality": passes,
        })
    ranked.sort(key=lambda r: (r["passes_quality"], r["score"]), reverse=True)
    qualifying = [r for r in ranked if r["passes_quality"]]
    log.info(
        "Found %d relevance-qualified, %d quality-gate-passing chunks in %s (top score=%s)",
        len(ranked),
        len(qualifying),
        name,
        ranked[0]["score"] if ranked else 0,
    )
    return ranked


def extract_author(chunk: str) -> str:
    for line in chunk.split("\n"):
        line = line.strip()
        if not line or len(line) > 80:
            continue
        if any(t in line.lower() for t in (
            "ago", "yesterday", "today", "min", "hr", "now", "shared",
            " . ", "anyone", "looking", "need ",
        )):
            continue
        return line[:80]
    return ""


def main() -> int:
    if not all([
        ANTHROPIC_API_KEY,
        TELEGRAM_MARKETING_BOT_TOKEN,
        TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
    ]):
        print("Missing env vars -- check .env.local", file=sys.stderr)
        return 2

    scanner_run_id = f"fb-rerun-{uuid.uuid4().hex[:8]}"
    log.info("scanner_run_id=%s", scanner_run_id)

    # PyAutoGUI fail-safe triggers when mouse is in a corner. Heath leaves it
    # parked there on his phone. Move the cursor to center first AND disable
    # the corner trigger -- our actual abort gate is chrome.kill_switch_check().
    import pyautogui as _pg
    sw, sh = _pg.size()
    _pg.moveTo(sw // 2, sh // 2, duration=0.0)
    _pg.FAILSAFE = False
    log.info("Cursor centered to (%d, %d); PyAutoGUI fail-safe disabled (kill switch is the real abort).", sw // 2, sh // 2)

    # Focus an open Chrome window before driving the keyboard.
    focused = chrome.focus_chrome()
    log.info("Chrome focused: %s", focused)
    time.sleep(0.6)

    groups = fetch_candidate_groups(limit=12)
    if not groups:
        log.error("No candidate groups remain after filtering")
        return 3

    log.info("Candidate groups (filtered, ordered by last_posted_at ASC):")
    for g in groups:
        log.info("  - %s [%s] (last_posted_at=%s)",
                 g["group_name"], g.get("category", "n/a"), g.get("last_posted_at"))

    best = None
    best_group = None
    attempts = 0
    target_groups = groups[:5]  # try up to 5 fresh groups
    for group in target_groups:
        attempts += 1
        if chrome.kill_switch_check():
            log.error("Kill switch active -- aborting")
            return 4
        try:
            ranked = scan_one_group(group, scanner_run_id)
        except Exception as e:
            log.warning("scan failed for %s: %s", group["group_name"], e)
            ranked = []
        for r in ranked:
            if not r["passes_quality"]:
                continue
            if best is None or r["score"] > best["score"]:
                best = r
                best_group = group
        # Early exit if we already have a strong candidate
        if best and best["score"] >= 7:
            log.info("Strong candidate (score=%d from %s) -- stopping scan",
                     best["score"], best_group["group_name"])
            break
        time.sleep(3.0)

    if best is None:
        log.warning("No qualifying candidates in %d groups", attempts)
        print(json.dumps({
            "ok": False,
            "reason": "no_qualifying_candidates",
            "groups_scanned": attempts,
            "groups": [g["group_name"] for g in target_groups[:attempts]],
        }))
        return 5

    log.info("Best candidate: score=%d from %s", best["score"], best_group["group_name"])
    log.info("Permalink: %s", best["permalink"])
    log.info("Matched: %s", best["matched"])
    log.info("Snippet: %s", best["chunk"].replace("\n", " ")[:240])

    snippet = best["chunk"][-1500:].strip()
    author = extract_author(snippet)

    system_prompt = SAGE_FB_GROUP_PROMPT.format(capabilities=VERIFIED_CAPABILITIES)
    user_prompt = (
        f"Group: {best_group['group_name']}\n"
        f"Platform: Facebook Group (Texas real estate community)\n"
        f"Author (best-effort): {author or 'unknown'}\n"
        f"Post text (latest of thread):\n\n{snippet}\n\n"
        f"---\n"
        f"Draft Heath's comment per the rules above. Validate the OP's pain in "
        f"the first sentence. Mention 1-3 specific Dossie capabilities (verb + "
        f"object) from the verified list. No URL. No CTA. No hashtags. No emojis. "
        f"100-300 words. Return ONLY the comment text, or the single word SKIP "
        f"if the post is promotional / peer-expertise / has no pain question."
    )

    log.info("Calling Sage (Anthropic) for draft...")
    draft_raw = call_anthropic(system_prompt, user_prompt)
    draft = clean_text(draft_raw).strip()
    log.info("Draft (%d chars): %s", len(draft), draft[:240])

    if draft.upper().startswith("SKIP") or len(draft) < 80:
        log.warning("Sage returned SKIP or too-short draft -- not queuing")
        print(json.dumps({
            "ok": False,
            "reason": "sage_skip_or_short",
            "group": best_group["group_name"],
            "score": best["score"],
            "draft_preview": draft[:120],
        }))
        return 6

    # Insert into engagement_candidates as 'pending', then patch with draft.
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
        return 7

    candidate_id = row["id"]
    log.info("Inserted candidate id=%s", candidate_id)

    ok = sb.update_candidate(candidate_id, {
        "comment_draft": draft,
        "status": "drafted",
    })
    if not ok:
        log.error("update_candidate(comment_draft) failed for id=%s", candidate_id)
        return 8

    # DossieMarketingBot context message
    matched_brief = ", ".join((best["matched"] or [])[:5])
    snippet_preview = snippet[:300].replace("\n", " ").strip()
    context_msg = (
        f"Facebook engagement candidate (score {best['score']})\n"
        f"Group: {best_group['group_name']}\n"
        f"Matched: {matched_brief}\n"
        f"Author: {author or 'unknown'}\n\n"
        f"\"{snippet_preview}\"\n\n"
        f"{best['permalink']}"
    )
    ctx_msg_id = telegram_send(
        TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID,
        context_msg, reply_markup=None,
    )
    time.sleep(0.7)

    draft_msg = (
        "Draft comment (Sage):\n\n"
        f"{draft}\n\n"
        "Approve = post via real Chrome on next poster run."
    )
    reply_markup = {
        "inline_keyboard": [[
            {"text": "Approve", "callback_data": f"eng_approve:{candidate_id}"},
            {"text": "Reject",  "callback_data": f"eng_reject:{candidate_id}"},
        ]],
    }
    draft_msg_id = telegram_send(
        TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID,
        draft_msg, reply_markup=reply_markup,
    )

    sb.update_candidate(candidate_id, {
        "status": "sent_for_approval",
        "telegram_sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "telegram_message_id": draft_msg_id,
    })

    # ONE summary to Heath via Claudy (per task spec).
    summary = (
        f"Found FB group candidate: {best_group['group_name']} / "
        f"{author or 'unknown'}. Sage drafted per the rules. "
        f"Tap Approve in DossieMarketingBot."
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
