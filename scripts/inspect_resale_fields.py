from pathlib import Path
from pypdf import PdfReader

SOURCE_PDF = Path(r"C:\Users\Heath Shepard\Desktop\dossie\Dossie Forms\TREC Base\One-to-Four-Family-Residential-Contract-Resale.pdf")

reader = PdfReader(str(SOURCE_PDF))
fields = reader.get_fields() or {}
print(f"Field count: {len(fields)}")
for key in fields.keys():
    print(key)
