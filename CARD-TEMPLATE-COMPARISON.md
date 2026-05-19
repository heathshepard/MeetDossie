# Card Template Comparison - Before/After

## BEFORE (BAD - wrong colors, confusing layout)

### HTML Structure:
```html
<div class="card">
  <!-- Stat in wrong coral -->
  <div class="stat" style="color: #C17B5C">$400/file</div>
  <div class="stat-label">More than my car payment</div>
  
  <!-- Separate hook section with SAGE divider (not needed) -->
  <div class="hook-container">
    <div class="hook-divider" style="background: #6B8E68"></div>
    <div class="hook">Your TC just quit. Now what?</div>
  </div>
  
  <!-- Body with GOLD bar (should be CORAL) -->
  <div class="body-container">
    <div class="body-bar" style="background: #C9A96E"></div>
    <div class="body">Every follow-up. Every deadline...</div>
  </div>
  
  <div class="bottom-row">
    <div class="pill">Founding · 48 spots left</div>
    <div class="url">meetdossie.com/founding</div>
  </div>
</div>
```

### Issues:
1. **Wrong colors** - CORAL was #C17B5C (should be #E8836B)
2. **TWO accent lines** - sage hook divider + gold body bar
3. **Confusing hierarchy** - hook separated from body
4. **Wrong blush** - background was #F5EDE4 (should be #F5E6E0)

---

## AFTER (GOOD - correct colors, clean layout)

### HTML Structure:
```html
<div class="card">
  <!-- Stat in correct coral -->
  <div class="stat" style="color: #E8836B">$400/file</div>
  <div class="stat-label">More than my car payment</div>
  
  <!-- Single body section with CORAL accent line -->
  <div class="body-container">
    <div class="body-bar" style="background: #E8836B"></div>
    <div class="body">Every follow-up. Every deadline. Every lender intro. She handles it.</div>
  </div>
  
  <div class="bottom-row">
    <div class="pill">Founding · 48 spots left</div>
    <div class="url">meetdossie.com/founding</div>
  </div>
</div>
```

### Improvements:
1. **Correct colors** - CORAL is now #E8836B (matches CLAUDE.md)
2. **Single accent line** - coral body bar only
3. **Clean hierarchy** - stat → label → body → footer
4. **Correct blush** - background is #F5E6E0

---

## Visual Hierarchy (AFTER)

```
┌─────────────────────────────────────┐
│  Blush background (#F5E6E0)         │
│                                     │
│  $400/file  ← Large stat (coral)   │
│  More than my car payment           │
│                                     │
│  ┃ Every follow-up. Every          │
│  ┃ deadline. Every lender          │
│  ┃ intro. She handles it.          │
│  ↑                                  │
│  Coral accent line (4px)            │
│                                     │
│  [Founding · 48 spots] meetdossie…  │
│   ↑ Gold badge      ↑ Sage URL     │
└─────────────────────────────────────┘
```

---

## CSS Changes

### BEFORE:
```css
/* Wrong colors */
BLUSH: '#F5EDE4'
CORAL: '#C17B5C'
SAGE: '#6B8E68'

/* Unnecessary hook section */
.hook-container { ... }
.hook-divider {
  background: #6B8E68;  /* sage */
}
.hook { ... }

/* Wrong body bar color */
.body-bar {
  background: #C9A96E;  /* gold */
}
```

### AFTER:
```css
/* Correct colors */
BLUSH: '#F5E6E0'
CORAL: '#E8836B'
SAGE: '#8BA888'

/* Hook section removed entirely */

/* Correct body bar color */
.body-bar {
  background: #E8836B;  /* coral */
}
```

---

## Implementation Details

### File: `api/generate-card.js`

**Lines changed:**
- 12-20: Updated COLORS object with correct hex values
- 163-186: Removed hook section CSS (`.hook-container`, `.hook-divider`, `.hook`)
- 174: Changed `.body-bar` background from GOLD to CORAL
- 225-233: Simplified HTML to remove hook conditional block

**Net result:**
- Cleaner template
- Correct brand colors
- Single accent line (coral)
- Better visual hierarchy

---

## Testing

Run `node api/test-card-template.js` to generate a sample card and verify:

1. Stat color is coral (#E8836B), not muted brown
2. Only ONE accent line (coral, 4px)
3. No separate hook section
4. Body text flows naturally
5. Founding badge is gold
6. URL is sage
7. Background is blush

---

## Commit: f656d60

```
Fix social card template - use correct brand colors and single coral accent line

PROBLEM:
- Cards were using wrong colors (BLUSH #F5EDE4 instead of #F5E6E0, CORAL #C17B5C instead of #E8836B)
- Had TWO accent lines (sage hook divider + gold body bar) instead of ONE coral line
- Hook section was separate from body, creating layout confusion

FIX:
- Update COLORS to match CLAUDE.md brand spec exactly
- Remove hook section (sage divider)
- Change body bar from GOLD to CORAL (vertical accent line on left)
- Simplify HTML to single body section with coral accent
- Add test-card-template.js for manual verification
```
