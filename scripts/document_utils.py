import json
from pathlib import Path
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, BooleanObject

BASE_DIR = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie")
OUTPUT_DIR = BASE_DIR / "generated-docs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def normalize_date(value):
    if not value:
        return ""
    value = str(value)
    if len(value) >= 10 and value[4] == '-' and value[7] == '-':
        y, m, d = value[:10].split('-')
        return f"{m}/{d}/{y}"
    return value


def stringify_money(value):
    if value in (None, ""):
        return ""
    return str(value)


def load_json_arg(default_data):
    import sys
    if len(sys.argv) > 1:
        json_path = Path(sys.argv[1])
        with json_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    return default_data


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


def map_fields(data, field_map, button_map):
    mapped_text_values = {
        pdf_field: data[data_key]
        for pdf_field, data_key in field_map.items()
        if data_key in data and data[data_key] not in (None, "")
    }
    mapped_button_values = {
        pdf_field: "/On"
        for pdf_field, data_key in button_map.items()
        if data.get(data_key)
    }
    return mapped_text_values, mapped_button_values
