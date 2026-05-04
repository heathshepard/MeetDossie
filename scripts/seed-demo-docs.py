"""One-shot demo doc seeder.

Generates watermarked placeholder PDFs for each demo transaction's documents,
authenticates as demo@meetdossie.com against Supabase, and uploads each PDF via
the production /api/upload-document endpoint (which writes to Storage and the
documents table). Idempotent-ish: writes PDFs to a temp dir first, then uploads.

Run:
    ELEVENLABS_API_KEY="..." python scripts/seed-demo-docs.py
    (env var not actually needed; uses hard-coded anon key + demo creds)

Cleanup: deletes the temp PDF dir at the end. Re-running will re-upload duplicates;
delete docs by user_id first if you need a clean re-seed.
"""
import os
import json
import base64
import tempfile
import time
import sys
from pathlib import Path
from fpdf import FPDF
import requests

SUPABASE_URL = "https://pgwoitbdiyubjugwufhk.supabase.co"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NzYwOTMsImV4cCI6MjA5MTI1MjA5M30.Ejlr9jdITeI0nlIvjr5fxeH5XMqvMbkVpsVQzjNf4iE"
DEMO_EMAIL = "demo@meetdossie.com"
DEMO_PASSWORD = "DossieDemo-VaIiAt6Bab"
UPLOAD_URL = "https://meetdossie.com/api/upload-document"

