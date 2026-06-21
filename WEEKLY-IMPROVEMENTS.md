# Dossie Weekly Improvements — for Heath to post to socials + Founding Files

This file is a running customer-friendly changelog. Items go in **in plain English**, no engineering jargon — read like an email to a real estate agent who has never seen the codebase. Each Friday (or whenever Heath wants to post), he can copy-paste the week's section into Facebook / Instagram / LinkedIn / the Founding Files FB group.

**Voice rules:**
- Lead with the benefit, not the implementation. "Scanning works on your phone now" beats "fixed onChange handler in file input."
- No technical terms: no "bundle", "z-index", "API", "TypeScript", "useEffect", "Vercel", "Vite", etc.
- "We" instead of "I" — feels like a team.
- Keep each item to 1-2 sentences max.
- Mention WHO asked for it when relevant ("Brittney pointed out that…") — gives Founding members credit.

---

## Week of June 15, 2026

**Smoother Earth visualization and grid overlay** (customer)
- We refined the look of the Earth globe on your dashboard — the atmosphere glow is now more subtle, the hex grid overlay is crisper and more visible, and the city lights show through better without washing out. The whole globe animates more smoothly as it rotates.

**Earth orb visualization now shows real city lights** (customer)
- We replaced the simple blue sphere with a detailed Earth showing real city lights at night, shipping lanes, and a rotating grid background. The globe now spins smoothly on both desktop and mobile.

**Portfolio tiles display more consistently** (customer)
- We improved how your portfolio tiles are sized and positioned so they stay centered and easier to scan on the portfolio page.

**Mobile portfolio grid displays clearly** (customer)
- We fixed the mobile view so your property portfolio grid no longer overlaps with side panels, and made the tiles more opaque so you can see your listings without distraction.

**Money Pulse, Voice Brief, and Daily Debrief** (customer)
- We've added Money Pulse to show your month-to-date revenue at a glance, plus a new voice-powered morning briefing that reads your key metrics aloud and alerts you to important changes. You'll also get a daily debrief summary to stay on top of your business.

**Cleaner Earth map and new voice for morning briefings** (customer)
- We cleaned up the Earth visualization to make city lights easier to see and switched to a new British voice for your morning briefing that sounds more like the original Jarvis assistant.

**Visual indicators and live activity feeds on dashboard panels** (customer)
- We added subtle corner brackets that highlight when you hover over dashboard sections, making it easier to see what you're interacting with. We also added live activity feeds at the bottom of key panels so you can quickly see the latest updates from your agent activity, decisions, incidents, and money pulse data without scrolling.

**Larger orb and clearer agent status display** (customer)
- We made the Talk-to-Dossie orb bigger and easier to see on your screen. Agent activity now shows at a glance with color-coded status indicators instead of text, so you can quickly spot who's working, idle, or experiencing issues.

**Fixed audio stuttering on mobile devices** (customer)
- We fixed an issue where the morning brief audio would skip or stutter on mobile phones like Samsung Z Fold. The audio now plays smoothly on all devices.

**Streamlined portfolio display** (customer)
- We cleaned up the portfolio section on your dashboard to show only our core products, giving you a cleaner view of what we offer.

**Mobile layout fixes and Jarvis voice upgrade** (customer)
- We fixed the mobile experience on foldable phones so the interactive globe displays correctly without overlapping your header. We also upgraded Jarvis's voice to a richer, deeper British tone that better matches the original character.

**Fixed mobile layout alignment at 900px width** (customer)
- We fixed a rare display issue where the app could show desktop and mobile layouts at the same time on devices exactly 900 pixels wide. Now the app consistently shows the correct mobile layout on smaller screens.

**Pre-listing and pre-contract columns restored** (customer)
- We've fixed a bug that was hiding pre-listing and pre-contract transaction columns in your workspace. Your transaction pipeline should now display all stages correctly.

**Pre-Listing and Pre-Contract stages restored** (customer)
- We've restored the Pre-Listing and Pre-Contract pipeline stages that were temporarily unavailable. Your transaction workflows now include all stages again.

**Fixed Earth globe stretching on mobile** (customer)
- We fixed a bug where the Earth globe appeared stretched and oval-shaped on mobile phones and folding devices. The globe now renders with the correct proportions on all screen sizes.

**Fixed session timeout issues in Today panel** (customer)
- We fixed a bug where the Today panel (money pulse, tickers, morning brief, and merge queue) would stop working after you left the tab idle for an hour. The panel now refreshes your session automatically so everything keeps working smoothly.

**Fixed voice brief loading errors** (customer)
- We fixed an issue where the voice brief feature would occasionally fail to load. Your voice briefings now work reliably every time.

**Pre-listing emails now include attachments** (customer)
- We've added support for sending attachments with your pre-listing fix confirmation emails. Your screenshots and documents will now arrive directly in the email, saving you time on follow-ups.

**Fixed voice pronunciation and login stability on mobile** (customer)
- We fixed how Dossie speaks task reminders so they sound natural in English. We also improved login reliability on mobile phones by adding a brief retry when the app briefly loses connection in the background.

**Fixed unexpected logouts on mobile** (customer)
- We fixed a bug that was signing agents out unexpectedly on mobile devices. We also improved how the morning brief pronounces task names in Spanish.

**Agents can now change their password** (customer)
- We've added a secure password change option in your account settings, so you can update your login credentials whenever you need to.

