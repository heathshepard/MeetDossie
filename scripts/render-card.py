"""Vercel Serverless Function: /api/render-card

Renders a branded Dossie social card using the "Concept B — stat anchor"
layout and uploads it to Supabase Storage `social-cards` bucket. Returns the
public URL.

Layout (top to bottom on a solid blush canvas):
  1. Big stat line — serif (Cormorant Garamond), persona-colored.
     • brenda   → coral  (#E8836B)
     • patricia → sage   (#8BA888)
     • victor   → navy   (#1A1A2E)
     • default  → coral
  2. Stat label — sans, 18px navy, one line of "what the number means."
  3. Gold left-bar quote block — 4px vertical bar (#C9A96E), then the post
     body in #444 sans, line-height 1.65.
  4. Bottom row, space-between:
     • Left:  pill badge "Founding · {N} spots left" (gold bg, white text).
     • Right: meetdossie.com/founding (sage, medium weight).
  5. 1px border (#D4A0A0) inset from the canvas edges with 16px radius.

Auth: Authorization: Bearer ${CRON_SECRET}
Method: POST
Body: {
  "platform":   "instagram" | "facebook",
  "hook":       "<headline>",            // optional, used as fallback for stat
  "content":    "<body copy>",           // optional, used as fallback for label/body
  "persona":    "brenda" | "patricia" | "victor" | null,
  "post_id":    "<deterministic id used as the storage filename>",
  "stat":       "<short anchor — number or ≤4-word phrase>",  // optional
  "stat_label": "<one sentence explaining the stat>"          // optional
}
Response: { "ok": true, "publicUrl": "https://...supabase.co/.../public/social-cards/{post_id}.png" }
"""
import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ─── Brand palette ───────────────────────────────────────────────────────
BLUSH        = (245, 230, 224)   # #F5E6E0  card background
BLUSH_DEEP   = (212, 160, 160)   # #D4A0A0  border
CORAL        = (232, 131, 107)   # #E8836B  brenda stat color, default stat color
SAGE         = (139, 168, 136)   # #8BA888  patricia stat color, footer URL
NAVY         = (26, 26, 46)      # #1A1A2E  victor stat color, stat label
GOLD         = (201, 169, 110)   # #C9A96E  quote bar, founding pill
BODY_INK     = (68, 68, 68)      # #444     quote body
PILL_TEXT    = (255, 255, 255)   # white    pill text

# ─── Asset paths (fonts now in public/ to avoid serverless function size limit) ───
ROOT = Path(__file__).resolve().parent.parent
FONT_SERIF_BOLD     = ROOT / "public" / "fonts" / "CormorantGaramond-Bold.ttf"
FONT_SERIF_SEMIBOLD = ROOT / "public" / "fonts" / "CormorantGaramond-SemiBold.ttf"
# Plus Jakarta Sans is the website's body sans; bundle it instead of relying
# on system DejaVu Sans, which doesn't exist on Vercel's Python runtime
# (load_font was silently falling all the way to PIL.ImageFont.load_default,
# rendering label/body in a tiny bitmap font that ignores the size param).
FONT_SANS           = ROOT / "public" / "fonts" / "PlusJakartaSans-Regular.ttf"
FONT_SANS_BOLD      = ROOT / "public" / "fonts" / "PlusJakartaSans-Bold.ttf"
# True absolute-fallback paths (Linux-only). Used by load_font's except clause
# only if the bundled font is missing — kept for defense-in-depth, though we
# never want to hit them in production.
FONT_FALLBACK_SANS_BOLD    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_FALLBACK_SANS         = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

PLATFORM_DIMS = {
    "instagram": (1080, 1080),
    "facebook":  (1200, 630),
}

PERSONA_STAT_COLOR = {
    "brenda":   CORAL,
    "patricia": SAGE,
    "victor":   NAVY,
}

SUPABASE_URL              = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
CRON_SECRET               = os.environ.get("CRON_SECRET", "")
FOUNDING_SPOTS_REMAINING  = os.environ.get("FOUNDING_SPOTS_REMAINING", "50")
STORAGE_BUCKET            = "social-cards"


