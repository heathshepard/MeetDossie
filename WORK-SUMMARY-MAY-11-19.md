# Work Summary: May 11-19, 2026

**309 commits on main | 306 commits on staging**

## May 19 (TODAY) - 89 commits

### MAJOR NEW FEATURES:

**1. Shepard Studio Command Center (Phase 1 MVP)**
- New venture studio dashboard at `/studio.html`
- Agent workforce tracking (Chief of Staff, Builder, Coder, IT Agent)
- Product portfolio view (Dossie + future products)
- Org metrics (revenue, costs, profit, velocity)
- Database tables: `organization_tasks`, `studio_messages`, `studio_agents`, `studio_products`
- Auth restricted to `heath.shepard@kw.com`
- Voice-ready architecture (buttons present, Phase 2 implementation pending)
- **Files:** `studio.html`, `api/studio/*.js`, `SHEPARD-STUDIO.md`, `SHEPARD-STUDIO-SETUP.md`

**2. Analytics Tab**
- 4 new sections: Expenses, Feature Usage by Member, Feature Adoption, Enhanced Customer Detail
- Admin dashboard with comprehensive metrics
- Performance optimization (replaced listUsers() with direct SQL)

**3. Full Mobile Responsive Design**
- Comprehensive mobile.css (breakpoints: mobile/tablet/desktop)
- Touch-friendly tap targets (min 44px)
- Horizontal scrolling tables
- Full-screen modals on mobile
- Bottom tab bar navigation
- Collapsible sidebar
- Safe area insets (iPhone notch/Android gesture bar)
- Landscape mode optimizations
- **Files:** `mobile.css`, `MOBILE-RESPONSIVE-SUMMARY.md`, `MOBILE-TESTING-CHECKLIST.md`

**4. IDEAS.md + BACKLOG.md**
- New organizational system for tracking ideas vs backlog items
- Separates brainstorming from prioritized work

### MAJOR BUG FIXES:

**Mobile Contract Scanning (15+ commits)**
- Fixed file input not firing onChange on mobile
- Added file polling mechanism
- Fixed React synthetic event pooling
- Added visible debug panel
- Fixed UI blocking (INP issues)
- Multiple webkit mobile optimizations
- Manual "Tap to scan" fallback button

**Admin Dashboard**
- Fixed JavaScript duplicate code block
- Added visible debug panel
- Auth status tracking
- Comprehensive error handling

**Telegram Bots**
- DossieMarketingBot: added /status, /members, /health commands
- DossieAssistant_bot: webhook endpoint, catch-all matching
- Fixed callback query handling
- Improved error logging

**Voice/TTS**
- Speed adjustments: 1.2 → 0.85 → 0.95 → 1.0
- Added request ID tracking
- Cache-busting headers
- **CURRENT:** Voice speed set to 1.0 in `api/speak.js` line 60

**Social Card Rendering**
- Fixed brand colors (was wrong before)
- Single coral accent line (not two)
- HCTI compatibility (google_fonts + ms_delay)
- Inline styles for compatibility

**Sidebar/UI**
- Fixed button outlines (outline:none)
- Fixed auth bug in studio.html (storageKey mismatch)
- Mobile profile menu (tap avatar)

---

## May 18 - 26 commits

### Voice Speed Tuning
- Deployed multiple speed changes: 1.2 → 0.85 → 0.95 → 1.0
- Final speed: 1.0 (deployed to production)

### Milestone Cards
- HCTI rendering fixes (google_fonts, inline styles)
- Demo2 under-contract milestones (all 6 deals)
- Added under-contract milestone type

### Social Pipeline
- **CRITICAL:** Timezone bug fix (was checking UTC instead of platform timezone for daily caps)
- Added luxon for timezone handling
- AUTO_APPROVE_POSTS feature flag (default: auto-approve enabled)
- HCTI card rendering (google_fonts + ms_delay)

### CORS Fixes
- api/action-items: allow Vercel preview URLs
- api/documents: allow staging domains

---

## May 17 - 12 commits

### Social Pipeline CRITICAL FIXES
- **CRITICAL:** Filter posting_schedule by day_of_week (was posting wrong days!)
- **CRITICAL:** Block mark-post-failed with null/empty error messages
- Morning Brief fixes (urgent deadlines ≤2 days, "All clear" label)
- Morning Brief script hallucination fix

