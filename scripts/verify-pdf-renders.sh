#!/bin/bash

# Convert sample PDFs to PNG for visual inspection
OUTPUT_DIR="Engineering/trec-fill-samples-2026-06-14"

echo "Converting PDF samples to PNG for visual inspection..."

# Test if pdftoppm is available
if ! command -v pdftoppm &> /dev/null; then
    echo "ERROR: pdftoppm not found. Install poppler-utils: apt-get install poppler-utils"
    exit 1
fi

for pdf in "$OUTPUT_DIR"/*.pdf; do
    filename=$(basename "$pdf" .pdf)
    pngfile="$OUTPUT_DIR/${filename}-page1.png"
    echo "Converting $filename..."
    pdftoppm -png -f 1 -l 1 "$pdf" "${pngfile%.png}"
done

echo "Conversion complete. PNG files available for inspection."