# ─── Rendering primitives ────────────────────────────────────────────────

def load_font(path, size: int):
    try:
        return ImageFont.truetype(str(path), size=size)
    except (OSError, IOError):
        fb = FONT_FALLBACK_SANS_BOLD if "Bold" in str(path) else FONT_FALLBACK_SANS
        try:
            return ImageFont.truetype(fb, size=size)
        except (OSError, IOError):
            return ImageFont.load_default()


def text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def wrap_to_width(draw, text, font, max_width):
    out = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            out.append("")
            continue
        words = paragraph.split()
        line = ""
        for w in words:
            cand = (line + " " + w).strip()
            if text_size(draw, cand, font)[0] <= max_width:
                line = cand
            else:
                if line:
                    out.append(line)
                line = w
        if line:
            out.append(line)
    return out


def fit_font_size(draw, text, font_path, max_width, max_height,
                  start, min_size=14, line_spacing=1.2):
    """Binary search the largest font size that fits text inside the box."""
    lo, hi = min_size, start
    best = (load_font(font_path, min_size), [], 0)
    while lo <= hi:
        mid = (lo + hi) // 2
        f = load_font(font_path, mid)
        lines = wrap_to_width(draw, text, f, max_width)
        line_h = text_size(draw, "Hg", f)[1]
        total_h = int(len(lines) * line_h * line_spacing)
        if total_h <= max_height and all(text_size(draw, ln, f)[0] <= max_width for ln in lines if ln):
            best = (f, lines, total_h)
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def draw_lines(draw, lines, font, x, y, color, line_spacing=1.2):
    line_h = text_size(draw, "Hg", font)[1]
    step = int(line_h * line_spacing)
    for ln in lines:
        if ln:
            draw.text((x, y), ln, font=font, fill=color)
        y += step
    return y


# ─── Layout: Concept B (stat anchor) ─────────────────────────────────────

def derive_stat_and_label(stat, stat_label, hook, content):
    """Best-effort fallback when the generator didn't include stat/stat_label."""
    if stat:
        s = stat.strip()
    elif hook:
        # Use the first sentence of hook as stat.
        s = hook.split(".")[0].strip()
        # Trim to ~4 words / 28 chars so we don't blow up the giant serif.
        words = s.split()
        if len(words) > 5:
            s = " ".join(words[:5])
        if len(s) > 30:
            s = s[:28].rstrip() + "…"
    elif content:
        s = (content.split(".")[0] or content)[:30].rstrip()
    else:
        s = "Dossie"

    if stat_label:
        l = stat_label.strip()
    elif hook and (not stat or stat != hook):
        l = hook.strip()
    elif content:
        # Use the first short line of content as the label.
        first = content.strip().split("\n", 1)[0]
        l = first
    else:
        l = "Your AI transaction coordinator for Texas real estate."
    return s, l


def font_line_step(font, line_spacing=1.0):
    """Return the vertical advance (px) per line using the font's true
    metrics. ascent + descent gives the "EM box height" — what the type
    designer intended as the natural line height. We multiply by
    line_spacing on top. Using getmetrics avoids the descender-clipping
    problem that "Hg" textbbox produces for serifs with deep descenders.
    """
    try:
        ascent, descent = font.getmetrics()
        natural = ascent + descent
    except Exception:
        natural = text_size(ImageDraw.Draw(Image.new("RGB", (1, 1))), "Hg", font)[1]
    return int(natural * line_spacing)


def draw_lines_metric(draw, lines, font, x, y, color, line_spacing=1.0):
    """Like draw_lines but uses font.getmetrics()-based stepping so
    descenders never collide with the next block."""
    step = font_line_step(font, line_spacing)
    for ln in lines:
        if ln:
            draw.text((x, y), ln, font=font, fill=color)
        y += step
    return y


