from pathlib import Path
from pypdf import PdfReader, PdfWriter

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")
OUTPUT_DIR = BASE_DIR / "generated-docs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_DATA = {
    "BuyerName": "Marcus Patterson",
    "SellerName": "Heath Shepard",
    "PropertyAddress": "4521 Meadow Creek Dr, San Antonio, TX 78230",
    "County": "Bexar",
    "LegalDescription": "Lot 12, Block 4, Oak Hollow Subdivision",
    "SalesPrice": "425000",
    "EarnestMoney": "5000",
    "OptionFee": "200",
    "EffectiveDate": "04/16/2026",
    "ClosingDate": "05/24/2026",
    "TitleCompany": "Alamo Title",
    "LenderName": "Prime Lending",
}

# This is the phase-one start: inspectable direct field-fill pipeline.
# Actual field-name mapping must be refined against the PDF's true field names.
FIELD_MAP = {
    # placeholder initial mapping keys to be replaced with true PDF field names
}


def main():
    reader = PdfReader(str(SOURCE_PDF))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    if FIELD_MAP:
        writer.update_page_form_field_values(writer.pages[0], {
            pdf_field: SAMPLE_DATA[data_key]
            for pdf_field, data_key in FIELD_MAP.items()
            if data_key in SAMPLE_DATA
        })

    output_path = OUTPUT_DIR / "sample-resale-contract.pdf"
    with output_path.open("wb") as f:
        writer.write(f)

    print(f"Generated: {output_path}")
    print("Phase-one script created. Next step: replace FIELD_MAP with the actual PDF field names from inspection output.")


if __name__ == "__main__":
    main()
