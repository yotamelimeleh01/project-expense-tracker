-- ===========================================================================
-- Phase 3: contractors, compliance dates, and 1099 tracking.
--
-- Run this AFTER supabase-phase2-storage.sql. Additive and idempotent.
--
-- A contractor is not owned by a project. The same electrician works on three
-- of your deals, and at year end the IRS wants one total per person across all
-- of them. So the directory belongs to the account that created it, and a
-- project member can see a contractor only because an expense on their project
-- points at one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The directory
--
--    Deliberately no full SSN or EIN column. A W-9 flag and the last four
--    digits are enough to chase paperwork and to recognise a payee on a form;
--    storing the whole number turns a renovation tracker into something with
--    breach-notification duties. Keep the W-9 itself in your filing cabinet.
-- ---------------------------------------------------------------------------
create table if not exists public.contractors (
  id              text primary key,
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name            text not null,
  company         text,
  trade           text,
  phone           text,
  email           text,
  w9_on_file      boolean not null default false,
  tax_id_last4    text,
  coi_expires     date,
  license_number  text,
  license_expires date,
  notes           text,
  created_at      timestamptz default now()
);

create index if not exists contractors_owner_idx on public.contractors(owner_id);

-- ---------------------------------------------------------------------------
-- 2. Expenses can name who was paid
-- ---------------------------------------------------------------------------
alter table public.expenses
  add column if not exists contractor_id text
  references public.contractors(id) on delete set null;

create index if not exists expenses_contractor_idx on public.expenses(contractor_id);

-- ---------------------------------------------------------------------------
-- 3. Who may look
--
--    SECURITY DEFINER so the policy can read expenses without tripping over
--    the policies on expenses, which is the same recursion trap the project
--    membership helpers were written to avoid.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_contractor(cid text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.contractors c
    where c.id = cid and c.owner_id = auth.uid()
  ) or exists (
    select 1 from public.expenses e
    where e.contractor_id = cid and public.is_project_member(e.project_id)
  );
$$;

alter table public.contractors enable row level security;

-- The person who added a contractor owns that record outright.
drop policy if exists "owner manages contractors" on public.contractors;
create policy "owner manages contractors" on public.contractors
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Everyone else sees only the ones that appear on a project they belong to,
-- and only to read. Your partner can see who did the roof; they cannot edit
-- your directory or discover the rest of it.
drop policy if exists "members read linked contractors" on public.contractors;
create policy "members read linked contractors" on public.contractors
  for select to authenticated
  using (public.can_see_contractor(id));

grant select, insert, update, delete on public.contractors to authenticated;
grant execute on function public.can_see_contractor(text) to authenticated;
