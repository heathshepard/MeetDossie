"""Round 3 anchor scanner — exhaustive label scan across every page of each base PDF.

Dumps a JSON file per form with every hit for every interesting anchor label.
Used as the input to build_coords.py which writes the field-map JSON files.
"""
import fitz
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
EARLIER = ROOT / "Engineering" / "quinn-verify-renders-2026-06-14"
OUT = Path(__file__).parent

# Per-form anchor lists. Page-wide scans — capture every hit, every page.
LABELS = {
    "trec-38-7": [
        "(Street Address and City)",
        "(SELLER)",
        "BETWEEN THE UNDERSIGNED BUYER",
        "Date",
        "Buyer",
        "Seller",
        "Option Period",
        "any financing",
        "Property Approval",
        "Homeowners' Association",
        "Seller's Disclosure",
        "lender's appraisal",
        "Other",
    ],
    "trec-23-20": [
        "(Seller)",
        "(Buyer)",
        "Lot",
        "Block",
        "Addition, City of",
        "County of",
        "(address/zip code)",
        "Cash portion of Sales Price",
        "Sum of A and B",
        "Sales Price",
        "delivered to escrow",
        "DELIVERY OF EARNEST MONEY",
        "earnest money",
        "Option Fee",
        "Closing Date",
        "Escrow Agent",
        "Title Company",
        "Buyer's Lender",
        "Listing Broker",
        "Other Broker",
        "Buyer's Address",
        "Seller's Address",
        "days after",
    ],
    "trec-24-20": [
        "(Seller)",
        "(Buyer)",
        "Lot",
        "Block",
        "Addition, City of",
        "County of",
        "(address/zip code)",
        "Cash portion of Sales Price",
        "Sum of A and B",
        "Sales Price",
        "delivered to escrow",
        "DELIVERY OF EARNEST MONEY",
        "earnest money",
        "Option Fee",
        "Closing Date",
        "Escrow Agent",
        "Title Company",
        "Buyer's Lender",
        "Listing Broker",
        "Other Broker",
        "Buyer's Address",
        "Seller's Address",
        "days after",
    ],
    "trec-25-17": [
        "(Seller)",
        "(Buyer)",
        "(address/zip code)",
        "Cash portion of Sales Price",
        "Sales Price",
        "Sum of A and B",
        "acres",
        "Property",
        "in the County",
        "County of",
        "County, Texas",
        "Closing Date",
        "Escrow Agent",
        "Title Company",
        "Buyer's Lender",
        "Listing Broker",
        "Other Broker",
        "Buyer's Address",
        "Seller's Address",
        "DELIVERY OF EARNEST MONEY",
        "earnest money",
        "Option Fee",
        "Section 5",
        "RESERVATIONS",
        "Farm and Ranch",
        "FARM AND RANCH CONTRACT",
    ],
}

PDFS = {
    "trec-38-7": OUT / "base-trec-38-7.pdf",
    "trec-23-20": OUT / "base-trec-23-20.pdf",
    "trec-24-20": OUT / "base-trec-24-20.pdf",
    "trec-25-17": OUT / "base-trec-25-17.pdf",
}


def scan(form_id, pdf_path, labels):
    out = {"form": form_id, "pdf": pdf_path.name, "pages": 0, "labels": {}, "all_text_per_page": {}}
    doc = fitz.open(str(pdf_path))
    out["pages"] = doc.page_count
    out["page_size"] = (doc[0].rect.width, doc[0].rect.height)

    for label in labels:
        hits = []
        for pno in range(doc.page_count):
            page = doc[pno]
            for r in page.search_for(label):
                hits.append({
                    "page": pno + 1,
                    "x0": round(r.x0, 2),
                    "y0": round(r.y0, 2),
                    "x1": round(r.x1, 2),
                    "y1": round(r.y1, 2),
                })
        out["labels"][label] = hits

    # Also dump words on page 1 for visual debugging
    page1 = doc[0]
    words1 = []
    for w in page1.get_text("words"):
        x0, y0, x1, y1, txt, *_ = w
        words1.append({"x0": round(x0, 1), "y0": round(y0, 1), "x1": round(x1, 1), "y1": round(y1, 1), "text": txt})
    out["page1_words"] = words1
    doc.close()
    return out


def main():
    for form_id, pdf_path in PDFS.items():
        labels = LABELS[form_id]
        result = scan(form_id, pdf_path, labels)
        out_file = OUT / f"anchors-{form_id}.json"
        out_file.write_text(json.dumps(result, indent=2))
        print(f"{form_id}: {result['pages']} pages, {sum(len(v) for v in result['labels'].values())} hits -> {out_file.name}")


if __name__ == "__main__":
    main()
