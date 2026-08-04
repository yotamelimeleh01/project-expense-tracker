-- ===========================================================================
-- Phase 2: receipt photos move out of the database and into Supabase Storage.
--
-- Run this AFTER supabase-phase1-budgets.sql. Additive and idempotent.
--
-- Why: receipts were base64 strings inside expenses.receipts (jsonb). Every
-- read of an expense dragged the whole image with it, and Postgres is an
-- expensive place to keep a photo. Storage is built for this and costs a
-- fraction as much.
--
-- No table changes are needed. expenses.receipts stays a jsonb array of
-- strings; an entry is now either a storage path ("p-ocala/e1/ab12.jpg") or,
-- until it has been migrated, a legacy "data:image/..." string. The app
-- understands both and moves the old ones over as you open each project.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A private bucket. Nothing in it is reachable without a signed URL.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- ---------------------------------------------------------------------------
-- 2. Access follows the project, not the file.
--
--    Every object is stored under "<project_id>/<expense_id>/<file>", so the
--    first folder in the path is the project. The same membership helpers that
--    guard the ledger guard the photos, which means a receipt is invisible to
--    anyone who cannot already see the expense it belongs to.
-- ---------------------------------------------------------------------------
drop policy if exists "members read receipts" on storage.objects;
create policy "members read receipts" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_project_member((storage.foldername(name))[1])
  );

drop policy if exists "editors upload receipts" on storage.objects;
create policy "editors upload receipts" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and public.can_edit_project((storage.foldername(name))[1])
  );

drop policy if exists "editors replace receipts" on storage.objects;
create policy "editors replace receipts" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'receipts'
    and public.can_edit_project((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'receipts'
    and public.can_edit_project((storage.foldername(name))[1])
  );

drop policy if exists "editors delete receipts" on storage.objects;
create policy "editors delete receipts" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receipts'
    and public.can_edit_project((storage.foldername(name))[1])
  );