**Fixed production crash on password change** (customer)
- We fixed a critical bug that caused the app to show a blank screen when agents tried to change their password. The app is now stable again.

**Change your password in Settings** (customer)
- We added a secure way for you to change your password directly in the Dossie app without logging out. Your new password takes effect immediately on your next sign-in.

**Pre-Listing and Pre-Contract stages restored** (customer)
- We've fixed a bug that was hiding your pre-listing and pre-contract transactions from view. Your deals in these early stages will now show up correctly in Dossie.

**Change your password in Settings** (customer)
- You can now update your password directly in the app without logging out. We'll verify your current password and confirm your new one matches before saving.


---

**Teams and brokerage support now available** (customer)
- Agents can now invite team members to collaborate on transactions and manage permissions within Dossie. We've added secure consent controls so agents can authorize team access to sensitive transaction data.

**Team accounts and consent management** (customer)
- We've launched team accounts so brokerages can manage multiple agents under one account, with role-based access control and billing by seat. Agents can now accept consent agreements through a secure link before joining a team.

**Talk-to-Dossie now answers TREC questions** (customer)
- We've added TREC question-and-answer support to Talk-to-Dossie, so you can ask about Texas real estate commission rules and get instant answers with citations to the exact regulations.

**Jarvis voice chat now remembers conversations** (customer)
- We fixed critical issues with Jarvis, our AI voice assistant. Your conversations now pick up where you left off, the app loads faster on mobile, and it handles poor audio gracefully instead of showing errors.

**Talk-to-Dossie voice sessions stay connected longer** (customer)
- We fixed an issue where long voice conversations with Dossie would disconnect and require you to sign back in. Your session now automatically refreshes in the background so you can keep talking without interruption.

**Microphone now properly releases after voice messages** (customer)
- We fixed a bug where the microphone stayed active in the background even after you finished recording a voice message, which could interfere with other apps on your phone. The mic will now cleanly turn off every time, whether you send the message, close the app, or switch tabs.

**Talk-to-Dossie voice recognition now more reliable** (customer)
- We've upgraded the speech-to-text technology powering Talk-to-Dossie to reduce service interruptions and improve accuracy when you dictate information into your dossiers.

**Talk-to-Dossie now feels like natural conversation** (customer)
- We fixed Talk-to-Dossie to work like a real conversation — tap once to start talking, the app listens continuously and automatically detects when you finish speaking, then responds. Tap again when you're done. No more awkward press-and-release for every single sentence.

**Talk-to-Dossie responds faster** (customer)
- We reduced the wait time after you stop talking, so Talk-to-Dossie now responds about 0.7 seconds quicker. You'll experience less latency when having conversations with Dossie.

**Faster responses in Talk-to-Dossie** (customer)
- We've made Jarvis respond more quickly after you finish speaking, cutting the wait time by about a fifth of a second for snappier conversations.

**Faster voice responses in Talk-to-Dossie** (customer)
- We've sped up Talk-to-Dossie's voice replies by streaming audio as it's generated, so you hear Dossie's answer roughly 2.5 seconds faster. The app now plays audio sentence-by-sentence as soon as each one is ready, instead of waiting for the full response.

**Animated Earth globe now in Jarvis PWA** (customer)
- We've added the same rotating Earth visualization to the Jarvis PWA that was in the web app, giving you a more polished and engaging interface when you open Talk-to-Dossie on mobile or desktop.

**Jarvis voice brief, calendar, and quick-ask features** (customer)
- We've added a morning voice brief that reads you key information, integrated your calendar so you can see today's and tomorrow's events, and built a quick-ask feature so you can ask Jarvis questions and get answers back as audio. These tools help you stay on top of your business without leaving the app.

**Talk-to-Dossie button now centers perfectly on all phones** (customer)
- We fixed the microphone button to stay centered on your screen no matter what device you use, and made sure all the buttons and text are easy to tap on smaller phones like foldables.

**Fixed mobile layout overflow issue** (customer)
- We fixed a bug where content on mobile phones was stretching way too wide and forcing horizontal scrolling. Your app now displays properly on smaller screens without unwanted scrolling.

<!-- applied_shas: 0bc1e3c,10cf6fb,117949f,1a6e9a1,2637b00,29f9aa4,404a9b9,499cfce,49fce9c,4bf5932,5287fba,5e89003,5fc3990,654af68,69f1b2b,70ae540,748b24d,79c1023,7b61808,87f980b,9178819,924446f,99ee638,9cfb06f,a22c5a7,aaa3f82,b4a46e5,b4df9df,b549282,b888ac9,bcd8b18,c67872e,c7e1138,d5d3ad1,e36fc31,e627144,ea86f86,f393f86,f98eba4,fafb513 -->

## Week of June 5, 2026

**Auto-post system — social media runs itself now**
- Social media posts now go out every day automatically without requiring manual approval. DossieMarketingBot sends a preview 30 minutes before each post. Tap Reject only if you want to stop a specific post. Nothing required on a normal day.



**Activation emails are now actually running**
- The onboarding check-in emails Dossie sends at days 4, 7, and 14 after signup were never actually going out - they were built but not scheduled. They are now running daily and will send to every active member at the right intervals going forward.

**Credit monitor fixed**
- Dossie's internal alert system watches our ElevenLabs voice credit balance and texts an alert when it gets low. A code issue was causing it to crash silently on every run. Fixed - it is now checking balances correctly and will fire alerts when credits drop below the threshold.