def render_card_png(platform, hook, content, persona, stat=None, stat_label=None):
    """Render the card and return PNG bytes."""
    if platform not in PLATFORM_DIMS:
        raise ValueError(f"unsupported platform '{platform}'")
    W, H = PLATFORM_DIMS[platform]

    canvas = Image.new("RGB", (W, H), BLUSH)
    draw = ImageDraw.Draw(canvas)

    # Border: 1px BLUSH_DEEP rounded rectangle inset 12px from the edges.
    inset = 12
    radius = 16
    try:
        draw.rounded_rectangle(
            [(inset, inset), (W - inset, H - inset)],
            radius=radius, outline=BLUSH_DEEP, width=1,
        )
    except (AttributeError, TypeError):
        draw.rectangle([(inset, inset), (W - inset, H - inset)], outline=BLUSH_DEEP, width=1)

    is_ig = (platform == "instagram")
    margin_x = int(W * 0.07)
    pad_top  = int(H * (0.09 if is_ig else 0.10))
    pad_bot  = int(H * (0.08 if is_ig else 0.10))
    content_left = margin_x
    content_right = W - margin_x
    content_w = content_right - content_left

    stat_color = PERSONA_STAT_COLOR.get((persona or "").lower(), CORAL)
    derived_stat, derived_label = derive_stat_and_label(stat, stat_label, hook, content)

    # ─── Stat line (big serif, persona-colored) ──────────────────────────
    # Target ~96px instagram / 72px facebook; binary-search down to 56 if
    # the stat is too wide for one line at target.
    stat_target = 96 if is_ig else 72
    stat_max_h = int(H * (0.32 if is_ig else 0.40))
    stat_font, stat_lines, _ = fit_font_size(
        draw, derived_stat, FONT_SERIF_BOLD,
        content_w, stat_max_h, stat_target, min_size=56, line_spacing=1.05,
    )
    if len(stat_lines) > 2:
        stat_lines = stat_lines[:2]
        if not stat_lines[1].endswith("…"):
            stat_lines[1] = stat_lines[1].rstrip(".") + "…"
    stat_y = pad_top
    stat_end_y = draw_lines_metric(draw, stat_lines, stat_font, content_left,
                                   stat_y, stat_color, line_spacing=1.05)

    # ─── Stat label (sans, navy, one sentence) ───────────────────────────
    label_gap = int(H * (0.025 if is_ig else 0.030))   # generous gap so serif descenders breathe
    label_size = 28 if is_ig else 22
    label_font = load_font(FONT_SANS, label_size)
    label_lines = wrap_to_width(draw, derived_label, label_font, content_w)
    if len(label_lines) > 2:
        label_lines = label_lines[:2]
        if not label_lines[1].endswith("…"):
            label_lines[1] = label_lines[1].rstrip(".") + "…"
    label_end_y = draw_lines_metric(draw, label_lines, label_font, content_left,
                                    stat_end_y + label_gap, NAVY, line_spacing=1.30)

    # ─── Bottom row geometry (compute first so quote knows its ceiling) ──
    pill_h = int(H * (0.060 if is_ig else 0.090))
    bottom_row_y = H - pad_bot - pill_h

    # ─── Gold left-bar quote (the post body) ─────────────────────────────
    quote_top = label_end_y + int(H * (0.05 if is_ig else 0.05))
    quote_bottom = bottom_row_y - int(H * (0.05 if is_ig else 0.05))
    quote_h_avail = max(quote_bottom - quote_top, int(H * 0.10))
    bar_w = 4
    bar_x = content_left
    quote_text_x = content_left + bar_w + int(W * 0.020)
    quote_text_w = content_right - quote_text_x

    body_text = (content or hook or "").strip()
    quote_size = 30 if is_ig else 22
    quote_font = load_font(FONT_SANS, quote_size)
    quote_lines = wrap_to_width(draw, body_text, quote_font, quote_text_w)

    quote_step = font_line_step(quote_font, 1.65)
    max_quote_lines = max(1, quote_h_avail // quote_step)
    if len(quote_lines) > max_quote_lines:
        quote_lines = quote_lines[:max_quote_lines]
        if quote_lines and not quote_lines[-1].endswith("…"):
            quote_lines[-1] = quote_lines[-1].rstrip(".") + "…"
    rendered_quote_h = len(quote_lines) * quote_step

    # Gold left bar spans the actual rendered quote height.
    if rendered_quote_h > 0:
        draw.rectangle(
            [(bar_x, quote_top), (bar_x + bar_w, quote_top + rendered_quote_h)],
            fill=GOLD,
        )
    y = quote_top
    for ln in quote_lines:
        if ln:
            draw.text((quote_text_x, y), ln, font=quote_font, fill=BODY_INK)
        y += quote_step

    # ─── Bottom row: pill (left) + URL (right), space-between ────────────
    pill_text = f"Founding · {FOUNDING_SPOTS_REMAINING} spots left"
    pill_size = 22 if is_ig else 20
    pill_font = load_font(FONT_SANS_BOLD, pill_size)
    pill_text_w, pill_text_h = text_size(draw, pill_text, pill_font)
    pill_pad_x = int(pill_h * 0.55)
    pill_w = pill_text_w + pill_pad_x * 2
    pill_radius = pill_h // 2
    try:
        draw.rounded_rectangle(
            [(content_left, bottom_row_y), (content_left + pill_w, bottom_row_y + pill_h)],
            radius=pill_radius, fill=GOLD,
        )
    except (AttributeError, TypeError):
        draw.rectangle(
            [(content_left, bottom_row_y), (content_left + pill_w, bottom_row_y + pill_h)],
            fill=GOLD,
        )
    pill_text_y = bottom_row_y + (pill_h - pill_text_h) // 2 - max(2, pill_text_h // 8)
    draw.text((content_left + pill_pad_x, pill_text_y), pill_text, font=pill_font, fill=PILL_TEXT)

    url_text = "meetdossie.com/founding"
    url_size = 24 if is_ig else 22
    url_font = load_font(FONT_SANS_BOLD, url_size)
    url_w, url_h = text_size(draw, url_text, url_font)
    url_x = content_right - url_w
    url_y = bottom_row_y + (pill_h - url_h) // 2 - max(2, url_h // 8)
    draw.text((url_x, url_y), url_text, font=url_font, fill=SAGE)

    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ─── Supabase Storage upload ─────────────────────────────────────────────

def upload_to_storage(png_bytes, object_path):
    """PUT the PNG to Storage with upsert. Returns the public URL on success."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    object_path = urllib.parse.quote(object_path, safe="/")
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{object_path}"
    req = urllib.request.Request(
        upload_url,
        data=png_bytes,
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "image/png",
            "x-upsert": "true",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status not in (200, 201):
                raise RuntimeError(f"Storage upload returned {r.status}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"Storage upload HTTP {e.code}: {body[:300]}") from e
    return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{object_path}"


# ─── Vercel handler ──────────────────────────────────────────────────────

from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Auth
        auth = self.headers.get("Authorization", "") or self.headers.get("authorization", "")
        if not CRON_SECRET or auth != f"Bearer {CRON_SECRET}":
            return self._send_json(401, {"ok": False, "error": "Unauthorized"})

        # Parse body
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else ""
            body = json.loads(raw) if raw else {}
        except Exception as e:
            return self._send_json(400, {"ok": False, "error": f"bad JSON body: {e}"})

        platform   = (body.get("platform") or "").lower()
        hook       = body.get("hook") or ""
        content    = body.get("content") or ""
        persona    = (body.get("persona") or "").lower() or None
        post_id    = body.get("post_id") or ""
        stat       = body.get("stat") or ""
        stat_label = body.get("stat_label") or ""

        if platform not in PLATFORM_DIMS:
            return self._send_json(400, {"ok": False, "error": f"platform must be instagram or facebook, got '{platform}'"})
        if not content and not hook and not stat:
            return self._send_json(400, {"ok": False, "error": "content, hook, or stat required"})
        if not post_id:
            return self._send_json(400, {"ok": False, "error": "post_id required (used as storage filename)"})

        # Sanitize post_id for use as object path.
        safe_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in post_id)[:120]
        object_path = f"{platform}/{safe_id}.png"

        try:
            png_bytes = render_card_png(platform, hook, content, persona, stat, stat_label)
            public_url = upload_to_storage(png_bytes, object_path)
        except Exception as e:
            return self._send_json(500, {"ok": False, "error": f"render or upload failed: {e}"})

        return self._send_json(200, {
            "ok": True,
            "publicUrl": public_url,
            "platform": platform,
            "size_bytes": len(png_bytes),
            "storage_path": object_path,
        })

    def do_GET(self):
        font_status = {}
        for name, p in [
            ("serif_bold", FONT_SERIF_BOLD),
            ("serif_semibold", FONT_SERIF_SEMIBOLD),
            ("sans", FONT_SANS),
            ("sans_bold", FONT_SANS_BOLD),
        ]:
            font_status[name] = {"path": str(p), "exists": p.exists(), "size": p.stat().st_size if p.exists() else None}
        # Walk a few candidate locations — figure out where Vercel actually
        # parked the bundled assets.
        listings = {}
        for label, p in [
            ("ROOT", ROOT),
            ("ROOT/Media", ROOT / "Media"),
            ("ROOT/Media/_fonts", ROOT / "Media" / "_fonts"),
            ("__file__.parent", Path(__file__).resolve().parent),
            ("__file__.parent/_fonts", Path(__file__).resolve().parent / "_fonts"),
            ("/var/task", Path("/var/task")),
            ("/var/task/Media", Path("/var/task/Media")),
        ]:
            try:
                if p.exists():
                    listings[label] = sorted([x.name for x in p.iterdir()])[:30]
                else:
                    listings[label] = "(does not exist)"
            except Exception as e:
                listings[label] = f"(error: {e})"
        return self._send_json(200, {"ok": True, "service": "render-card",
                                     "platforms": list(PLATFORM_DIMS.keys()),
                                     "design": "concept-b-stat-anchor",
                                     "root": str(ROOT),
                                     "fonts": font_status,
                                     "fs_listings": listings})


# ─── CLI mode (for Node.js child_process spawn) ─────────────────────────

def main():
    """
    CLI usage:
      python scripts/render-card.py '{"platform":"instagram","post_id":"abc123","hook":"...","content":"...","persona":"brenda","stat":"...","stat_label":"..."}'

    Reads JSON from first argument, generates card, uploads to Supabase Storage,
    prints public URL to stdout.
    """
    import sys

    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: render-card.py '<json>'"}), file=sys.stderr)
        sys.exit(1)

    try:
        body = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}), file=sys.stderr)
        sys.exit(1)

    platform   = (body.get("platform") or "").lower()
    hook       = body.get("hook") or ""
    content    = body.get("content") or ""
    persona    = (body.get("persona") or "").lower() or None
    post_id    = body.get("post_id") or ""
    stat       = body.get("stat") or ""
    stat_label = body.get("stat_label") or ""

    if platform not in PLATFORM_DIMS:
        print(json.dumps({"ok": False, "error": f"platform must be instagram or facebook, got '{platform}'"}), file=sys.stderr)
        sys.exit(1)
    if not content and not hook and not stat:
        print(json.dumps({"ok": False, "error": "content, hook, or stat required"}), file=sys.stderr)
        sys.exit(1)
    if not post_id:
        print(json.dumps({"ok": False, "error": "post_id required"}), file=sys.stderr)
        sys.exit(1)

    # Sanitize post_id for storage path
    safe_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in post_id)[:120]
    object_path = f"{platform}/{safe_id}.png"

    try:
        png_bytes = render_card_png(platform, hook, content, persona, stat, stat_label)
        public_url = upload_to_storage(png_bytes, object_path)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)

    # Success — print JSON to stdout
    result = {
        "ok": True,
        "publicUrl": public_url,
        "platform": platform,
        "size_bytes": len(png_bytes),
        "storage_path": object_path,
    }
    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
