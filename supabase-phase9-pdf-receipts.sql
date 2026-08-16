-- ---------------------------------------------------------------------------
-- FlipSmart — phase 9: PDF receipts
--
-- Run this once in your Supabase project:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Plenty of receipts never exist as paper. Suppliers, utilities and anyone
-- billing by email send a PDF, and photographing a screen to get it into the
-- app was a silly thing to ask. The receipts bucket now takes PDFs as well as
-- images, and the ceiling goes to 20 MB because a scanned multi-page invoice
-- is bigger than a phone photo of a till roll.
--
-- Safe to run more than once, and safe to run on a bucket that already has
-- photos in it: nothing here touches existing objects or the access policies.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
