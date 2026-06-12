# Atlas — re-record brief for onboarding tutorial bites (Sage QC 2026-06-11)

All 5 onboarding bites failed Gate A, Gate B, or Gate C. Status reset to `draft`. Re-record per below.

## Systemic issues across all 5

1. **Wasted login intro (5-7s of a 21-23s video).** Every bite opens with viewer on the login screen for ~5 seconds while VO is already narrating the feature. On a 23s video that's 25-30% of the runtime burned. Either (a) start the recording POST-login and remove the login segment entirely from the screen-recording source, or (b) compress the login to a 1.5s cut/fade.

2. **VO ↔ visible UI sync is broken.** The narrator describes an action (tap X, open Y, send invite) and the viewer never sees that action performed. Re-record so every spoken phrase is matched by the visible UI action within 1 second — that is non-negotiable per Gate B.

3. **Mid-video freezes / static screens.** Multiple bites have ~5 seconds of identical UI (Morning Brief / Pipeline dashboard) sitting on screen while VO is talking about a different feature. Cut to the actual feature flow.

4. **Final frame doesn't show the feature.** Bites 3 and 4 end on the pipeline dashboard, never showing the invite flow complete. Bite 5 ends on Settings → Email Preferences with no team UI visible. End on the actual feature endpoint (filled form / sent invite / saved team).

## Per-bite corrective callouts

### 1. sign-up-and-complete-profile
- VO covers FOUR actions (name, brokerage, phone, review links) in the back 4 seconds. Either trim the VO or extend the Settings recording portion to ~12s.
- The viewer needs to actually SEE the name field being filled, the brokerage being entered, and the review link being pasted. Current cut shows only the static final state.
- Final frame should be a clean "Settings saved" / profile complete state, not a half-scrolled Zillow review field.

### 2. open-your-first-dossier
- First 5s burns on login while VO is already saying "let's open your first dossier."
- Frames 10s and ~12s are IDENTICAL Morning Brief screens — viewer perceives the video as frozen.
- Required visible beats: (a) tap "Open New Dossier" on pipeline, (b) select Buyer or Seller in the modal, (c) enter address, (d) confirm dossier created. Current cut shows the modal but never the completion.

### 3. invite-a-buyer
- **Hardest fail.** VO says "tap the buyer's name, send the invite" but the dossier shown in final frames is SELLER-SIDE (Pre-Listing: Sandra Martinez, Active Listing: Patricia Anderson).
- Re-record on the demo account using a buyer-side dossier (Pre-Contract: 123 main street / joe shmoe is fine, OR use a Under Contract buyer file).
- Show the actual invite click → email field → send. Not just the pipeline cards.

### 4. invite-a-seller
- Final frame is the pipeline dashboard. Viewer never sees the seller invite action.
- Required: open the Sandra Martinez (Pre-Listing) OR Patricia Anderson (Active Listing) dossier, tap seller's name, show the invite modal, show "invite sent" confirmation.

### 5. add-team-and-brokerage-info
- VO promises "team members copied on emails I draft" and "broker's contact" — the Settings page shown has NO Team Members section visible, NO add-member action, NO broker contact field separate from "Brokerage Compliance Email."
- Either (a) re-record covering only what the UI actually has (brokerage name, license, compliance email, review links) and update the VO to match, or (b) flag to Carter that the Team Members section needs to exist in the app before this video can be recorded.
- Surface this gap to Cole — likely a product/copy mismatch that needs Carter to confirm whether team-member CC is even a built feature.

## Technical specs (unchanged from rules)

- 1080x1920, H.264, 30fps, AAC 128k
- Target duration: 21-25s (current is acceptable, just better-used)
- VO ↔ video duration within 2s
- No dead air > 1.5s at head/tail
- Frame at 0.5s, 5s, mid, end must all match a phrase the VO is on at that timestamp

## Re-render and update DB

When re-rendered, upload as `<slug>-v3.mp4` and `<slug>-v3.mp3`, update `tutorial_videos.video_url` and `voiceover_url`, set `status='ready'`, and ping Sage to re-run QC.

## QC frame samples (for reference)

Frames extracted at: `C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp-qc\onboarding-v2\frames\<slug>\`
