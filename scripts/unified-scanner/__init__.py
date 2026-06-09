"""Unified social-engagement scanner.

Drives Heath's REAL Chrome via PyAutoGUI (NOT a fresh Playwright browser) to
read posts/comments on platforms where Heath is already logged in, filter for
relevance, and queue candidates into the ``engagement_candidates`` Supabase
table for Sage to draft replies for.

Platforms:
- reddit    : reuses the proven cookie-session reddit-fetch-new.js pipeline
- facebook  : reads group feeds from the group_registry table
- instagram : reads hashtag feed pages
- linkedin  : reads keyword search result pages

Posting back is handled by ``post_via_chrome.py`` -- it pulls
``status='approved'`` rows, navigates to each post URL, types the drafted
comment, and submits, also via PyAutoGUI on the real Chrome session.

Module entry points:
- ``python -m unified-scanner`` -- orchestrator (calls each platform in turn)
- ``python -m unified-scanner --only=reddit`` -- single platform
- ``python -m unified-scanner --post`` -- runs the poster instead of the scanner
"""
