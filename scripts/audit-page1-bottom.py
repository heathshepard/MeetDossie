"""Inspect page 1 bottom region (y=0.85-0.96) carefully and the widget at idx 21."""
import fitz, json
PDF = fitz.open(r"C:\Users\Heath Shepard\Desktop\MeetDossie\api\_assets\trec-20-18-raw.pdf")
fm = json.load(open(r"C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\trec-20-18-field-map.json", "r", encoding="utf-8"))

page = PDF[0]  # page 1
pw, ph = page.rect.width, page.rect.height

# Get ALL text in y=0.7-0.96 region as "words" with positions
print("=== PAGE 1 words in y=0.65-0.96 region ===\n")
words = page.get_text("words")  # (x0, y0, x1, y1, "word", block_no, line_no, word_no)
for w in words:
    x0, y0, x1, y1, txt, *_ = w
    ynorm = y0 / ph
    if 0.65 <= ynorm <= 0.96:
        print(f"  y={ynorm:.4f} x={x0/pw:.3f}-{x1/pw:.3f}  {txt!r}")

# Also show widgets in same band
print("\n=== Widgets on page 1 with y >= 0.65 ===\n")
for i, w in enumerate(fm):
    if w["page"] == 1 and w["y"] >= 0.65:
        print(f"  idx={i}  y={w['y']:.4f}  x={w['x']:.3f}-{w['x']+w['w']:.3f}  name={w['name'][:60]!r}  maxLen={w.get('maxLength')}")