**Activation emails only go to active members**
- The activation drip now checks that a member's subscription is active before sending. Cancelled accounts no longer receive onboarding emails.

**Testimonial requests - new feature** (APV-passed)
- A "Request Testimonial" button now appears on any closed deal. One tap sends an email to your client with your Google and Zillow review links already filled in. No more hunting for links or drafting the ask yourself. Tiffany Gill asked for this one.
- The request also fires automatically 3 days after a deal closes so you never have to remember to ask.
- Add your Google and Zillow review profile links in Settings once and Dossie uses them on every send going forward.
- Verified in production 2026-06-18: button click works, URLs persist in Settings, real email delivered to client inbox, 3-day auto-fire cron confirmed running.

---

**Fixed testimonial request email delivery** (customer)
- We fixed a bug that could cause testimonial request emails to fail silently when your user profile wasn't set up yet. We also improved the testimonial request form to show a helpful prompt instead of broken links when review URLs are missing.

**Fixed greeting capitalization in testimonial emails** (customer)
- We fixed a small bug where customer names appeared in lowercase in our testimonial request emails. Your name now displays correctly in the greeting.

**New TREC July 2026 compliance guide** (customer)
- We added a comprehensive guide covering all mandatory Texas real estate form updates effective July 1, 2026, including new categories and revised forms to help you stay compliant.

**Voice features now more reliable** (customer)
- We improved the reliability of voice features like Talk-to-Dossie and video generation by adding a backup voice service. If our primary service has any hiccups, we automatically switch to a backup so your voice features keep working.

**Track warm leads before contract** (customer)
- We've added a new pre-contract stage so you can log prospect names, addresses, and follow-up dates before deals move to contract. Your pipeline now shows warm leads separately with overdue indicators so you never miss a follow-up.

**Pre-contract dossiers now work correctly** (customer)
- We fixed issues that were blocking agents from creating pre-contract dossiers. You'll now see the right checklists and deadline rules when you start working with warm leads and pre-approval clients.

**Six pipeline management features for pre-contract deals** (customer)
- We've added new ways to organize and track your pipeline deals: mark where leads came from (Facebook, referral, open house, etc.), set deal readiness status and temperature (hot/warm/cold), log touchpoints as you work with clients, draft follow-up messages with AI help, and archive cold leads to keep your active pipeline clean.

**Delete closed dossiers and cold leads** (customer)
- You can now permanently remove closed dossiers and cold leads from your workspace with a single click. We added delete buttons to these sections with a confirmation step to prevent accidental removal.

**Track seller leads before listing goes live** (customer)
- We added a new pre-listing stage so you can organize and follow up with seller leads before their property hits the market. You'll see warm lead cards with temperature tracking, checklists, and a button to move listings live when ready.

**Fixed mobile status card layout** (customer)
- We fixed a display issue on mobile where status card labels were getting squeezed. Labels and buttons now stack cleanly so you can read all the information clearly on your phone.

**Pre-listing dossiers now save properly** (customer)
- We fixed a bug that prevented agents from creating pre-listing dossiers. These dossiers can now be saved and used even before a property address is added.

**Fixed mobile banner text overlap on small screens** (customer)
- We fixed a layout issue on mobile phones where text in important disclosure banners (IABS and Seller Disclosure) was overlapping buttons. Now the button moves below the text on narrow screens so everything is readable and clickable.

**Fix mobile button text wrapping** (customer)
- We fixed status buttons on mobile that were awkwardly breaking words in half. Now your button labels stay on one line and read clearly on your phone.

**Fixed mobile Log It input display** (customer)
- We fixed a layout issue on mobile where the Log It form was collapsing into a tiny white box. The input field and button now stack properly so you can easily log touchpoints on your phone.

**Track seller check-in dates on listings** (customer)
- We've added a seller check-in date field to your active listing dossiers so you can schedule and track follow-ups. The app highlights overdue check-ins in red on both your deal details and pipeline card.

**Fixed seller check-in date display** (customer)
- We fixed a bug where check-in reminders were showing the wrong day for agents in Central Time. Sellers will now see accurate 'Check in today' notifications at the right time.

**Pre-contract dossiers now show client name fields** (customer)
- We added support for pre-contract dossiers so you can start entering client details before an offer is made. You can also set a target timeline for when you expect the contract to close.

**Weekly pipeline stage announcements** (customer)
- We now send you a weekly Thursday email highlighting your pre-listing and pre-buyer pipeline stages, so you can stay on top of your deals without logging in.

**Auto-apply recommended forms to new dossiers** (customer)
- When you create a new dossier, we now show a quick one-tap banner that automatically adds the right set of forms based on your transaction type. The banner disappears once your forms are set up, saving you time on manual setup.

**Daily morning brief emails** (customer)
- We now send you a personalized email each morning at 7 AM with your deadlines, closing deals, open tasks, and a quick audio summary — so you start each day fully caught up.

**Morning Brief redesign and faster loading** (customer)
- We've redesigned your Morning Brief with clearer headers and a more focused 4-item layout, plus made it load noticeably faster so you can get started quicker each day.

**Smoother voice narration during service hiccups** (customer)
- We fixed an issue where voice narration would read technical markup instead of pausing naturally when our primary voice service had problems. Now narration sounds clean and professional no matter which service handles it.

