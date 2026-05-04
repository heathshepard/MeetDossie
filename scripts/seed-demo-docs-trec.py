"""Replace demo placeholder PDFs with filled TREC forms.

Strategy by doc type:
  contract            -> cover page (deal data) + blank TREC 20-17 + watermark
  sellers_disclosure  -> TREC OP-H form, TextField1[*] filled with address + watermark
  amendment           -> cover page + blank TREC 39-9 + watermark
  everything else     -> styled FPDF placeholder + watermark (same as before)

The 20-17 and 39-9 forms TREC publishes are flat PDFs with no AcroForm fields,
so we can't field-fill them. Cover-page-then-blank-form is the closest we can
get without a fragile pixel-coordinate text overlay.

Pipeline per document:
  1. Build the body PDF (cover + form OR filled form) in memory
  2. Apply a diagonal "DEMO -- NOT A REAL CONTRACT" watermark + footer to every page
  3. POST to /api/upload-document (creates a NEW documents row + storage object)
  4. After ALL uploads succeed, DELETE the old placeholder rows via Supabase
     MCP-equivalent SQL. Storage orphans are tiny (~1.6KB each) and acceptable.

Auth uses the demo account password — same anon-key+password flow as the
original placeholder seeder.
"""
from __future__ import annotations
import base64
import io
import os
import sys
import tempfile
from pathlib import Path

import requests
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color, black, red
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

HERE = Path(__file__).parent
TREC_DIR = HERE / "trec-forms"
SUPABASE_URL = "https://pgwoitbdiyubjugwufhk.supabase.co"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE"
DEMO_EMAIL = "demo@meetdossie.com"
DEMO_PASSWORD = "DossieDemo-VaIiAt6Bab"
UPLOAD_URL = "https://meetdossie.com/api/upload-document"

# Demo-account agent identity (matches what's in profiles for the demo user)
AGENT = {
    "name": "Sarah Whitley",
    "brokerage": "Sample Realty Group",
    "license": "0654321",
    "phone": "(210) 555-0142",
    "email": DEMO_EMAIL,
}

# Default title / lender for demo deals
TITLE_CO = "Demo Title Co."
DEFAULT_LENDER = "Sample Bank"
JUMBO_LENDER = "Lone Star Lending (Demo)"

# Per-deal override for lender
DEAL_LENDER = {
    "8412 Mock Trail, San Antonio, TX 78230": JUMBO_LENDER,
}

