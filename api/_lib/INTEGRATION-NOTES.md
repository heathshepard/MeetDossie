# Integration Notes — Gap-Filling & PDF Regeneration (Job 1 + 2)

## Job 1: Post-fill Gap-Filling Wizard

**Frontend components created:**
- `src/components/dossieSign/GapWizard.jsx` — text input variant
- `src/components/dossieSign/GapWizardVoice.jsx` — voice input variant

**Backend helper created:**
- `api/_lib/fill-form-required-fields.js` — exports critical field lists per form type

**What needs wiring in dossie-app.jsx:**

1. Import the GapWizard and GapWizardVoice components at the top
2. Add state to track wizard visibility and missing fields:
   ```jsx
   const [showGapWizard, setShowGapWizard] = useState(false);
   const [gapWizardData, setGapWizardData] = useState({
     dossierId: null,
     formType: null,
     missingFields: [],
   });
   ```
3. When `fill_forms` tool is dispatched in `dispatchTalkAction`, import `getMissingRequiredFields` from `api/_lib/fill-form-required-fields.js` (frontend-accessible copy) and check for missing fields after the fill completes
4. If missing fields exist, show the wizard:
   ```jsx
   if (missingFields.length > 0) {
     setGapWizardData({
       dossierId: deal.id,
       formType: transaction.form_type,
       missingFields,
     });
     setShowGapWizard(true);
   }
   ```
5. Render `<GapWizard>` (or voice variant) in the main app JSX before the closing div

**Testing path:**
1. Say "fill a contract for 123 Main Street, $400k, John Buyer, Jane Seller, closing May 15"
2. If form_type is auto-detected but critical fields are missing, wizard opens
3. Agent provides one field at a time (voice or text)
4. Each answer calls `POST /api/dossie-update-and-refill` which also re-fills the PDF
5. On completion, wizard closes and PDF is refreshed

---

## Job 2: Auto Re-render PDF on Voice Field Update

**Backend endpoint created:**
- `api/dossie-update-and-refill.js` — POST endpoint that updates a field + re-fills PDF

**Backend helper created:**
- `api/_lib/pdf-regenerator.js` — finds filled PDFs and queues re-renders (currently stubbed for call to fill-form)

**What needs wiring in chat.js:**

1. After the `update_deal_field` tool dispatches (either from voice or text), add a call to regenerate filled PDFs:
   ```javascript
   // At the end of update_deal_field handler:
   const { regeneratePdfsForDossier } = require('./_lib/pdf-regenerator');
   await regeneratePdfsForDossier(dossierId, fieldName, newValue);
   ```

2. In the response to the agent, include a status message:
   ```
   "Updated Peterson option period to 7 days. Re-rendering the contract PDF now."
   ```

3. The frontend should fetch the dossier again (or listen for a realtime update) after a few seconds to see the refreshed PDF

**How it works:**
1. Agent says "change the option period to 7 days"
2. `update_deal_field` tool updates DB: optionDays = 7
3. `regeneratePdfsForDossier()` fires async POST to `/api/fill-form` with the new value
4. fill-form re-renders the PDF under the same `storage_path`, overwriting the old version
5. Frontend sees the updated PDF (CDN cache buster via updated `updated_at` timestamp on transaction)

---

## File inventory

**Created files (7 total):**

### Backend (MeetDossie repo)
1. `/api/_lib/fill-form-required-fields.js` (46 lines)
   - REQUIRED_FIELDS_BY_FORM_TYPE constant
   - getRequiredFieldsForFormType(formType)
   - getMissingRequiredFields(formType, transaction)
   - fieldNameToPrompt(fieldName)

2. `/api/_lib/pdf-regenerator.js` (95 lines)
   - findFilledPdfsForDossier(dossierId)
   - queuePdfRegeneration(dossierId, formType, transactionData)
   - regeneratePdfsForDossier(dossierId, fieldName, newValue)

