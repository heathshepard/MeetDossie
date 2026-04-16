# Document Automation Execution Checklist

## Current completed base
- TREC starter PDFs inventoried
- phase-one document set chosen
- live dossier schema expanded toward resale contract inputs
- pypdf installed and working
- starter PDFs confirmed fillable
- resale field inventory extracted
- probe resale PDF generated for mapping
- first real resale field map created
- first meaningfully filled resale contract output generated
- generator now supports structured dossier JSON input

## Remaining execution path

### 1. Refine resale contract field mapping
- visually inspect generated output
- correct any wrong field placements
- add city/state/zip, legal description, sale price, and more financing fields
- identify any duplicate/secondary fields that should also be populated

### 2. Add missing dossier capture fields in app.html
- separate buyer/seller full legal names if needed
- title company contact data
- escrow delivery details
- financing type / loan amount
- property legal-description fields beyond the current single string
- possession / exclusions / HOA / lead-paint triggers as needed

### 3. Connect generator to live dossier records
- define export shape from the live dossier object
- add a transformation layer from app data -> generator JSON
- generate contract output from real selected dossier data

### 4. Add document generation into the authenticated UI
- add a Generate Documents area in dossier detail
- add Generate Resale Contract action
- surface missing required fields before generation
- provide download link / file output feedback

### 5. Add next documents
- Third-Party Financing Addendum
- Amendment to Contract
- Notice of Buyer's Termination of Contract

### 6. Move toward conversational/voice contract filling
- define the normalized contract schema Dossie should fill conversationally
- build missing-field prompting logic
- ask one missing item at a time
- later connect voice input to the same schema and generation pipeline