**Cleaner inbox for operational emails** (customer)
- We stopped adding blind copies to your deadline reminders, morning briefs, and signing notifications, so your email stays focused on what matters. Marketing emails from us still include the blind copy as before.

**Cleaner emails from Dossie** (customer)
- We removed hidden copy addresses from operational emails so your inbox stays organized and you only see messages meant directly for you.

**Smoother, more lifelike orb animation** (customer)
- We've refined the animated orb that appears in Dossie to have slower, more natural smoke movement and deeper visual depth. The effect now feels more calming and polished when you interact with it.

**Orb video now has softer, more natural glow** (customer)
- We've updated the Orb animation to feature a feathered glow effect that looks more like sunlight filtering through clouds, making it feel warmer and more inviting when you're using Talk-to-Dossie.

**Smoother orb animation and clearer audio-reactive button** (customer)
- We improved the orb's smoke effect to loop seamlessly without visual glitches, and made the speak button more noticeable with a breathing glow and on-page preview so you can see the audio-reactive pulse in action right away.

**Tutorial videos now available in help center** (customer)
- We've added video tutorials to help you get started faster. Watch walkthroughs for signing up, opening your first dossier, inviting buyers and sellers, and setting up your team.

**Tutorial videos now display correctly on mobile** (customer)
- We fixed an issue where our tutorial videos were cutting off on the sides when watched on phones. Now the full video appears properly on mobile screens with a branded border, so you can see everything clearly.

**Fixed UI overlaps and improved visual polish** (customer)
- We fixed a few visual issues: the help badge no longer covers pipeline cards, modals now have a clearer backdrop so they stand out better, and demo tutorials use realistic names instead of placeholder text.

**Tutorial videos now show full actions clearly** (customer)
- We fixed our setup tutorial videos so you can see every button click and action without audio cutting off or content going off-screen. The videos are clearer and easier to follow from start to finish.

**Fixed demo account names and file creation message** (customer)
- We cleaned up demo account data to show realistic names instead of placeholder text. We also fixed a bug where creating a new file would show an empty message -- now it properly confirms 'I've started the file for [client name].'

**Tutorial videos now match actual workflow** (customer)
- We updated our onboarding tutorial videos to show exactly what you'll do in Dossie — naming your buyer or seller — instead of outdated steps. The videos are clearer and faster to follow.

**Fixed confusing toast notification text** (customer)
- We fixed a bug where deal notifications would show incomplete text like 'for .' when client names weren't filled in properly. Notifications now display correctly even with unusual spacing in names.

**Contract fill-in now works reliably** (customer)
- We fixed an issue where contract fields weren't always matching up correctly, causing fill-in failures. Your contracts will now extract and populate accurately every time.

**New FAQ and Learn hub for self-service help** (customer)
- We launched a searchable FAQ page and unified Learn hub so agents can quickly find answers to common questions, explore tutorials, and discover our calculators — all without leaving the Dossie site. Talk to Dossie now suggests relevant help articles when you ask how-to questions.

**New welcome email and help center for new agents** (customer)
- We've redesigned the welcome email new agents receive to introduce you to all eight core features of Dossie and point you straight into the app. We've also added a built-in help center so you can quickly find answers about Getting Started, Morning Brief, Talk to Dossie, DossieSign, TREC deadlines, Compliance Vault, and sharing milestones.

**Land purchase transactions now fully mapped** (customer)
- We've connected all 29 land purchase fields to your transaction data, so your land deal information flows seamlessly into Dossie without manual re-entry.

**Helpful guidance when you have nothing yet** (customer)
- We added smart tips that appear when your pipeline, documents, or task lists are empty, so you know what to do next. We're also building a help center with articles to answer your questions right inside the app.

**Talk-to-Dossie can now fill and sign forms** (customer)
- Agents can now ask Talk-to-Dossie to fill out forms, and we'll generate a signed PDF ready to download right in the chat. This saves time on manual form completion.

**Support for HOA and lead paint addendums** (customer)
- We now automatically extract and fill HOA addendum and lead paint disclosure addendum fields in your dossiers, saving you time on these required Texas real estate forms.

**Faster, more reliable Texas real estate form filling** (customer)
- We've upgraded how we fill Texas real estate forms to be more accurate and faster. Your resale contracts, financing addendums, HOA addendums, and lead paint disclosures will now fill correctly every time.

**Fix document signing with correct signer names** (customer)
- We fixed an issue where document signing templates weren't using the correct signer names, which could cause signing errors or confusion. Your documents will now populate with the right names when sent for signature.

**Voice chat now works in Dossie HUD** (customer)
- We've connected the talking orb in your Dossie interface so you can now speak to Dossie, hear responses, and see real-time feedback as the orb listens and thinks. Tap the orb to start talking — it's the same voice experience that was previously only available in our web demo.

**Fix DocuSeal form submission errors** (customer)
- We fixed an issue where document signing could fail when customer information wasn't complete. Now forms will submit successfully even when some data is missing.

**Fixed fill-and-sign email handling** (customer)
- We fixed an issue where placeholder email addresses in fill-and-sign documents weren't being recognized properly. Customers will now see email fields work correctly when pre-filling signing documents.

**Fix document fill errors** (customer)
- We fixed crashes that happened when agents tried to fill and sign certain documents. Your forms should now load and submit without errors.

