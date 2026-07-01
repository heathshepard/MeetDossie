"""Render a PDF to PNG using PyMuPDF (fitz) — produces accurate appearance-stream rendering.
Usage: python _hadley_fitz_render.py <pdf-in> <png-out-prefix> [dpi]
"""
import sys
import fitz

pdf_in = sys.argv[1]
out_prefix = sys.argv[2]
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150

doc = fitz.open(pdf_in)
mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
for i, page in enumerate(doc, start=1):
    pix = page.get_pixmap(matrix=mat, alpha=False)
    out = f"{out_prefix}-{i:02d}.png"
    pix.save(out)
    print(f"wrote {out}")
print(f"Total pages: {len(doc)}")
