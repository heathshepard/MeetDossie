from pathlib import Path
from document_utils import OUTPUT_DIR, fill_pdf, load_json_arg, map_fields
from document_field_maps import TERMINATION_FIELD_MAP, TERMINATION_BUTTON_MAP

SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\Notice-of-Buyers-Termination-of-Contract.pdf")
DEFAULT_DATA = {
    "property_full": "4521 Meadow Creek Dr, San Antonio, TX 78230",
    "buyer_name": "Marcus Patterson",
    "seller_name": "Heath Shepard",
    "contract_effective_date": "04/16/2026",
}


def main():
    data = load_json_arg(DEFAULT_DATA)
    output_path = OUTPUT_DIR / "sample-termination-notice.pdf"
    mapped_text_values, mapped_button_values = map_fields(data, TERMINATION_FIELD_MAP, TERMINATION_BUTTON_MAP)
    fill_pdf(SOURCE_PDF, output_path, mapped_text_values, mapped_button_values)
    print(f"Generated: {output_path}")
    print(str(output_path))


if __name__ == "__main__":
    main()