# Deal map: dossier_number -> (transaction_id, property_address, parties summary, doc list)
# transaction_ids pulled from the seed query earlier.
DEALS = {
    "DEMO-2026-001": {
        "id": "a60d6a4e-5a61-4e01-bfac-c10469c10c4d",
        "address": "1247 Sample Way, San Antonio, TX 78209",
        "context": "Buyer rep — Martinez Family. Seller represented by another brokerage.",
        "docs": [
            ("Executed Contract — Martinez.pdf",         "Executed Contract (TREC 20-17)",      "contract",            ["Buyer: Martinez Family", "Sale price: $485,000", "Effective date: 2026-04-26", "Closing date: 2026-05-26", "Option period: 10 days, $250 fee"]),
            ("Sellers Disclosure — 1247 Sample Way.pdf", "Seller's Disclosure Notice",          "sellers_disclosure",  ["Seller acknowledged: roof age 8 yrs, HVAC 2018, no known leaks", "No structural issues disclosed", "Neighborhood: Alamo Heights"]),
            ("HOA Disclosure — 1247 Sample Way.pdf",     "HOA Disclosure & Subdivision Info",   "hoa",                 ["HOA: Sample Heights Owners Assoc.", "Dues: $145 / quarter", "Transfer fee: $200"]),
            ("Buyer Preapproval — Martinez.pdf",         "Lender Pre-approval Letter",          "pre_approval",        ["Buyer: Martinez Family", "Lender: Sample Bank", "Pre-approved up to $510,000", "Conventional 30yr · 6.85%"]),
            ("Inspection Report — 1247 Sample Way.pdf",  "General Home Inspection Report",      "inspection",          ["Inspector: Demo Inspections LLC", "Inspection date: 2026-05-02", "Major findings: minor roof flashing, GFCI in master bath"]),
        ],
    },
    "DEMO-2026-002": {
        "id": "225a7030-12d8-4197-87cb-0d44118383a6",
        "address": "8412 Mock Trail, San Antonio, TX 78230",
        "context": "Buyer rep — Chen Household. Inspection Wed.",
        "docs": [
            ("Executed Contract — Chen.pdf",             "Executed Contract (TREC 20-17)",      "contract",            ["Buyer: Chen Household", "Sale price: $720,000", "Effective date: 2026-05-02", "Closing date: 2026-06-01", "Option period: 10 days, $300 fee"]),
            ("Sellers Disclosure — 8412 Mock Trail.pdf", "Seller's Disclosure Notice",          "sellers_disclosure",  ["Roof: 2019, HVAC: 2021", "Pool with rated equipment", "No flooding history disclosed"]),
            ("Buyer Preapproval — Chen.pdf",             "Lender Pre-approval Letter",          "pre_approval",        ["Buyer: Chen Household", "Lender: Lone Star Lending (Demo)", "Pre-approved up to $750,000", "Jumbo 30yr · 7.10%"]),
            ("Survey — 8412 Mock Trail.pdf",             "Survey (from prior owner)",           "survey",              ["Surveyor: Demo Survey Co.", "Date: 2024-03-11", "No encroachments noted"]),
        ],
    },
    "DEMO-2026-003": {
        "id": "d99b0b44-46e9-4d2b-b9af-c50bf10e1b78",
        "address": "3309 Faux Glen, San Antonio, TX 78258",
        "context": "Buyer rep — Patel Group. Closing Wed; clear-to-close received.",
        "docs": [
            ("Executed Contract — Patel.pdf",            "Executed Contract (TREC 20-17)",      "contract",            ["Buyer: Patel Group", "Sale price: $615,000", "Effective date: 2026-03-30", "Closing date: 2026-05-08", "Option period: 10 days"]),
            ("Sellers Disclosure — 3309 Faux Glen.pdf",  "Seller's Disclosure Notice",          "sellers_disclosure",  ["Roof: 2020", "Hot water heater replaced 2024"]),
            ("Inspection Report — 3309 Faux Glen.pdf",   "General Home Inspection Report",      "inspection",          ["Inspector: Demo Inspections LLC", "Date: 2026-04-04", "Findings: minor stucco crack, attic insulation low"]),
            ("Repair Amendment — Patel.pdf",             "Amendment for Repairs",               "amendment",           ["Negotiated repairs: stucco crack remedy, attic insulation R-30 top-up", "Seller credit at closing: $2,200"]),
            ("Closing Disclosure — Patel.pdf",           "Closing Disclosure (CD)",             "closing_disclosure",  ["Buyer: Patel Group", "Cash to close: $128,431.22", "Closing date: 2026-05-08"]),
        ],
    },
    "DEMO-2026-004": {
        "id": "a654a84f-2816-40c8-81b1-036212973508",
        "address": "6701 Demo Bend, San Antonio, TX 78216",
        "context": "Buyer rep — Walsh Family. Underwriting outstanding.",
        "docs": [
            ("Executed Contract — Walsh.pdf",            "Executed Contract (TREC 20-17)",      "contract",            ["Buyer: Walsh Family", "Sale price: $395,000", "Effective date: 2026-04-15", "Closing date: 2026-05-25", "Option period: 10 days"]),
            ("Sellers Disclosure — 6701 Demo Bend.pdf",  "Seller's Disclosure Notice",          "sellers_disclosure",  ["Roof: 2017", "Foundation work performed 2020 with transferable warranty"]),
            ("Inspection Report — 6701 Demo Bend.pdf",   "General Home Inspection Report",      "inspection",          ["Inspector: Demo Inspections LLC", "Date: 2026-04-19", "Findings: water heater near end of life"]),
            ("Title Commitment — 6701 Demo Bend.pdf",    "Title Commitment",                    "title_commitment",    ["Title Co: Demo Title Co.", "GF#: DEMO-25-A1234", "Schedule B exceptions: standard"]),
        ],
    },
    "DEMO-2026-005": {
        "id": "5fdacb2a-52b2-40ec-a92d-d8c6418ffb91",
        "address": "11209 Pretend Ridge, San Antonio, TX 78249",
        "context": "Listing — Brennan Estate. Offer accepted Friday from Doerr Trust.",
        "docs": [
            ("Listing Agreement — Brennan.pdf",          "Residential Listing Agreement",       "listing_agreement",   ["Seller: Brennan Estate", "List date: 2026-04-12", "List price: $565,000", "Commission: 6%"]),
            ("Sellers Disclosure — 11209 Pretend Ridge.pdf","Seller's Disclosure Notice",        "sellers_disclosure",  ["Roof: 2022", "Solar lease assumable", "No known structural issues"]),
            ("Executed Offer — Doerr Trust.pdf",         "Executed Offer (TREC 20-17)",         "contract",            ["Buyer: Doerr Trust", "Seller: Brennan Estate", "Sale price: $555,000", "Effective date: 2026-05-03", "Option: 10 days, $250 fee"]),
            ("Earnest Money Receipt — Doerr.pdf",        "Earnest Money Receipt",               "earnest_receipt",     ["Amount: $5,550", "Held by: Demo Title Co.", "Received: 2026-05-03"]),
        ],
    },
    "DEMO-2026-006": {
        "id": "021e85fd-692b-472e-bc3d-d27cf45c4eab",
        "address": "5402 Sample Park, San Antonio, TX 78228",
        "context": "Listing — Holt Trust. Closed 2026-04-28.",
        "docs": [
            ("Executed Contract — 5402 Sample Park.pdf", "Executed Contract (TREC 20-17)",      "contract",            ["Seller: Holt Trust", "Sale price: $428,000", "Effective: 2026-03-15", "Closed: 2026-04-28"]),
            ("Final Settlement Statement — Holt.pdf",    "Final Settlement Statement (HUD-1)",  "settlement",          ["Net to seller: $387,415.61", "Commission disbursed: $25,680", "Closed: 2026-04-28"]),
            ("Recorded Warranty Deed — 5402.pdf",        "Recorded Warranty Deed",              "deed",                ["County: Bexar", "Recording date: 2026-04-29", "Instrument #: DEMO-2026-009912"]),
        ],
    },
}


