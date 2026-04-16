import json
import sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, BooleanObject
from resale_contract_field_map import FIELD_MAP, BUTTON_MAP

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")
OUTPUT_DIR = BASE_DIR / "generated-docs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_DATA = {
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
    "financing_addendum": True,
}


def fill_pdf(source_pdf: Path, output_pdf: Path, text_values: dict, button_values: dict):
    reader = PdfReader(str(source_pdf))
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    if "/AcroForm" in reader.trailer["/Root"]:
        acro_form = reader.trailer["/Root"]["/AcroForm"]
        writer._root_object.update({NameObject("/AcroForm"): acro_form})
        try:
            writer._root_object[NameObject("/AcroForm")].update({NameObject("/NeedAppearances"): BooleanObject(True)})
        except Exception:
            pass

    for page in writer.pages:
        writer.update_page_form_field_values(page, text_values)
        writer.update_page_form_field_values(page, button_values)

    with output_pdf.open("wb") as f:
        writer.write(f)


def load_data() -> dict:
    if len(sys.argv) > 1:
        json_path = Path(sys.argv[1])
        with json_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_DATA


def main():
    data = load_data()
    output_path = OUTPUT_DIR / "sample-resale-contract.pdf"
    mapped_text_values = {
        pdf_field: data[data_key]
        for pdf_field, data_key in FIELD_MAP.items()
        if data_key in data
    }
    mapped_button_values = {
        pdf_field: "/On"
        for pdf_field, data_key in BUTTON_MAP.items()
        if data.get(data_key)
    }
    fill_pdf(SOURCE_PDF, output_path, mapped_text_values, mapped_button_values)
    print(f"Generated: {output_path}")
    print(f"Mapped text fields used: {len(mapped_text_values)}")
    for key in mapped_text_values:
        print(f" - {key}: {mapped_text_values[key]}")
    print(f"Mapped button fields used: {len(mapped_button_values)}")
    for key in mapped_button_values:
        print(f" - {key}: {mapped_button_values[key]}")


if __name__ == "__main__":
    main()
