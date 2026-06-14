#!/usr/bin/env python3
"""
Extract FULL text from TREC PDFs, page by page, preserving layout.
"""

import json
from pathlib import Path

try:
    import pypdf
except ImportError:
    import subprocess
    subprocess.check_call(['pip', 'install', 'pypdf'])
    import pypdf

def extract_full_pdf_text(pdf_path, max_preview_lines=100):
    """Extract all text from PDF, page by page."""
    reader = pypdf.PdfReader(pdf_path)
    num_pages = len(reader.pages)

    result = {
        'path': str(pdf_path),
        'num_pages': num_pages,
        'pages': []
    }

    for page_num, page in enumerate(reader.pages, 1):
        text = page.extract_text()

        # Split text into lines
        lines = text.split('\n') if text else []

        result['pages'].append({
            'page_number': page_num,
            'page_dimensions': {
                'width': float(page.mediabox.width),
                'height': float(page.mediabox.height)
            },
            'line_count': len(lines),
            'lines': lines[:max_preview_lines],  # First 100 lines
            'full_text_sample': text[:2000] if text else ''
        })

    return result

def main():
    pdfs = [
        ('TREC-38-7-Buyer-Termination', './Dossie Forms/TREC Base/TREC-38-7-Buyer-Termination.pdf'),
        ('TREC-23-20-New-Home-Incomplete', './Dossie Forms/TREC Base/TREC-23-20-New-Home-Incomplete.pdf'),
        ('TREC-24-20-New-Home-Completed', './Dossie Forms/TREC Base/TREC-24-20-New-Home-Completed.pdf'),
        ('TREC-25-17-Farm-Ranch', './Dossie Forms/TREC Base/TREC-25-17-Farm-Ranch.pdf'),
    ]

    Path('./Engineering').mkdir(exist_ok=True)

    for name, path_str in pdfs:
        path = Path(path_str)
        if not path.exists():
            print(f"SKIP {name}: {path} not found")
            continue

        print(f"\nExtracting {name}...")
        try:
            data = extract_full_pdf_text(path)

            output_file = Path(f'./Engineering/{name}-full-text.json')
            with open(output_file, 'w') as f:
                json.dump(data, f, indent=2)

            print(f"  Pages: {data['num_pages']}")
            print(f"  Saved to: {output_file}")

            # Also print first page for visual verification
            if data['pages']:
                first_page = data['pages'][0]
                print(f"\n  --- PAGE 1 TEXT PREVIEW ---")
                for i, line in enumerate(first_page['lines'][:20]):
                    print(f"  {i+1:3d}: {line[:80]}")

        except Exception as e:
            print(f"ERROR: {e}")
            import traceback
            traceback.print_exc()

if __name__ == '__main__':
    main()