**TREC 20-18 form filling now fully supported** (customer)
- We've completed support for all 263 fields in the TREC 20-18 resale contract form, so you can now fill and sign these documents directly in Dossie without switching to other tools.

**TREC 20-18 forms now fill automatically** (customer)
- We've built complete support for the TREC 20-18 resale contract form, so your transaction documents now fill in automatically with the right data. This replaces our previous manual routing and gets your paperwork ready faster.

**New help resources and customer reviews section** (customer)
- We've added a Help FAQ button and a new Reviews Settings tab so you can manage customer testimonials and access support resources directly in Dossie.

**Help, FAQ, and reviews now in settings** (customer)
- We added a Help section, frequently asked questions, and a way to manage your customer testimonials and reviews all in one place within your account settings.

**New Help and Reviews section in settings** (customer)
- We've added a Help FAQ, customer testimonials, and a Reviews settings tab so you can easily access answers to common questions and manage your customer feedback in one place.

**Help modals now display correctly with videos** (customer)
- We fixed a display issue with our help dialogs and added support for instructional videos, so you get better guidance when you need it.

**Help modal now shows relevant articles** (customer)
- We fixed an issue where the help modal was displaying incorrect information. You'll now see only the articles that actually help answer your question.

**Fixed help modal display issue** (customer)
- We fixed a bug where the help modal wasn't showing articles correctly. Your help content now loads and displays as intended.

**Fixed app loading issue** (customer)
- We fixed a critical bug that was preventing the Dossie app from loading. Agents can now access their workspace without any issues.

**Voice commands now work reliably** (customer)
- We fixed the 'CONNECTION HICCUP' error that was breaking voice input. Your voice commands to Talk-to-Dossie will now process smoothly without dropping the connection.

**Improved testimonial message wording** (customer)
- We've refined the wording in our testimonial notifications to be clearer and more helpful as you work in Dossie.

**Testimonial request state now persists correctly** (customer)
- We fixed an issue where the 'Testimonial sent' button would revert after you reload the page. Now the button correctly stays in the sent state, and your client will receive the testimonial request email as expected.

**Fixed blank page on today view** (customer)
- We fixed a technical issue that was causing the today view to load as a blank page. The view should now display properly for all agents.

**Today page sign-in and visual polish** (customer)
- We fixed the sign-in button so you can now log in directly from the today page. We also upgraded the visual design with improved graphics and a refreshed look.

**Fixed Orb positioning on mobile and desktop** (customer)
- We adjusted where the Orb appears on your screen so it no longer blocks important content on mobile phones or desktop computers.

**Fixed mobile orb positioning** (customer)
- We fixed the animated orb that appears in the Dossie app on mobile devices so it now stays in the correct spot at the top-right corner, no matter what device or screen size you're using.

**Contract scanning now works reliably** (customer)
- We fixed a bug that was preventing contract scans from uploading. Your scans will now process successfully every time.

**Fixed contract scanning authorization error** (customer)
- We fixed an issue where contract scans were failing to load. Your contract uploads should now work reliably again.

**Upload file size limit increased to 50MB** (customer)
- We've increased the maximum file size you can upload to Dossie from 10MB to 50MB, so larger documents and scans won't get rejected during your workflow.

**Scan Contract now handles large PDFs** (customer)
- We fixed a login issue when scanning contracts and added support for PDFs up to 50MB, so you can upload larger documents without hitting errors.

**Fixed document upload authentication** (customer)
- We fixed a bug that could prevent you from uploading scanned contracts. Documents now upload reliably without authentication errors.

**Upload large contract scans without errors** (customer)
- We fixed an issue where scanning large PDFs (over 4.5MB) would fail. Now agents can upload contracts of any size directly from the Dossie app.

**Fixed PDF scanning on preview links** (customer)
- We fixed an issue that was blocking large PDF uploads when accessing Dossie through preview or staging links. PDF scanning now works smoothly across all access methods.

**Fixed scan contract upload reliability** (customer)
- We fixed a bug that was preventing contract scans from uploading correctly. Your scanned documents will now upload smoothly every time.

**Fixed document scanning upload errors** (customer)
- We fixed an issue preventing agents from uploading scanned documents in some cases. Scanning should now work reliably when you need to attach contracts or other files.

**Testimonial button state now saves correctly** (customer)
- We fixed an issue where the testimonial request button would reset after you reload the page. Your button state now persists properly so you won't accidentally re-request a testimonial you've already asked for.

**Larger file uploads now supported** (customer)
- We've increased the maximum file size you can upload from 3.3MB to 50MB, so you can now handle larger documents and scans without hitting upload limits.

<!-- applied_shas: 07e825a,0843a3d,0912a4d,0a6ba5c,0b0b66a,0c28c60,0e9bdfb,10d193a,11847dc,13f2c3e,1592e16,230760e,24ebafe,25e1a90,267e81e,2b80e3a,2d2cfea,2d7b31a,2e66c98,35aba84,3bec469,42a4e45,42c0fdf,49aac5a,4ebfaa9,4f0eea3,559db6b,5710ac1,5c017b2,5c25b94,62c58af,631a020,63b8318,65a1d9f,6bcd734,715f06e,72cd2c5,7660e1e,7ad3933,7e38d91,831d282,867047d,87d3679,8b28bf1,9383da2,952cafd,a768edf,ab213c4,abbc2ee,b06ee7b,b3baa27,b7521b6,bdeca8f,bfda8b7,c117288,c159c51,c663522,c76ff90,c7caf5a,cbb99b1,cc72b79,cfcc6e5,d73dcf2,d75babd,e1c47f8,e4a3a1e,e69f203,e6d4d69,e8d46cc,ec9d564,ee5a7d9,f3e0f9a,f41bc7e,f434745 -->

