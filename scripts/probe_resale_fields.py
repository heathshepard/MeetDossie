from pathlib import Path
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")
OUTPUT_PDF = Path(r"C:\Users\Heath Shepard\Desktop\MeetDossie\generated-docs\probe-resale-contract.pdf")
OUTPUT_PDF.parent.mkdir(parents=True, exist_ok=True)

reader = PdfReader(str(SOURCE_PDF))
fields = list((reader.get_fields() or {}).keys())
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
if "/AcroForm" in reader.trailer["/Root"]:
    writer._root_object.update({NameObject("/AcroForm"): reader.trailer["/Root"]["/AcroForm"]})

probe_values = {name: f"[{i}]" for i, name in enumerate(fields[:120], start=1)}
for page in writer.pages:
    writer.update_page_form_field_values(page, probe_values)

with OUTPUT_PDF.open("wb") as f:
    writer.write(f)

print(f"Generated probe PDF: {OUTPUT_PDF}")
print(f"Probed fields: {len(probe_values)}")