# Deal data — same five active dossiers + the closed sample.
# transaction_id values pulled from the live transactions table on 2026-05-04.
DEALS = {
    "DEMO-2026-001": {
        "id": "a60d6a4e-5a61-4e01-bfac-c10469c10c4d",
        "address": "1247 Sample Way, San Antonio, TX 78209",
        "buyer": "Martinez Family",
        "seller": "Sample Trust",
        "sale_price": "485,000",
        "earnest_money": "5,000",
        "option_fee": "250",
        "option_period_days": "10",
        "effective_date": "2026-04-26",
        "closing_date": "2026-05-26",
        "role": "buyer",
        "context": "Buyer rep -- Martinez Family. Seller represented by another brokerage.",
        "docs": [
            ("Executed Contract -- Martinez.pdf",         "Executed Contract (TREC 20-17)",     "contract"),
            ("Sellers Disclosure -- 1247 Sample Way.pdf", "Seller's Disclosure Notice",         "sellers_disclosure"),
            ("HOA Disclosure -- 1247 Sample Way.pdf",     "HOA Disclosure & Subdivision Info",  "hoa"),
            ("Buyer Preapproval -- Martinez.pdf",         "Lender Pre-approval Letter",         "pre_approval"),
            ("Inspection Report -- 1247 Sample Way.pdf",  "General Home Inspection Report",     "inspection"),
        ],
    },
    "DEMO-2026-002": {
        "id": "225a7030-12d8-4197-87cb-0d44118383a6",
        "address": "8412 Mock Trail, San Antonio, TX 78230",
        "buyer": "Chen Household",
        "seller": "Sample Trust",
        "sale_price": "720,000",
        "earnest_money": "7,500",
        "option_fee": "300",
        "option_period_days": "10",
        "effective_date": "2026-05-02",
        "closing_date": "2026-06-01",
        "role": "buyer",
        "context": "Buyer rep -- Chen Household. Inspection Wednesday.",
        "docs": [
            ("Executed Contract -- Chen.pdf",             "Executed Contract (TREC 20-17)",    "contract"),
            ("Sellers Disclosure -- 8412 Mock Trail.pdf", "Seller's Disclosure Notice",        "sellers_disclosure"),
            ("Buyer Preapproval -- Chen.pdf",             "Lender Pre-approval Letter",        "pre_approval"),
            ("Survey -- 8412 Mock Trail.pdf",             "Survey (from prior owner)",         "survey"),
        ],
    },
    "DEMO-2026-003": {
        "id": "d99b0b44-46e9-4d2b-b9af-c50bf10e1b78",
        "address": "3309 Faux Glen, San Antonio, TX 78258",
        "buyer": "Patel Group",
        "seller": "Sample Trust",
        "sale_price": "615,000",
        "earnest_money": "6,150",
        "option_fee": "275",
        "option_period_days": "10",
        "effective_date": "2026-03-30",
        "closing_date": "2026-05-08",
        "role": "buyer",
        "context": "Buyer rep -- Patel Group. Closing Wednesday; clear-to-close received.",
        "docs": [
            ("Executed Contract -- Patel.pdf",            "Executed Contract (TREC 20-17)",    "contract"),
            ("Sellers Disclosure -- 3309 Faux Glen.pdf",  "Seller's Disclosure Notice",        "sellers_disclosure"),
            ("Inspection Report -- 3309 Faux Glen.pdf",   "General Home Inspection Report",    "inspection"),
            ("Repair Amendment -- Patel.pdf",             "Amendment for Repairs (TREC 39-9)", "amendment"),
            ("Closing Disclosure -- Patel.pdf",           "Closing Disclosure (CD)",           "closing_disclosure"),
        ],
    },
    "DEMO-2026-004": {
        "id": "a654a84f-2816-40c8-81b1-036212973508",
        "address": "6701 Demo Bend, San Antonio, TX 78216",
        "buyer": "Walsh Family",
        "seller": "Sample Trust",
        "sale_price": "395,000",
        "earnest_money": "4,000",
        "option_fee": "250",
        "option_period_days": "10",
        "effective_date": "2026-04-15",
        "closing_date": "2026-05-25",
        "role": "buyer",
        "context": "Buyer rep -- Walsh Family. Underwriting outstanding.",
        "docs": [
            ("Executed Contract -- Walsh.pdf",            "Executed Contract (TREC 20-17)",    "contract"),
            ("Sellers Disclosure -- 6701 Demo Bend.pdf",  "Seller's Disclosure Notice",        "sellers_disclosure"),
            ("Inspection Report -- 6701 Demo Bend.pdf",   "General Home Inspection Report",    "inspection"),
            ("Title Commitment -- 6701 Demo Bend.pdf",    "Title Commitment",                  "title_commitment"),
        ],
    },
    "DEMO-2026-005": {
        "id": "5fdacb2a-52b2-40ec-a92d-d8c6418ffb91",
        "address": "11209 Pretend Ridge, San Antonio, TX 78249",
        "buyer": "Doerr Trust",
        "seller": "Brennan Estate",
        "sale_price": "555,000",
        "earnest_money": "5,550",
        "option_fee": "250",
        "option_period_days": "10",
        "effective_date": "2026-05-03",
        "closing_date": "2026-06-10",
        "role": "listing",
        "context": "Listing -- Brennan Estate. Offer accepted Friday from Doerr Trust.",
        "docs": [
            ("Listing Agreement -- Brennan.pdf",            "Residential Listing Agreement",       "listing_agreement"),
            ("Sellers Disclosure -- 11209 Pretend Ridge.pdf", "Seller's Disclosure Notice",        "sellers_disclosure"),
            ("Executed Offer -- Doerr Trust.pdf",           "Executed Offer (TREC 20-17)",         "contract"),
            ("Earnest Money Receipt -- Doerr.pdf",          "Earnest Money Receipt",               "earnest_receipt"),
        ],
    },
    "DEMO-2026-006": {
        "id": "021e85fd-692b-472e-bc3d-d27cf45c4eab",
        "address": "5402 Sample Park, San Antonio, TX 78228",
        "buyer": "Sample Buyer",
        "seller": "Holt Trust",
        "sale_price": "428,000",
        "earnest_money": "4,280",
        "option_fee": "250",
        "option_period_days": "10",
        "effective_date": "2026-03-15",
        "closing_date": "2026-04-28",
        "role": "listing",
        "context": "Listing -- Holt Trust. Closed 2026-04-28.",
        "docs": [
            ("Executed Contract -- 5402 Sample Park.pdf", "Executed Contract (TREC 20-17)",     "contract"),
            ("Final Settlement Statement -- Holt.pdf",    "Final Settlement Statement (HUD-1)", "settlement"),
            ("Recorded Warranty Deed -- 5402.pdf",        "Recorded Warranty Deed",             "deed"),
        ],
    },
}


