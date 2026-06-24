"""Targeted verification of suspicious indices using page-wide text dump."""
import fitz
from pathlib import Path

PDF = fitz.open(r"C:\Users\Heath Shepard\Desktop\MeetDossie\api\_assets\trec-20-18-raw.pdf")

# Get full page text for pages of interest
for page_idx in [0, 1, 2, 3, 4, 5, 7, 8, 9, 10]:  # pages 1-2-...-11 (0-indexed)
    page = PDF[page_idx]
    pw, ph = page.rect.width, page.rect.height
    print(f"\n\n========== PAGE {page_idx + 1} (w={pw:.1f} h={ph:.1f}) ==========")
    blocks = page.get_text("blocks")  # list of (x0,y0,x1,y1,text,block_no,block_type)
    for b in blocks:
        x0, y0, x1, y1, txt, *_ = b
        ynorm = y0 / ph
        if not txt.strip():
            continue
        # Truncate
        snippet = txt.strip().replace("\n", " | ")[:160]
        print(f"  y={ynorm:.3f}  x0={x0/pw:.3f}  {snippet}")