## Week of May 29, 2026 (fill-and-sign expansion)

**Fill-and-sign now works for land and new construction contracts**
- Tell Dossie "fill out a contract for [address]" on a land or new construction dossier and she picks the right TREC form automatically. Land purchases use TREC 9 (Unimproved Property Contract). Farm and ranch deals use TREC 25 (Farm and Ranch Contract). New construction uses TREC 23 (incomplete) or TREC 24 (completed) depending on where the build stands. No more downloading the wrong form.
- All four new forms are embedded and ready - no setup required.

---

## Week of May 29, 2026 (hotfix)

**Form Library cleaned up**
- The Land Purchase form package was carrying extra forms it didn't need (New Home Contract forms snuck in during the build). Cleaned up - it now contains exactly the right five forms: TREC 9, TREC 25, Financing Addendum, Buyer Rep Agreement, and Wire Fraud Warning.

---

## Week of May 29, 2026 (continued, late build)

**Residential Lease transactions - Landlord and Tenant**
- Dossie now tracks rental transactions, not just purchases. When you create a new dossier, choose "Residential Lease (Landlord)" if you represent the owner, or "Residential Lease (Tenant)" if you represent the renter.
- Every lease dossier gets its own Lease section with all the fields that matter: monthly rent, security deposit, pet policy and pet deposit, application fee, lease start and end dates, and an auto-calculated lease term.
- Key dates are tracked in one place: application submitted, application approved, lease signed, move-in, move-out, and a renewal deadline Dossie calculates automatically as 60 days before the lease ends.
- If you represent the landlord, Dossie tracks the tenant's contact info, number of occupants, and whether background and credit checks are complete. If you represent the tenant, Dossie shows the landlord's contact info instead.
- The Move-In Condition Report section lets you check it off as complete and note any pre-existing damage in writing - timestamped and saved.
- Three lease-specific reminder emails fire automatically: when the renewal deadline is 30 days and 7 days away, the day before move-in, and an urgent alert if HOA approval is required but not received within 7 days of lease start.
- The lease form package (TAR 2001 Residential Lease, TAR 2003 Move-In Condition Form, Wire Fraud Warning) attaches automatically when you create the dossier.
- Talk to Dossie understands lease updates: say "application approved," "lease signed," "tenant moves in June 1," "monthly rent is $1,500," or "background check complete" and Dossie records it instantly.

---

## Week of May 29, 2026 (continued, evening build)

**New Construction (Buyer) transaction type**
- Dossie now handles new construction purchases as a completely separate transaction type — not just a relabeled resale dossier. When you create a dossier for a new build, you get everything the resale flow has plus a full Builder section built specifically for how builders work.
- The Builder section tracks the builder company name, the sales rep's name, phone, and email, and the contract date with the builder. When you get the warranty document, you check it off and Dossie records it. If the builder warranty is expiring in the next 30 days, Dossie sends you a reminder email.
- The Construction Phase Tracker follows the home from Foundation through Certificate of Occupancy — seven phases total. Tap any phase and set it to Not Started, In Progress, or Complete. Dossie timestamps it when you mark it complete.
- CO and possession are tracked separately from the closing date so nothing gets confused. Set the expected completion date, and if the CO hasn't been received within 7 days of that date, Dossie sends you a warning email.
- The Punch List section gives you a free-text area to capture everything found on the final walkthrough. When all items are cleared, check "Punch list cleared" and Dossie records the date.
- The New Construction form package is now in the Form Library: TREC 23 (incomplete construction), TREC 24 (completed construction), Third Party Financing Addendum, Buyer Rep Agreement, and Wire Fraud Warning. Apply all five to a dossier in one tap.
- Talk to Dossie understands new construction updates: say "CO received," "builder warranty expires June 15," "punch list cleared," or "the builder rep is John Smith at 210-555-1234" and Dossie updates the dossier immediately.

---

## Week of May 29, 2026 (continued, afternoon build)

**Pre-Contract dossiers**
- You can now open a dossier before you have a signed contract. Choose "Pre-Contract" when creating a new file and Dossie tracks the three things that matter in the showing phase: IABS delivery, the buyer rep agreement, and the pre-approval letter. Check each one off as it lands. When all three are done, Dossie prompts you to advance the dossier straight to Under Contract.
- Every active dossier now shows a soft reminder if the IABS hasn't been recorded as delivered — the banner shows up in the Deadlines section so it's the first thing you see.

**Offer comparison (seller-side)**
- Seller-side dossiers now have an Offers tab. Log each offer as it comes in — price, financing type, earnest money, option fee, option days, closing date, escalation clause. Dossie color-codes each offer (green = over list price, yellow = near list, red = below) so you can read the room at a glance. Update each offer's status (Pending / Accepted / Rejected / Countered) with one tap.

**Seller's Net Sheet**
- Right inside the Offers tab, click "Net Sheet" and enter the commission, mortgage payoff, escrow fee, and title costs. Dossie calculates the seller's estimated net proceeds in real time — line by line. Hit Print to get a clean PDF you can hand the seller at the listing appointment.