# ---------------------------------------------------------------------------
# PDF utilities
# ---------------------------------------------------------------------------

def _ascii(s: str) -> str:
    """Helvetica core fonts are latin-1 only; transliterate Unicode."""
    if s is None:
        return ""
    return (
        str(s)
        .replace("—", "--")
        .replace("–", "-")
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("…", "...")
    )


def make_watermark_overlay(width: float, height: float) -> bytes:
    """A single-page PDF the size of the underlying page with the diagonal
    DEMO watermark (transparent red) + a footer disclaimer. Merged on top of
    each form page so the body fields stay readable under it."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))

    # Diagonal watermark — 30 degrees, large red text, ~25% opacity.
    c.saveState()
    c.setFillColor(Color(0.85, 0.15, 0.15, alpha=0.22))
    c.setFont("Helvetica-Bold", 64)
    c.translate(width / 2, height / 2)
    c.rotate(30)
    c.drawCentredString(0, 0, "DEMO -- NOT A REAL CONTRACT")
    c.restoreState()

    # Footer disclaimer
    c.setFillColor(Color(0.6, 0.0, 0.0, alpha=0.85))
    c.setFont("Helvetica-Oblique", 8)
    c.drawCentredString(
        width / 2, 16,
        "DEMO PLACEHOLDER -- NOT A REAL CONTRACT. Generated for the Dossie marketing demo.",
    )

    c.save()
    return buf.getvalue()


def apply_watermark(pdf_bytes: bytes) -> bytes:
    """Merge a fresh watermark overlay onto every page of pdf_bytes."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for page in reader.pages:
        # The page's MediaBox tells us the page size — important because TREC
        # forms can be Letter or sometimes a smaller crop. We make the overlay
        # the same dimensions so the watermark scales correctly.
        mb = page.mediabox
        w = float(mb.width)
        h = float(mb.height)
        overlay_pdf = make_watermark_overlay(w, h)
        overlay_page = PdfReader(io.BytesIO(overlay_pdf)).pages[0]
        page.merge_page(overlay_page)
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def cover_page(title: str, deal: dict) -> bytes:
    """A single-page summary cover that goes IN FRONT of the blank TREC form
    so the deal-specific data is the first thing the reader sees. Two-column
    layout with the title at the top, parties+price block, dates block, and
    agent-of-record signature block at the bottom (no actual signature)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    width, height = LETTER

    # Title
    c.setFillColor(black)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(0.75 * inch, height - 0.9 * inch, _ascii(title))
    c.setFont("Helvetica", 10)
    c.setFillGray(0.4)
    c.drawString(0.75 * inch, height - 1.15 * inch, _ascii(deal["address"]))
    c.drawString(0.75 * inch, height - 1.32 * inch, _ascii(deal["context"]))
    c.setFillColor(black)

    # Section helper
    def section_title(y, label):
        c.setFont("Helvetica-Bold", 11)
        c.setFillGray(0.0)
        c.drawString(0.75 * inch, y, _ascii(label))
        c.setLineWidth(0.5)
        c.line(0.75 * inch, y - 3, width - 0.75 * inch, y - 3)

    def field(y, x, label, value):
        c.setFont("Helvetica", 8)
        c.setFillGray(0.45)
        c.drawString(x, y, _ascii(label))
        c.setFont("Helvetica", 11)
        c.setFillGray(0.0)
        c.drawString(x, y - 14, _ascii(value or "--"))

    y = height - 1.85 * inch
    section_title(y, "Parties")
    field(y - 18, 0.75 * inch,        "Buyer",  deal.get("buyer"))
    field(y - 18, 4.0 * inch,         "Seller", deal.get("seller"))

    y -= 0.7 * inch
    section_title(y, "Property")
    field(y - 18, 0.75 * inch, "Property Address", deal["address"])

    y -= 0.55 * inch
    section_title(y, "Financial Terms")
    field(y - 18, 0.75 * inch,  "Sale Price",     "$" + deal["sale_price"])
    field(y - 18, 3.0 * inch,   "Earnest Money",  "$" + deal["earnest_money"])
    field(y - 18, 5.25 * inch,  "Option Fee",     "$" + deal["option_fee"])

    y -= 0.55 * inch
    section_title(y, "Dates & Periods")
    field(y - 18, 0.75 * inch,  "Effective Date", deal["effective_date"])
    field(y - 18, 3.0 * inch,   "Closing Date",   deal["closing_date"])
    field(y - 18, 5.25 * inch,  "Option Period",  deal["option_period_days"] + " days")

    y -= 0.7 * inch
    section_title(y, "Service Providers")
    field(y - 18, 0.75 * inch,  "Title Company",  TITLE_CO)
    field(y - 18, 3.0 * inch,   "Lender",         DEAL_LENDER.get(deal["address"], DEFAULT_LENDER))

    y -= 0.7 * inch
    section_title(y, "Agent of Record")
    field(y - 18, 0.75 * inch,  "Name",           AGENT["name"])
    field(y - 18, 3.0 * inch,   "Brokerage",      AGENT["brokerage"])
    field(y - 18, 5.25 * inch,  "TX License",     AGENT["license"])
    field(y - 38, 0.75 * inch,  "Phone",          AGENT["phone"])
    field(y - 38, 3.0 * inch,   "Email",          AGENT["email"])

    # Note that this is the cover summary and the actual TREC form follows.
    c.setFont("Helvetica-Oblique", 9)
    c.setFillGray(0.45)
    c.drawString(
        0.75 * inch, 0.75 * inch,
        "Cover summary above; the executed TREC form pages follow.",
    )

    c.showPage()
    c.save()
    return buf.getvalue()


def fill_op_h_form(deal: dict) -> bytes:
    """Open the OP-H Sellers Disclosure, fill the property-address header on
    every page (TextField1[*]) -- the only fields with a stable enough mapping
    to use without manual coordinate analysis -- and return the bytes."""
    from pypdf.generic import BooleanObject, NameObject

    src = TREC_DIR / "OP-H.pdf"
    reader = PdfReader(str(src))
    writer = PdfWriter(clone_from=reader)

    # Property address goes in the header on every page (TextField1[0..7]).
    address = deal["address"]
    fields = reader.get_fields() or {}
    field_values = {key: address for key in fields if "TextField1[" in key}

    for page in writer.pages:
        if "/Annots" in page:
            writer.update_page_form_field_values(page, field_values)

    # NeedAppearances tells viewers (Preview, Acrobat) to regenerate the field
    # appearance from the value. Without it the address won't render.
    catalog = writer._root_object
    if "/AcroForm" in catalog:
        catalog["/AcroForm"][NameObject("/NeedAppearances")] = BooleanObject(True)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def cover_then_form(title: str, deal: dict, trec_form_path: Path) -> bytes:
    """Cover summary page + every page of the (flat) TREC form."""
    cover = cover_page(title, deal)
    cover_reader = PdfReader(io.BytesIO(cover))

    writer = PdfWriter()
    for page in cover_reader.pages:
        writer.add_page(page)
    if trec_form_path.exists():
        form_reader = PdfReader(str(trec_form_path))
        for page in form_reader.pages:
            writer.add_page(page)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def styled_placeholder(title: str, deal: dict, lines: list) -> bytes:
    """For doc types we don't have a TREC form for -- a cleanly styled
    summary page that mirrors the cover-page look. This replaces the previous
    bare FPDF placeholder."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    width, height = LETTER

    c.setFont("Helvetica-Bold", 18)
    c.drawString(0.75 * inch, height - 0.9 * inch, _ascii(title))
    c.setFont("Helvetica", 10)
    c.setFillGray(0.4)
    c.drawString(0.75 * inch, height - 1.15 * inch, _ascii(deal["address"]))
    c.drawString(0.75 * inch, height - 1.32 * inch, _ascii(deal["context"]))
    c.setFillColor(black)

    # Body bullets
    c.setFont("Helvetica", 11)
    y = height - 1.9 * inch
    for line in lines:
        for chunk in _wrap(line, 100):
            c.drawString(0.85 * inch, y, _ascii("- " + chunk if chunk == line else "  " + chunk))
            y -= 16
            if y < 1.5 * inch:
                c.showPage()
                c.setFont("Helvetica", 11)
                y = height - 1.0 * inch

    c.showPage()
    c.save()
    return buf.getvalue()