def _ascii(s):
    """Helvetica core font is latin-1; transliterate common Unicode away."""
    if s is None:
        return ""
    return (
        str(s)
        .replace("—", "--")  # em-dash
        .replace("–", "-")   # en-dash
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("…", "...")
        .replace("®", "(R)")
        .replace("™", "(TM)")
    )


class WatermarkedPDF(FPDF):
    PAGE_WIDTH_MM = 210      # A4 default in fpdf2
    SIDE_MARGIN_MM = 15
    BODY_WIDTH_MM = PAGE_WIDTH_MM - 2 * SIDE_MARGIN_MM  # 180

    def __init__(self, title, address, context, body_lines):
        super().__init__()
        self.set_margins(self.SIDE_MARGIN_MM, 18, self.SIDE_MARGIN_MM)
        self.set_auto_page_break(auto=True, margin=20)
        self.add_page()
        # Body content first; watermark layered on top last.
        self.set_font("Helvetica", "B", 18)
        self.cell(self.BODY_WIDTH_MM, 12, _ascii(title), ln=True)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(120, 120, 120)
        self.cell(self.BODY_WIDTH_MM, 6, _ascii(address), ln=True)
        if context:
            self.cell(self.BODY_WIDTH_MM, 6, _ascii(context), ln=True)
        self.set_text_color(0, 0, 0)
        self.ln(6)
        self.set_font("Helvetica", "", 11)
        for line in body_lines:
            self.multi_cell(self.BODY_WIDTH_MM, 7, "- " + _ascii(line))
        self.ln(6)
        # Disclaimer footer
        self.set_y(-30)
        self.set_font("Helvetica", "I", 9)
        self.set_text_color(150, 0, 0)
        self.cell(self.BODY_WIDTH_MM, 5, "DEMO PLACEHOLDER -- NOT A REAL CONTRACT. Generated for internal Dossie marketing demo only.", ln=True, align="C")
        # Diagonal watermark drawn last so it appears over the body content.
        self.set_text_color(225, 80, 80)
        self.set_font("Helvetica", "B", 38)
        with self.rotation(angle=30, x=105, y=160):
            self.text(20, 160, "DEMO -- NOT A REAL CONTRACT")
        self.set_text_color(0, 0, 0)


def generate_pdfs(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    plan = []
    for dossier, deal in DEALS.items():
        for filename, title, doctype, body in deal["docs"]:
            pdf = WatermarkedPDF(title, deal["address"], deal["context"], body)
            path = out_dir / f"{dossier}__{filename.replace(' ', '_')}"
            pdf.output(str(path))
            plan.append({
                "dossier": dossier,
                "transaction_id": deal["id"],
                "filename": filename,
                "doctype": doctype,
                "path": str(path),
            })
    return plan


def sign_in():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token",
        params={"grant_type": "password"},
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    j = r.json()
    return j["access_token"]


def upload(token, item):
    with open(item["path"], "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    r = requests.post(
        UPLOAD_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Origin": "https://meetdossie.com",
        },
        json={
            "transactionId": item["transaction_id"],
            "fileName": item["filename"],
            "fileType": "application/pdf",
            "fileBase64": b64,
            "documentType": item["doctype"],
        },
        timeout=60,
    )
    return r.status_code, r.text[:300]


def main():
    out_dir = Path(tempfile.mkdtemp(prefix="dossie-demo-pdfs-"))
    print(f"[gen] writing PDFs to {out_dir}")
    plan = generate_pdfs(out_dir)
    print(f"[gen] {len(plan)} PDFs written")

    token = sign_in()
    print(f"[auth] signed in (token len {len(token)})")

    ok = 0
    fail = 0
    for item in plan:
        status, body = upload(token, item)
        if 200 <= status < 300:
            ok += 1
            print(f"  OK  {item['dossier']} {item['filename']}")
        else:
            fail += 1
            print(f"  FAIL {item['dossier']} {item['filename']} -> {status} {body}")
    print(f"[done] uploaded={ok} failed={fail} of {len(plan)}")

    # Cleanup local PDFs
    for item in plan:
        try:
            os.remove(item["path"])
        except OSError:
            pass
    try:
        out_dir.rmdir()
    except OSError:
        pass

    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
