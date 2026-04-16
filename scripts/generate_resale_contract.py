from pathlib import Path
from pypdf import PdfReader, PdfWriter
from resale_contract_field_map import FIELD_MAP

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")
OUTPUT_DIR = BASE_DIR / "generated-docs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_DATA = {
    "buyer_name": "Marcus Patterson",
    "seller_name": "Heath Shepard",
    "property_address": "4521 Meadow Creek Dr",
    "city_state_zip": "San Antonio, TX 78230",
    "county": "Bexar",
    "legal_description": "Lot 12, Block 4, Oak Hollow Subdivision",
    "sale_price": "425000",
    "earnest_money": "5000",
    "option_fee": "200",
    "contract_effective_date": "04/16/2026",
    "closing_date": "05/24/2026",
    "title_company": "Alamo Title",
    "lender_name": "Prime Lending",
}


def fill_pdf(source_pdf: Path, output_pdf: Path, values: dict):
    reader = PdfReader(str(source_pdf))
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    if "/AcroForm" in reader.trailer["/Root"]:
        writer._root_object.update({
            NameObject("/AcroForm"): reader.trailer["/Root"]["/AcroForm"]
        })

    for page in writer.pages:
        writer.update_page_form_field_values(page, values)

    with output_pdf.open("wb") as f:
        writer.write(f)


# pypdf NameObject import placed late to keep the file simple for edits
from pypdf.generic import NameObject


def main():
    output_path = OUTPUT_DIR / "sample-resale-contract.pdf"
    mapped_values = {
        pdf_field: SAMPLE_DATA[data_key]
        for pdf_field, data_key in FIELD_MAP.items()
        if data_key in SAMPLE_DATA
    }
    fill_pdf(SOURCE_PDF, output_path, mapped_values)
    print(f"Generated: {output_path}")
    print(f"Mapped fields used: {len(mapped_values)}")
    for key in mapped_values:
        print(f" - {key}: {mapped_values[key]}")


if __name__ == "__main__":
    main()
