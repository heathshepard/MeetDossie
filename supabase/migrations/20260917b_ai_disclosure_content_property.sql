-- AI-disclosure flag becomes a property of the content, not a proxy on the
-- owner literal (Quinn QA follow-up, 2026-09-17, on 20260916d_rust_owner_
-- wiring.sql / commit b26068e7).
--
-- BUG: api/cron-post-videos.js and api/cron-publish-approved.js both gated
-- the YouTube/TikTok synthetic-media disclosure flags on
-- `owner === 'heath-realtor'`. That was already a proxy, not a fact, and
-- 20260916d just widened both owner CHECK constraints to also allow 'rust' —
-- Heath's cloned voice (i41TA0Q36AUrp4axERi3) is approved for realtor AND
-- Rust content (heath-voice-clone-usage-scope.md). The moment Rust connects
-- a YouTube or TikTok account, a clone-voiced Rust video would publish with
-- NO AI disclosure, because the gate never checked for 'rust' at all.
--
-- FIX: add a real column so each row can say for itself whether it used
-- Heath's ElevenLabs voice clone, instead of the code inferring it from
-- which brand posted it. api/cron-post-videos.js reads
-- video_library.uses_cloned_voice; api/cron-publish-approved.js reads
-- social_posts.uses_cloned_voice. Both default FALSE (fail closed on
-- disclosure the same direction the old owner-literal check already did for
-- 'dossie' — Dossie is never Heath's clone, per shortform-brands.json's
-- forbidden_speaker_voices).
--
-- BACKFILL: every existing heath-realtor row is set to TRUE here so this
-- migration cannot silently turn OFF a disclosure that was already being
-- sent — it only ADDS the ability to turn it on for content this owner-only
-- proxy could never reach (Rust, or a future non-realtor/non-Dossie brand).

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS uses_cloned_voice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.video_library.uses_cloned_voice IS
  'TRUE when this specific video''s narration used Heath''s ElevenLabs voice clone (i41TA0Q36AUrp4axERi3) — the only voice_id that requires YouTube containsSyntheticMedia / TikTok video_made_with_ai disclosure under heath-voice-clone-usage-scope.md. Set by the content pipeline that actually knows which voice rendered the audio (scripts/queue-finished-videos.py today), never inferred from target_owner in the posting cron. Dossie (Luna) and any non-clone Rust coach voice stay FALSE.';

UPDATE public.video_library
  SET uses_cloned_voice = true
  WHERE target_owner = 'heath-realtor' AND uses_cloned_voice = false;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS uses_cloned_voice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.social_posts.uses_cloned_voice IS
  'Same contract as video_library.uses_cloned_voice — see that column comment. Rust does not route through cron-generate-posts.js/social_posts today, but the column should not be the reason it can''t later (same reasoning as social_posts_target_owner_check in 20260916d_rust_owner_wiring.sql).';

UPDATE public.social_posts
  SET uses_cloned_voice = true
  WHERE target_owner = 'heath-realtor' AND uses_cloned_voice = false;