### Security
- **CRITICAL:** Removed all hardcoded API keys from scripts directory
- Added security rule to CLAUDE.md (never hardcode keys)
- Removed n8n workflow files with exposed keys

### Endpoints
- reset-failed-posts
- disable-n8n-workflow
- CORS fixes (staging + Vercel preview URLs)

---

## May 16 - 14 commits

### Contract Scanning Improvements
- possessionDate: auto-set to closingDate when type=closing
- optionDays: parse from Paragraph 5B with regex
- surveyDeadline: prompt clarity
- Fix compliance (restore strict initials detection)
- Add possessionDate to dateFields Set

### Mobile Fixes
- Fix Pipeline button (add closeDealDetail())
- Fix scroll position bug (save/restore on tab change)

### Social Pipeline Debug
- Zernio API logging for FB/IG failures
- reset-failed-post endpoint

---

## May 15 - 28 commits

### Contract Scanning Deep Dive
- optionDays: lock to Paragraph 5B only
- salePrice: verification (calculate 3A+3B)
- Debug fields: show raw text from Paragraphs 3C and 5B
- closing date extraction: clarify 9.A vs title objection dates
- Date normalization: yyyy-MM-dd for HTML inputs
- Speed: parallel compliance audit + TREC extraction (~50% faster)
- **GOLD tag:** GOLD-2026-05-15-scanning-fixes

### UI/UX
- Share Dossie button: style to match nav, moved under Getting Started
- Milestone modal: simplify to just Share button (Facebook)
- Fix sidebar button outline (remove black outline on click)
- Fix Done button border (coral #C17B5C)

### Pricing Update
- **Solo:** $79/mo (was $49)
- **Team:** $199/mo (was $149)
- **Additional seats:** $35/mo (was $25)
- **Founding:** $29/mo (locked forever, 50 spots)
- Removed annual pricing

### Voice
- Reduced speed from 1.0 to 0.85
- Force redeploy of api/speak.js

### Email Fixes
- Normalize email history type checking
- Fix buyer/seller email field paths
- Fix lender/title field name mismatch
- Improve email content (specific dates, names, details)
- Fix compliance email modal auto-trigger bug

---

## May 14 - 23 commits

### Social Pipeline
- **GOLD tag:** GOLD-2026-05-14-pipeline-restored
- Fixed Instagram filtering (only TikTok requires pre-existing media)
- Fixed LinkedIn schedule
- Fixed Telegram buttons
- reset-failed-posts endpoint
- debug-posts endpoint
- n8n workflow updates

### Rules
- Added CLAUDE_RULES.md (standing rules for all sessions)

---

## CRITICAL CURRENT STATE (as of May 19 end-of-day):

### Voice Implementation:
- **ElevenLabs TTS** via `/api/speak`
- **Talk to Dossie** uses `/api/chat` (Claude API) for conversation, then calls `/api/speak` for TTS
- Voice speed: **1.0** (set in api/speak.js line 60)
- **ISSUE:** 401 errors on `/api/speak` - cause unknown (not in code)

### What's Live on Production:
- Shepard Studio (studio.html)
- Mobile responsive design
- Analytics tab
- All social pipeline fixes
- All contract scanning improvements
- Pricing update (Solo $79, Team $199)

### What's on Staging:
- Same as production (staging is 3 commits behind main due to tonight's emergency fixes)

### Key Files Changed Since May 11:
- **New:** `studio.html`, `api/studio/*.js`, `IDEAS.md`, `BACKLOG.md`, `mobile.css`, `SHEPARD-STUDIO.md`
- **Major updates:** `api/speak.js`, `api/chat.js`, `api/scan-contract.js`, `api/cron-publish-approved.js`

### Known Issues:
- Voice 401 error (being debugged tonight)
- CLAUDE.md is 8 days out of date
- Need better system for keeping CLAUDE.md current

---

## Recommendations for CLAUDE.md Update:

1. Add Shepard Studio section
2. Update pricing section (new tiers)
3. Add mobile responsive status
4. Update voice implementation details
5. Add analytics tab info
6. Update known issues section
7. Add workflow for keeping CLAUDE.md updated (propose: update after each GOLD tag)
