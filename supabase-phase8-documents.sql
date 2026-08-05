-- ---------------------------------------------------------------------------
-- Phase 8c: the paperwork lives with the deal.
--
-- A flip generates a stack of documents — the contract, the ALTA, the deed,
-- the permits, the payoff letter — and they end up scattered across email,
-- a phone's downloads folder and somebody's desk. This puts them on the
-- project, where you already are when you need them.
--
-- Files go in their own private bucket under "<project_id>/<document_id>/",
-- so the same membership rules that guard the ledger guard the paperwork:
-- a partner you shared the deal with sees the documents, nobody else does.
--
-- Receipts keep their own bucket. That one only accepts images, and it is
-- worth keeping it that way.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists public.documents (
  id text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  name text not null,
  kind text not null default 'Other',
  path text not null,
  size bigint not null default 0,
  mime text,
  note text default '',
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists documents_project_idx on public.documents (project_id);

alter table public.documents enable row level security;

drop policy if exists "members read documents" on public.documents;
create policy "members read documents" on public.documents
  for select to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "editors write documents" on public.documents;
create policy "editors write documents" on public.documents
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

-- ---------------------------------------------------------------------------
-- The bucket. Private, 25 MB a file, and a deliberately narrow list of types:
-- paperwork is PDFs, scans and the occasional spreadsheet, and there is no
-- reason for this app to accept anything that can be executed.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 26214400,
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = 26214400,
      allowed_mime_types = excluded.allowed_mime_types;

-- Access follows the project, exactly as it does for receipts. The first
-- folder in the path is the project id, so the path is not cosmetic.
drop policy if exists "members read documents bucket" on storage.objects;
create policy "members read documents bucket" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_project_member((storage.foldername(name))[1])
  );

drop policy if exists "editors upload documents bucket" on storage.objects;
create policy "editors upload documents bucket" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.can_edit_project((storage.foldername(name))[1])
  );

drop policy if exists "editors replace documents bucket" on storage.objects;
create policy "editors replace documents bucket" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.can_edit_project((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'documents'
    and public.can_edit_project((storage.foldername(name))[1])
  );

drop policy if exists "editors delete documents bucket" on storage.objects;
create policy "editors delete documents bucket" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.can_edit_project((storage.foldername(name))[1])
  );