3. `/api/dossie-update-and-refill.js` (155 lines)
   - POST /api/dossie-update-and-refill handler
   - updateDossierField(dossierId, fieldName, fieldValue)
   - getTransaction(dossierId)
   - requeuePdfRefill(dossierId, formType, transaction)

### Frontend (Dossie repo)
4. `/src/components/dossieSign/GapWizard.jsx` (190 lines)
   - Text input variant of gap-filling wizard
   - One field per screen with "Skip" / "Next" buttons
   - Submits all answers via dossie-update-and-refill

5. `/src/components/dossieSign/GapWizardVoice.jsx` (310 lines)
   - Voice input variant using Web Speech API
   - Toggle to text mode, mode toggle to voice
   - Reuses chat mic infrastructure pattern
   - Captures answer, shows confirmation, moves to next field

### Documentation
6. `/api/_lib/INTEGRATION-NOTES.md` (this file)
   - Integration checklist
   - Code examples
   - Testing path

---

## Critical fields per form type

**resale-contract** (TREC 20-16):
- sale_price, closing_date, option_days, option_fee, earnest_money, financing_type, title_policy_paid_by

**financing-addendum** (TREC 40):
- loan_amount, down_payment_amt, financing_type

**unimproved-property** (TREC 9-17):
- sale_price, closing_date, option_days, option_fee, earnest_money, financing_type, land_acreage

**farm-ranch** (TREC 25-14):
- sale_price, closing_date, option_days, option_fee, earnest_money, financing_type, land_acreage

**new-home-incomplete** (TREC 23-18):
- sale_price, closing_date, option_days, option_fee, earnest_money, financing_type, expected_completion_date

**new-home-complete** (TREC 24-18):
- sale_price, closing_date, option_days, option_fee, earnest_money, financing_type

---

## Manual testing checklist (for Atlas APV)

- [ ] Sign in as demo@meetdossie.com / DossieDemo-VaIiAt6Bab
- [ ] Open a new dossier or use existing one
- [ ] Attempt fill_forms for resale-contract with incomplete data (e.g., missing sale_price)
- [ ] Verify GapWizard modal appears with missing fields listed
- [ ] Test text mode: enter sale price, click Next
- [ ] Verify dossier-update-and-refill updates DB and re-renders PDF
- [ ] Verify subsequent missing fields (if any) follow same flow
- [ ] On wizard complete, verify PDF is refreshed and contains the newly entered values
- [ ] Test voice mode: speak the value, verify it captures correctly
- [ ] Test toggle between text/voice mode
- [ ] Test "Skip" button: wizard closes without saving
- [ ] Test update_deal_field voice command (e.g., "change closing date to May 15")
- [ ] Verify PDF auto-regenerates after field update (may take 2-3 seconds)

---

## Known limitations / TODOs

1. **PDF regeneration is async fire-and-forget** — no polling for completion. Atlas APV should wait 3-5 seconds before checking the rendered PDF.
2. **fill-form API may need tweaking** — currently expects `transaction_id` in POST body. May need to be called with full transaction object + new field for re-render.
3. **Frontend needs copy of getMissingRequiredFields** — currently in backend only. For Job 1 integration, copy the logic to a shared utils file or fetch it dynamically.
4. **Voice API fallback** — GapWizardVoice degrades gracefully to text mode if browser doesn't support Web Speech API.
5. **Mobile UX** — wizard modal should be touch-friendly on phone. Current implementation uses fixed positioning which works but could use media query tweaks for <390px.

---

## Deployment checklist (for Jarvis approval)

- [ ] Carter drafts files (✓ complete)
- [ ] Atlas reviews & tests on staging
- [ ] Quinn runs APV: sign in as demo, execute fill + missing fields + re-fill PDF flow
- [ ] Hadley reviews for legal / compliance concerns (none expected)
- [ ] Sage reviews for brand voice (wizard text uses "One more thing" warmly)
- [ ] Heath approves merge
- [ ] Push to main (auto-deploys to meetdossie.com)
- [ ] Update WEEKLY-IMPROVEMENTS.md with feature summary

