-- ============================================================================
-- jarvis_todos.attachments — file attachments (video/screenshot/PDF/etc) on
-- Heath's real to-do items, so a completed deliverable can be shown directly
-- on the item instead of only described in text.
--
-- Reuses the exact pattern already built 2026-08-27 for jarvis-bridge chat
-- message attachments (see scripts/jarvis-bridge-attach-file.js and
-- api/jarvis-bridge-turn.js): same shape, same jarvis-attachments Storage
-- bucket, different object-path prefix (todos/<todo_id>/ instead of
-- cole-replies/<chat_id>/) so the two directions never collide.
--
-- Shape (JSONB array, each element):
--   { name, url, media_type, kind: 'image'|'pdf'|'video'|'file', size, uploaded_at }
-- Deliberately the same field names as the chat-attachment shape so
-- renderMessageAttachments() in jarvis-pwa.html can be reused as-is for
-- rendering (extended in this same change to also handle kind:'video').
--
-- Owner: Atlas, 2026-08-27 (SV-ENG-JARVIS-TODO-ATTACHMENTS)
-- ============================================================================

ALTER TABLE public.jarvis_todos
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.jarvis_todos.attachments IS
  'Array of file attachments (video/screenshot/PDF/etc) proving/showing a completed deliverable for this to-do item. Same shape as jarvis-bridge chat-message attachments: [{name, url, media_type, kind: image|pdf|video|file, size, uploaded_at}]. Written by scripts/jarvis-todo-attach-file.js (uploads to the jarvis-attachments Storage bucket under todos/<todo_id>/, then PATCHes this column). Rendered by renderJarvisTodos() via the shared renderMessageAttachments() helper in jarvis-pwa.html.';