**Lead Paint disclosure banner**
- If a property was built before 1978, Dossie now shows a red banner in the dossier telling you the Lead Paint Addendum (OP-L) is required. No more forgetting on older homes.

**Seller's Disclosure reminder**
- Seller-side dossiers now show a reminder if the Seller's Disclosure Notice (OP-H) hasn't been received yet. Tap to mark it received and Dossie timestamps it.

**More forms for fill-and-sign (DossieSign)**
- Five more forms are now available through Talk to Dossie: HOA Addendum, Lead Paint Addendum, Buyer Rep Agreement, TREC 49-1 (Appraisal Termination), and T-47 Affidavit. Note: these forms use placeholder PDFs until the official TREC/TAR versions are loaded by Heath — the structure is live, just needs the real PDFs dropped in.

**MLS number now shows in the dossier header**
- For seller-side transactions, the MLS number now appears prominently at the top of the dossier so you never have to dig for it.

---

## Week of May 29, 2026 (continued)

**Title commitment and survey tracking**
- Every dossier now has a Title Commitment and Survey section. Tap to record when the title commitment arrived, what the effective date is, when the survey was ordered, and when it came back. Check off "Survey clear" when the title company confirms it. Dossie tracks all of it in one place.
- You can also mark the loan as approved and flip the "Clear to close" toggle right from that section. If the loan approval deadline is three days away and the loan hasn't been confirmed, Dossie sends you a reminder email.

**HOA document tracking (expanded)**
- The HOA section now tracks when you requested the HOA documents and when they arrived. Check off "received" and Dossie timestamps it. If the HOA document deadline is three days away and the documents haven't come in, Dossie sends you an email reminder.

**Closing checklist**
- Each dossier now has a built-in pre-closing checklist so nothing slips through on closing day. Buyer-side dossiers get: CD reviewed, commission amounts verified, prorations verified, payoff confirmed, wire fraud warning acknowledged, final walkthrough, repairs verified, and fixtures confirmed. Seller-side dossiers get: CD reviewed, net proceeds match, payoff confirmed with lender, and keys ready. Check each item off as you go.

**Post-closing tracking**
- After the close, Dossie tracks the three things that always get dropped: recorded deed received, title policy delivered to the buyer, and CDA signed by the broker. Check all three and Dossie offers to archive the dossier automatically.
- CDA (Commission Disbursement Authorization) has been added to the Form Library so you can attach it to any dossier.
- T-47 Residential Real Property Affidavit has also been added to the Form Library.

**Download ZIP improvements**
- The compliance ZIP download is now formatted for SkySlope and Dotloop. Documents are automatically sorted - contract first, then amendments, then addenda, then disclosures - and each file gets a numbered prefix (01-Contract.pdf, 02-Amendment.pdf, etc.) so your brokerage portal uploads them in the right order.
- Every ZIP now includes a cover sheet (00-COVER.txt) with the property address, buyer and seller names, and document count for easy reference.

**Land purchase dossiers**
- We added a full Land Purchase transaction type. When you open a file for vacant land, Dossie shows a dedicated Land Details section with everything a land deal needs: total acreage, legal description, parcel/tax ID, current zoning, deed restriction review, survey type (boundary, ALTA, fence), survey ordered/received dates, utilities confirmed (water, sewer, electric, gas, internet, road access), FEMA flood zone, wetlands flag, and Phase 1 environmental study tracking. The Land Purchase form set (TREC 9 Unimproved Property Contract, TREC 25 Farm and Ranch, Third Party Financing Addendum, Buyer Rep, and Wire Fraud Warning) is auto-attached when you create the dossier. You can also tell Dossie things like "survey received" or "flood zone is Zone X" and she updates the file automatically.

---

## Week of May 29, 2026

**Option period tracking**
- Dossie now tracks the option fee in detail: how much it was, who it was paid to, and when it was delivered. All editable right inside the dossier.
- Earnest money gets its own tracking section too: deposit amount, when it was sent to title, and when title confirmed they have it. If your option period is expiring soon and earnest money hasn't been confirmed, Dossie will warn you right on the screen and send you a reminder email.

**Inspection tracking**
- The Inspection section in every dossier now shows the inspector's name, phone, and email alongside the inspection date. You can record when the inspection happened and check off when the report came in. If the inspection isn't done three days before your option expires, Dossie will flag it.

