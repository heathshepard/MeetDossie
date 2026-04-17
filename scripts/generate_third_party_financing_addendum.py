from pathlib import Path
from document_utils import OUTPUT_DIR, fill_pdf, load_json_arg, map_fields
from document_field_maps import FINANCING_FIELD_MAP, FINANCING_BUTTON_MAP

SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\Third-Party-Financing-Addendum.pdf")
DEFAULT_DATA = {
    "property_full": "4521 Meadow Creek Dr, San Antonio, TX 78230",
    "loan_amount": "340000",
    "contract_effective_date": "04/16/2026",
    "buyer_name": "Marcus Patterson",
    "financing_conventional": True,
    "financing_fha": False,
    "financing_va": False,
}


def main():
    data = load_json_arg(DEFAULT_DATA)
    output_path = OUTPUT_DIR / "sample-third-party-financing-addendum.pdf"
    mapped_text_values, mapped_button_values = map_fields(data, FINANCING_FIELD_MAP, FINANCING_BUTTON_MAP)
    fill_pdf(SOURCE_PDF, output_path, mapped_text_values, mapped_button_values)
    print(f"Generated: {output_path}")
    print(str(output_path))


if __name__ == "__main__":
    main()
