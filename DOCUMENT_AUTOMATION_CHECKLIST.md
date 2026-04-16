# Dossie Document Automation Checklist

## Objective
Connect authenticated dossier data to TREC form generation so Dossie can actually fill contracts and transaction documents.

## Checklist

### 1. Inventory the real downloaded TREC base forms
Available in the downloaded base set:
- One-to-Four-Family Residential Contract (Resale)
- Third-Party Financing Addendum
- Amendment to Contract
- Notice of Buyer's Termination of Contract
- Seller's Disclosure Notice
- HOA Addendum
- Lead-Based Paint Addendum

### 2. Choose the exact phase-one starter set
Start with:
1. One-to-Four-Family Residential Contract (Resale)
2. Third-Party Financing Addendum
3. Amendment to Contract
4. Notice of Buyer's Termination of Contract

Reason:
- highest practical value
- enough to prove core contract lifecycle utility
- aligns with active transaction stages already represented in Dossie

### 3. Compare current live dossier fields vs. required contract inputs
Current live dossier fields captured now:
- property_address
- city_state_zip
- buyer_name / seller_name
- role
- stage
- status
- notes
- contract_effective_date
- closing_date
- sale_price
- earnest_money
- option_fee
- option_days
- financing_days

Missing/high-priority fields for real contract generation:
- legal property description
- county
- buyer full legal names (multi-party safe)
- seller full legal names (multi-party safe)
- title company name
- title company contact info
- lender name
- lender contact info
- escrow/earnest money delivery details
- option fee recipient details
- financing type / loan amount
- exclusions / non-realty items
- brokerage / agent identifiers
- commission structure inputs
- possession details
- HOA / lead paint / property condition triggers
- signatures/execution data strategy

### 4. Expand the live dossier schema/UI to capture required fields
Need next:
- party block
- title/lender block
- deal economics block
- property/legal block
- transaction terms block

### 5. Map dossier fields to form fields
Phase-one mapping target order:
1. One-to-Four-Family Residential Contract (Resale)
2. Third-Party Financing Addendum
3. Amendment to Contract
4. Notice of Buyer's Termination of Contract

### 6. Choose generation path
Preferred first implementation path:
- inspect whether the downloaded PDFs have fillable fields
- if yes: fill PDF fields directly
- if not: use a template-based overlay/render approach

Current implementation decision:
- treat the Resale Contract as the first flagship document
- inspection confirmed the starter PDFs expose fillable form fields
- generation-path decision: start with direct PDF field fill for the Resale Contract
- keep overlay/template generation as fallback only if field behavior or output quality proves unreliable

### 7. Add document-generation UI to the authenticated workspace
Need in selected dossier:
- Generate Contract
- Generate Financing Addendum
- Generate Amendment
- Generate Termination Notice
- show missing required fields before generation

### 8. Validate output quality
Must verify:
- field placement
- dates
- checkboxes
- conditional sections
- download/export usability

## Current state
Completed so far:
- real form inventory confirmed
- phase-one starter document set chosen
- current live schema gap identified

Next implementation step:
- expand the authenticated dossier workspace to capture the missing phase-one contract fields needed for the One-to-Four-Family Residential Contract (Resale)