**Appraisal tracking**
- Dossie now tracks when the appraisal was ordered, when it came back, and the appraised value. If the home appraises below the sale price, a red banner appears right in the dossier telling you exactly how big the gap is and reminding you about the TREC 49-1 option.
- TREC 49-1 (Right to Terminate Due to Lender's Appraisal) is now in the Form Library so you can attach it to any transaction in one tap.
- If the appraisal deadline is two days away and no appraisal has been received, Dossie sends you an email reminder.

**Repair amendments**
- You can now ask Dossie to "draft a repair amendment for the HVAC filter and the leaking faucet in the master bath, deadline June 15" and she'll fill out TREC 39-10 with a numbered list of repairs and the completion deadline. No more typing it out by hand.

---

## Week of May 13–20, 2026

**App + mobile**
- The Dossie app now works cleanly on your phone. Full mobile audit and redesign pass: forms stack one field per row, the right keyboard pops up automatically (numeric for prices, email keyboard for emails, phone keyboard for phone numbers), every button is now finger-friendly (44px minimum), modals scroll within the screen instead of getting cut off, and pinch-to-zoom now works if you want to take a closer look.
- The section tabs at the top of each deal (Deadlines / Deal / Property / Title / etc.) now have a soft fade at the right edge so you can tell at a glance that there's more to swipe through.
- Talk to Dossie is always one tap away on mobile. As soon as you start scrolling, the top bar transforms into a big, full-width "📞 Talk to Dossie" button that follows you down the page — never have to scroll back up to get to her.
- The Talk to Dossie button on mobile now sits right next to your avatar at the top, instead of floating in the middle of the screen.
- The Pipeline icon in the bottom navigation now correctly takes you back to your full pipeline view when you're inside a deal (used to get stuck on the deal screen).
- Switching between Brief / Pipeline / Emails / Settings remembers where you scrolled on each tab — no more jumping back to the top every time.
- Removed those subtle outline borders around the sidebar that made the app feel cluttered.

**Compliance card redesign**
- The contract scan report got a friendly facelift. Instead of a harsh red "compliance issues" warning, you now see "A few things to check" with each finding grouped into collapsible sections (Missing initials, Missing addenda, etc.) — so you can expand only what matters to you.
- New "Everything looks good ✓" section shows you what passed (signatures, initials, blank fields, etc.) so you can see the wins, not just the gaps.
- The full AI summary is now tucked behind a "See full details" toggle — collapsed by default so the report doesn't read like a wall of text.

**Scanning improvements**
- Scanning an Executed Contract now auto-fills five more deadline dates that were getting missed before: Possession Date, Appraisal Deadline, Survey Deadline, HOA Document Deadline, and Loan Approval Deadline. So your dossier comes pre-loaded with the dates that matter the moment you upload the signed contract.
- Mobile scan now gives you clear feedback at every step — when the file is received, when it's uploading, when it's working, and exactly what went wrong if something fails (instead of silently doing nothing).
- Clearer error message if a PDF is too big to scan, so you know to compress and re-upload instead of waiting forever.
- Softer wording when the scan finds items to review — "a few notes to review below" instead of "has compliance issues."

## Week of May 21–27, 2026

**Follow-up emails are clearer now**
- When Dossie sends an automatic follow-up on a task you haven't heard back on, the email now shows which deal it's about — the property address shows up in the subject line and at the top of the message. No more "wait, which file is this?" when you've got three deals open.

**Notes from Heath:**
- Pending: weekly post draft → copy specific items above into your Facebook Founding Files post.

## Week of May 28, 2026

**DossieSign — fill it, sign it, send it**
- You can now send contracts for digital signature right inside Dossie. Upload any PDF, Dossie routes it to buyer 1, then buyer 2, then you — in order, automatically. No more DocuSign tab-switching.
- After the last signature lands, Dossie emails the fully executed contract to the seller's agent automatically. One workflow, zero manual forwarding.
- You can fill out a TREC contract just by talking to Dossie — tell her "write a contract to purchase 123 Main St for $425,000" and she fills in the form fields from the conversation. The filled PDF lands in your dossier instantly.

**Form Library**
- Every standard TREC form is now inside Dossie — browse all 12 forms by category, search by name or form number, and attach any form to a deal in one click. No more downloading from the TREC website.

**Form Packages**
- New deals start faster. Apply the full Buyer Transaction or Seller Transaction package in one click and all the right forms land in the dossier together. You can also build your own custom package and save it.

**Desktop layout**
- The document buttons in each deal (Upload, E-sign, Form Library, Packages) now sit in a clean horizontal row on desktop instead of stacking vertically. Easier to scan, faster to use.

---

## Week of May 29, 2026 (final lifecycle build — Blocks 13 and 14)

**Talk to Dossie understands every stage of the deal now**
- Ask Dossie to "send the wire fraud warning to Sarah Martinez" and she triggers the TAR 2517 form + routes it to the buyer for signature — no hunting for the form yourself.
- Tell Dossie "we got an offer for $415,000 with $5,000 earnest money and a 7-day option, closing July 15" and she logs it in the offer comparison table for that listing. No manual entry.
- Say "buyer wants to terminate" and Dossie surfaces TREC 38-7 (Buyer Termination of Contract) immediately — prefilled with the deal details and ready to send.
- When the buyer's pre-approval letter comes in, tell Dossie "pre-approval received" — she marks it confirmed and prompts you to upload the document to the dossier.

**Smarter reminder emails**
- If an inspection is scheduled for tomorrow, Dossie now emails you the night before to confirm the inspector and access — includes the inspector name and phone number in the message.
- Loan approval reminders now fire at both T-3 (three days out) and T-1 (the day before the deadline), not just T-3. You'll always get a second warning if nothing has been confirmed.
- If no wire fraud warning has been sent for an active deal, Dossie now sends a one-time alert so nothing falls through the cracks on this legally sensitive document.

**Full buyer-side transaction lifecycle — complete**
- The full buyer-side residential resale workflow is now covered from pre-contract through post-closing: pre-approval, buyer rep agreement, IABS delivery, contract fill and sign, wire fraud warning, option period tracking, earnest money confirmation, inspection scheduling, repair amendments, appraisal tracking, title commitment, loan approval, HOA documents, pre-closing checklist, closing, and post-closing deed and CDA tracking. Every phase. Every document. Every deadline.

