from pathlib import Path
from document_utils import BASE_DIR, OUTPUT_DIR, fill_pdf, load_json_arg, map_fields
from document_field_maps import RESALE_FIELD_MAP, RESALE_BUTTON_MAP

SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")

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


def main():
    data = load_json_arg(DEFAULT_DATA)
    output_path = OUTPUT_DIR / "sample-resale-contract.pdf"
    mapped_text_values, mapped_button_values = map_fields(data, RESALE_FIELD_MAP, RESALE_BUTTON_MAP)
    fill_pdf(SOURCE_PDF, output_path, mapped_text_values, mapped_button_values)
    print(f"Generated: {output_path}")
    print(f"Mapped text fields used: {len(mapped_text_values)}")
    for key in mapped_text_values:
        print(f" - {key}: {mapped_text_values[key]}")
    print(f"Mapped button fields used: {len(mapped_button_values)}")
    for key in mapped_button_values:
        print(f" - {key}: {mapped_button_values[key]}")
    print(str(output_path))


if __name__ == "__main__":
    main()