def _wrap(text: str, width: int) -> list:
    if not text:
        return [""]
    out, cur = [], ""
    for word in text.split():
        if len(cur) + len(word) + 1 > width:
            out.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    if cur:
        out.append(cur)
    return out


# Doc-type body-line presets (what each non-TREC placeholder document says).
PLACEHOLDER_LINES = {
    "hoa":                ["HOA: Sample Heights Owners Association", "Dues: $145 / quarter", "Transfer fee: $200", "No special assessments noted."],
    "pre_approval":       ["Pre-approved up to listed amount on the deal record.", "Conventional 30-year amortization, 6.85% rate.", "Conditions: clear title, satisfactory appraisal."],
    "inspection":         ["Inspector: Demo Inspections LLC", "Findings include minor cosmetic items typical for the property age.", "No structural issues reported."],
    "survey":             ["Surveyor: Demo Survey Co.", "Date: 2024-03-11", "No encroachments noted."],
    "title_commitment":   ["Title Co: Demo Title Co.", "GF#: DEMO-25-A1234", "Schedule B exceptions: standard utility easements only."],
    "closing_disclosure": ["Closing Disclosure (CD) summary.", "Cash to close per the latest CD revision.", "Loan terms unchanged from disclosure."],
    "settlement":         ["Final Settlement Statement summary.", "Net proceeds disbursed via wire to seller account on file."],
    "deed":               ["Recorded Warranty Deed.", "Recorded with Bexar County Clerk.", "Instrument number: DEMO-2026-009912"],
    "earnest_receipt":    ["Earnest money received and deposited with the title company.", "Receipt issued under the file number on the contract."],
    "listing_agreement":  ["Residential Listing Agreement (TAR/TX-Realtors form).", "Listing term and commission per the executed agreement."],
}


