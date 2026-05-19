# Mobile Testing Checklist

**Staging URL:** https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app

**Build:** workspace-g8BhLfam.js  
**Date:** 2026-05-19

---

## Pre-Test Setup

1. Open Chrome DevTools (F12)
2. Click "Toggle Device Toolbar" (Ctrl+Shift+M)
3. Test on multiple viewports:
   - iPhone SE (375×667)
   - iPhone 14 Pro (393×852)
   - Pixel 7 (412×915)
   - iPad Air (820×1180)

---

## 1. App Shell & Navigation

### Mobile (< 768px)
- [ ] Sidebar hidden
- [ ] Bottom tab bar visible and fixed at bottom
- [ ] Bottom tab bar has 5-6 icons (Brief, Pipeline, Documents, etc.)
- [ ] Tapping tab icons changes active view
- [ ] Share Dossie button visible in bottom tab bar
- [ ] Top header shows user initial (not "D")
- [ ] "Dossie" wordmark hidden on mobile
- [ ] Talk to Dossie button sized appropriately (40px height)

### Tablet (769px - 1024px)
- [ ] Sidebar visible (200px width)
- [ ] Bottom tab bar hidden
- [ ] Two-column grid for pipeline cards
- [ ] Analytics cards in 2-column grid

### Desktop (> 1024px)
- [ ] Sidebar visible (full width)
- [ ] Bottom tab bar hidden
- [ ] Full multi-column layouts

---

## 2. Brief View

### Mobile
- [ ] Brief stats stack vertically (not side-by-side)
- [ ] Audio player controls are touch-friendly
- [ ] Deadline badges readable and properly sized
- [ ] Morning Brief text scrolls smoothly

---

## 3. Pipeline View

### Mobile
- [ ] Deal cards display in single column
- [ ] All card content readable (no overflow)
- [ ] Tap targets are at least 44px high
- [ ] "Open New Dossier" button full-width
- [ ] Deal stage badges visible and clear

### Tablet
- [ ] Deal cards in 2-column grid

---

## 4. Analytics Dashboard (Admin)

### Mobile
- [ ] Header title + refresh button stack vertically
- [ ] Refresh button full-width
- [ ] All metric cards single column
- [ ] Card values readable (36px font on mobile)
- [ ] Tables scroll horizontally
- [ ] Horizontal scroll smooth (no janky performance)
- [ ] Table headers remain visible while scrolling

### Test Tables
- [ ] "Deals by Stage" table scrolls horizontally
- [ ] "Platform Breakdown" table scrolls horizontally
- [ ] "Monthly Cost Breakdown" table scrolls horizontally
- [ ] "Customer Activity" table scrolls horizontally
- [ ] "Active Subscriptions" table scrolls horizontally

---

## 5. Dossier Detail View

### Mobile
- [ ] Dossier tabs scroll horizontally
- [ ] Info grid stacks in single column
- [ ] Documents list readable
- [ ] Action items checkboxes are touch-friendly (44px)
- [ ] Edit buttons easy to tap
- [ ] Date pickers work on mobile

---

## 6. Modals

### Mobile
- [ ] Modals are full-screen (100vw × 100vh)
- [ ] Modal headers stick to top while scrolling
- [ ] Modal footers stick to bottom
- [ ] Close button easy to tap (top-right)
- [ ] Form inputs full-width
- [ ] Buttons full-width (except inline secondary)

### Test Modals
- [ ] New Dossier modal
- [ ] Document upload modal
- [ ] Email composer modal
- [ ] Settings modal
- [ ] Share Dossie modal
- [ ] Closing Card modal

---

## 7. Forms & Inputs

### Mobile
- [ ] All inputs have 16px font size (prevents iOS zoom)
- [ ] Input fields are full-width
- [ ] Touch targets at least 44px
- [ ] Select dropdowns work on mobile
- [ ] Textarea fields expand properly
- [ ] Date pickers use native mobile pickers

---

## 8. Talk to Dossie

### Mobile
- [ ] Talk panel slides in from right (full-width)
- [ ] Close button easy to tap
- [ ] Voice input button works (if permissions granted)
- [ ] Text input works
- [ ] Panel has bottom padding (80px) for tab bar clearance

---

## 9. Document Upload

### Mobile
- [ ] Upload dropzone has reasonable height (150px)
- [ ] Camera button triggers mobile camera
- [ ] File picker triggers mobile file system
- [ ] Upload progress visible
- [ ] Uploaded files list readable

---

## 10. Settings View

### Mobile
- [ ] Form rows stack vertically
- [ ] All settings fields full-width
- [ ] Profile photo upload works
- [ ] Save button full-width and easy to tap

---

## 11. Touch Interactions

### All Touch Devices
- [ ] Buttons provide visual feedback on tap (active state)
- [ ] No hover-only interactions (all features work on touch)
- [ ] Swipe gestures smooth (where applicable)
- [ ] Pinch-to-zoom disabled on inputs (maximum-scale=1.0)

---

## 12. Safe Area Insets (iPhone/Android)

### iPhone with Notch
- [ ] Top header respects safe area
- [ ] Bottom tab bar respects safe area (no overlap with home indicator)
- [ ] Content padding respects left/right safe areas

### Android with Gesture Bar
- [ ] Bottom tab bar has proper padding above gesture bar

---

## 13. Landscape Mode (Mobile)

### Mobile Landscape
- [ ] Header height reduced to 48px
- [ ] Bottom tab bar height reduced to 52px
- [ ] Content area properly sized
- [ ] No vertical overflow

---

## 14. Performance

### Mobile Network
- [ ] App loads quickly on 3G/4G
- [ ] Images load progressively
- [ ] No janky scrolling
- [ ] Animations smooth (60fps)

---

## 15. Accessibility

### Reduced Motion
- [ ] Animations disabled if user has prefers-reduced-motion
- [ ] App still functional without animations

### High Contrast
- [ ] Borders are 2px when high contrast enabled
- [ ] Text remains readable

---

## 16. Critical User Flows

### End-to-End Mobile Test
1. [ ] Sign in on mobile
2. [ ] View morning brief
3. [ ] Open a deal from pipeline
4. [ ] Edit deal details
5. [ ] Upload a document (camera or file)
6. [ ] Check off an action item
7. [ ] Draft an email
8. [ ] View analytics (if admin)
9. [ ] Share Dossie link
10. [ ] Sign out

---

## Known Issues (To Track)

- [ ] None yet (report any found during testing)

---

## Test on Real Devices (If Available)

### iOS
- [ ] iPhone SE
- [ ] iPhone 14 Pro
- [ ] iPad Air

### Android
- [ ] Pixel 7
- [ ] Samsung Galaxy S23
- [ ] OnePlus tablet

---

## Notes

- All responsive styles live in `/mobile.css`
- Breakpoints:
  - Mobile: < 640px
  - Tablet: 640px - 768px
  - Large Tablet: 769px - 1024px
  - Desktop: > 1024px
- Touch targets follow WCAG 2.1 guidelines (min 44×44px)
- Safe area insets use CSS `env(safe-area-inset-*)` for iPhone notch and Android gesture bars

---

## Deployment Status

- [x] Committed to staging branch
- [ ] Tested on mobile devices
- [ ] Issues fixed (if any)
- [ ] Merged to main (production)

**Next Step:** Test on staging URL, report any issues, then merge to main for production deployment.
