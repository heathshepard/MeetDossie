# DossieBot Chrome Profile Setup

Playwright scripts (fb-group-poster.js, twitter-keyword-scanner.js) use a
dedicated Chrome profile named "DossieBot" so they never conflict with your
personal Chrome session. Chrome locks the Default profile while it's open,
which causes Playwright to fail. The DossieBot profile is only used by scripts
and is never open in a live Chrome window at the same time.

---

## One-time setup (5 minutes)

1. Open Chrome normally.
2. Click the profile avatar in the top-right corner (circle/photo icon).
3. Click "Add" at the bottom of the profile dropdown.
4. Name it **DossieBot** exactly.
5. Chrome opens a new window for the DossieBot profile.
6. In that window, log into:
   - **Facebook** as Heath (meetdossie.com posts + group posting)
   - **Twitter/X** as @meetdossie
   - **Reddit** as Heath's account (if you want Reddit reply posting later)
7. Close the DossieBot Chrome window (do not leave it open when running scripts).

---

## Finding the profile directory name

Chrome assigns a folder name like "Profile 1", "Profile 2", etc. You need to
find the exact name to set in `PLAYWRIGHT_PROFILE_NAME`.

1. Open Chrome with the DossieBot profile active.
2. Go to: `chrome://version`
3. Find the line that says "Profile Path" — it will look like:
   `C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data\Profile 1`
4. The last segment (e.g., `Profile 1`) is your profile directory name.
5. Update `.env.local`:

```
PLAYWRIGHT_PROFILE_DIR=C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data
PLAYWRIGHT_PROFILE_NAME=Profile 1
```

Replace `Profile 1` with whatever Chrome assigned.

---

## Default values (if DossieBot is the only non-Default profile)

If you created DossieBot as your first additional profile, Chrome likely named
it `Profile 1`. The scripts default to:

```
PLAYWRIGHT_PROFILE_DIR=C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data
PLAYWRIGHT_PROFILE_NAME=DossieBot
```

Note: Chrome uses the profile *display name* (DossieBot) in its UI, but the
actual *folder name* on disk may be "Profile 1" or similar. The folder name is
what Playwright needs. Always verify via `chrome://version`.

---

## Running scripts

Before running any Playwright script:
1. Close ALL Chrome windows (including the DossieBot profile window).
2. Run the script normally: `node scripts/fb-group-poster.js --post-id [uuid]`

Chrome cannot be running when Playwright launches a persistent context — it
will fail with a "profile is locked" error if Chrome holds the profile open.
