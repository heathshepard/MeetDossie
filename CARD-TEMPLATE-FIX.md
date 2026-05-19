# Social Card Template Fix - 2026-05-19

## Problem Identified

Recent social media posts were using the wrong card template with incorrect colors and confusing layout structure.

### BAD TEMPLATE (before fix):
- Wrong brand colors:
  - BLUSH: `#F5EDE4` (should be `#F5E6E0`)
  - CORAL: `#C17B5C` (should be `#E8836B`)
  - SAGE: `#6B8E68` (should be `#8BA888`)
- TWO accent lines:
  - Sage hook divider (3px)
  - Gold body bar (4px)
- Separate hook section creating layout confusion
- Hook not integrated with body copy

### GOOD TEMPLATE (target):
- Large stat in colored text (e.g., "$400/file" in coral #E8836B)
- Stat label below in navy
- **Single vertical coral accent line on left side (4px)**
- Body copy (2-3 lines) next to accent line
- "Founding · 50 spots left" badge at bottom in gold
- meetdossie.com/founding URL in sage
- Blush background (#F5E6E0)

## Changes Made

### File: `api/generate-card.js`

1. **Fixed brand colors** to match CLAUDE.md spec exactly:
   ```js
   const COLORS = {
     BLUSH: '#F5E6E0',      // was #F5EDE4
     BLUSH_DEEP: '#D4A0A0',
     CORAL: '#E8836B',      // was #C17B5C
     SAGE: '#8BA888',       // was #6B8E68
     NAVY: '#1A1A2E',
     GOLD: '#C9A96E',
     WHITE: '#FFFFFF',
   };
   ```

2. **Removed hook section** with sage divider:
   - Deleted `.hook-container`, `.hook-divider`, `.hook` CSS classes
   - Removed conditional hook HTML block

3. **Changed body bar to CORAL**:
   ```css
   .body-bar {
     width: 4px;
     background: ${COLORS.CORAL};  // was GOLD
   }
   ```

4. **Simplified HTML structure**:
   - Single body section with coral accent line
   - No separate hook section
   - Clean stat → stat-label → body → footer flow

## Verification

### Test script created: `api/test-card-template.js`

Run with:
```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
node api/test-card-template.js
```

This will generate a test card with the sample post:
- **Stat:** "$400/file"
- **Stat label:** "More than my car payment"
- **Body:** "Every follow-up. Every deadline. Every lender intro. She handles it."
- **Persona:** brenda

### Manual verification checklist:
- [ ] Stat is large, in coral color (#E8836B)
- [ ] Stat label is smaller, navy color (#1A1A2E)
- [ ] Vertical accent line on left is CORAL (not gold/sage)
- [ ] Body text is readable, good spacing (line-height 1.65)
- [ ] Founding badge is gold with white text
- [ ] URL is sage green (#8BA888)
- [ ] Background is blush (#F5E6E0)
- [ ] Overall matches the "$400/file" good template

## Deployment

- Committed to `staging` branch: f656d60
- Merged to `main`: f656d60
- Pushed to production
- Vercel auto-deploy to https://meetdossie.com

## Next Steps

1. Monitor next batch of auto-generated social posts (runs daily 11AM UTC / 6AM CST)
2. Verify cards match the good template
3. If issues persist, check HCTI API parameters (google_fonts, ms_delay)
4. Consider updating Python Pillow renderer (`scripts/render-card.py`) if HCTI is too slow/unreliable

## Reference

Good template example: "$400/file" card with single coral accent line.

CLAUDE.md brand colors (source of truth):
```
Blush:      #F5E6E0  (card background)
Blush deep: #D4A0A0  (border)
Coral:      #E8836B  (accent line, CTA)
Sage:       #8BA888  (success, URL)
Navy:       #1A1A2E  (headlines, body)
Gold:       #C9A96E  (founding badge)
```