def build_doc(deal: dict, doc_title: str, doc_type: str) -> bytes:
    """Dispatch to the right builder for this doc type, then watermark."""
    if doc_type == "contract":
        body = cover_then_form(doc_title, deal, TREC_DIR / "20-17.pdf")
    elif doc_type == "sellers_disclosure":
        body = fill_op_h_form(deal)
    elif doc_type == "amendment":
        body = cover_then_form(doc_title, deal, TREC_DIR / "39-9.pdf")
    else:
        lines = PLACEHOLDER_LINES.get(doc_type, ["See dossier metadata for details."])
        body = styled_placeholder(doc_title, deal, lines)
    return apply_watermark(body)


# ---------------------------------------------------------------------------
# Upload + cleanup
# ---------------------------------------------------------------------------

def sign_in() -> str:
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token",
        params={"grant_type": "password"},
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def upload(token: str, transaction_id: str, filename: str, doctype: str, body: bytes):
    b64 = base64.b64encode(body).decode("ascii")
    r = requests.post(
        UPLOAD_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Origin": "https://meetdossie.com",
        },
        json={
            "transactionId": transaction_id,
            "fileName": filename,
            "fileType": "application/pdf",
            "fileBase64": b64,
            "documentType": doctype,
        },
        timeout=90,
    )
    return r.status_code, r.text[:300]


def main():
    print(f"[gen] using TREC forms in {TREC_DIR}")

    plan = []
    for dossier, deal in DEALS.items():
        for filename, title, doctype in deal["docs"]:
            try:
                pdf_bytes = build_doc(deal, title, doctype)
            except Exception as e:
                print(f"  BUILD FAIL {dossier} {filename}: {e}")
                continue
            plan.append({
                "dossier": dossier,
                "transaction_id": deal["id"],
                "filename": filename,
                "doctype": doctype,
                "bytes": pdf_bytes,
            })
            print(f"  built {dossier} {doctype:20s} {len(pdf_bytes)//1024:>4d}KB  {filename}")

    print(f"[gen] {len(plan)} PDFs built")

    token = sign_in()
    print(f"[auth] signed in (token len {len(token)})")

    ok = 0
    fail = 0
    for item in plan:
        status, body = upload(token, item["transaction_id"], item["filename"], item["doctype"], item["bytes"])
        if 200 <= status < 300:
            ok += 1
            print(f"  OK   {item['dossier']} {item['filename']}")
        else:
            fail += 1
            print(f"  FAIL {item['dossier']} {item['filename']} -> {status} {body}")

    print(f"[done] uploaded={ok} failed={fail} of {len(plan)}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
