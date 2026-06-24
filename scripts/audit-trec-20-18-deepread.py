"""
Hadley TREC 20-18 Deep-Read Self-Audit

For each label in trec-20-18-labels-jarvis-deep-read.json:
  - Locate widget coordinates from scripts/trec-20-18-field-map.json (by index)
  - Extract PDF text within +/-50pt vertically and +/-100pt horizontally from widget center
  - Surface the surrounding paragraph context
  - Allow Hadley to compare claimed fixture_key vs actual surrounding text

Output: audit JSON at C:/Users/Heath Shepard/Desktop/trec-20-18-audit-self-pass-2.json
"""
import fitz  # PyMuPDF
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Heath Shepard\Desktop")
PDF_PATH = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\api\_assets\trec-20-18-raw.pdf")
FIELDMAP_PATH = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\trec-20-18-field-map.json")
DEEPREAD_PATH = ROOT / "trec-20-18-labels-jarvis-deep-read.json"
OUT_PATH = ROOT / "trec-20-18-audit-context.json"

if not PDF_PATH.exists():
    print(f"FATAL: PDF not found at {PDF_PATH}", file=sys.stderr)
    sys.exit(1)

doc = fitz.open(str(PDF_PATH))
print(f"PDF loaded: {len(doc)} pages")

with open(FIELDMAP_PATH, "r", encoding="utf-8") as f:
    fieldmap = json.load(f)
print(f"Field map: {len(fieldmap)} widgets")

with open(DEEPREAD_PATH, "r", encoding="utf-8") as f:
    deepread = json.load(f)

labels = deepread.get("labels", [])
corrections = deepread.get("corrections_to_existing_labels", [])
print(f"Deep-read: {len(labels)} primary labels + {len(corrections)} corrections")

VPAD = 25   # vertical padding in points
HPAD = 250  # horizontal padding in points (wide to capture full line)

def extract_context(page_num_0idx, x_norm, y_norm, w_norm=0.0, h_norm=0.0):
    """Return text within a band around the widget's normalized position."""
    if page_num_0idx < 0 or page_num_0idx >= len(doc):
        return None, None
    page = doc[page_num_0idx]
    pw, ph = page.rect.width, page.rect.height
    # Convert normalized to absolute (PyMuPDF y=0 is TOP, which matches PDF widget norm if widget is also top-origin)
    cx = x_norm * pw + (w_norm * pw / 2)
    cy = y_norm * ph + (h_norm * ph / 2)
    band = fitz.Rect(max(0, cx - HPAD), max(0, cy - VPAD), min(pw, cx + HPAD), min(ph, cy + VPAD))
    txt = page.get_text("text", clip=band)
    # Also get a wider band for paragraph context
    wide_band = fitz.Rect(0, max(0, cy - 60), pw, min(ph, cy + 60))
    wide_txt = page.get_text("text", clip=wide_band)
    return txt.strip(), wide_txt.strip()

def widget_info(idx):
    """Return (page_0idx, x, y, w, h, name, type) or None."""
    if idx < 0 or idx >= len(fieldmap):
        return None
    w = fieldmap[idx]
    return (w["page"] - 1, w["x"], w["y"], w.get("w", 0), w.get("h", 0), w.get("name", ""), w.get("type", ""))

# Build report
report = {
    "audited_at": "2026-06-20",
    "audited_by": "hadley",
    "pdf_source": str(PDF_PATH),
    "field_map_source": str(FIELDMAP_PATH),
    "deep_read_source": str(DEEPREAD_PATH),
    "labels_audited": 0,
    "rows": []
}

def audit_one(label, source):
    idx = label.get("index")
    fk = label.get("fixture_key") or label.get("corrected_key") or label.get("proposed_key")
    rationale = label.get("rationale") or label.get("notes") or ""
    page_claimed = label.get("page")
    wi = widget_info(idx)
    if wi is None:
        return {"index": idx, "fixture_key": fk, "source": source, "error": f"index {idx} out of fieldmap range"}
    page0, x, y, w, h, wname, wtype = wi
    page_actual = page0 + 1
    narrow, wide = extract_context(page0, x, y, w, h)
    return {
        "index": idx,
        "source": source,
        "fixture_key": fk,
        "claimed_page": page_claimed,
        "actual_page_from_fieldmap": page_actual,
        "page_mismatch": page_claimed is not None and page_claimed != page_actual,
        "widget_name": wname,
        "widget_type": wtype,
        "x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4),
        "narrow_context": narrow,
        "wide_context": wide,
        "rationale_excerpt": rationale[:300]
    }

for lbl in labels:
    report["rows"].append(audit_one(lbl, "labels"))
for lbl in corrections:
    report["rows"].append(audit_one(lbl, "corrections"))

report["labels_audited"] = len(report["rows"])

with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2, ensure_ascii=False)

print(f"\nWrote audit context to {OUT_PATH}")
print(f"Total rows: {len(report['rows'])}")
page_mismatches = [r for r in report["rows"] if r.get("page_mismatch")]
print(f"Page mismatches: {len(page_mismatches)}")
for pm in page_mismatches[:10]:
    print(f"  idx={pm['index']} fk={pm['fixture_key']} claimed_p={pm['claimed_page']} actual_p={pm['actual_page_from_fieldmap']}")
