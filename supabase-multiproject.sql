-- ===========================================================================
-- Multi-project upgrade.
--
-- Run this ONCE in the Supabase SQL editor on an existing single-project
-- database. It is additive and idempotent: it creates the new tables, adds
-- the new columns, and moves every expense and draw you already have into a
-- project called "450 Spring Dr, Ocala". Nothing is deleted.
--
-- Safe to run twice.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Profiles: a readable mirror of auth.users so projects can be shared by
--    email. The client can never query auth.users directly.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text unique not null
);

create or replace function public.sync_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_upserted on auth.users;
create trigger on_auth_user_upserted
  after insert or update of email on auth.users
  for each row execute function public.sync_profile();

-- Backfill anyone who signed up before this migration.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do update set email = excluded.email;

-- ---------------------------------------------------------------------------
-- 2. Projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id              text primary key,
  name            text not null,
  address         text,
  status          text not null default 'before_closing',
  borrower        text,
  lender          text,
  settlement_date date,
  loan_amount     numeric(12,2) not null default 0,
  loan_holdback   numeric(12,2) not null default 0,
  purchase_price  numeric(12,2),
  sale_price      numeric(12,2),
  sale_date       date,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz default now()
);

-- Who may open this project.
create table if not exists public.project_members (
  project_id text not null references public.projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'editor',   -- owner | editor | viewer
  created_at timestamptz default now(),
  primary key (project_id, user_id)
);

-- The people whose money is in this deal. Not the same thing as app access:
-- a partner may have no login, and a bookkeeper may have access but no money in.
create table if not exists public.project_partners (
  id         text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  name       text not null,
  sort       int  not null default 0
);

create index if not exists project_partners_project_idx on public.project_partners(project_id);
create index if not exists project_members_user_idx     on public.project_members(user_id);

-- ---------------------------------------------------------------------------
-- 3. Attach the existing ledger tables to a project
-- ---------------------------------------------------------------------------
alter table public.expenses add column if not exists project_id text
  references public.projects(id) on delete cascade;
alter table public.expenses add column if not exists partner_id text
  references public.project_partners(id) on delete set null;
alter table public.draws add column if not exists project_id text
  references public.projects(id) on delete cascade;

-- paid_by was an 'A' | 'Z' code. Partners are rows now, so relax the old rule
-- but keep the column so historical data stays readable.
alter table public.expenses alter column paid_by drop not null;
alter table public.expenses drop constraint if exists expenses_paid_by_check;

create index if not exists expenses_project_idx on public.expenses(project_id);
create index if not exists draws_project_idx    on public.draws(project_id);

-- ---------------------------------------------------------------------------
-- 4. Membership helpers.
--    SECURITY DEFINER so a policy on project_members can ask "is this person a
--    member?" without re-entering its own policy and recursing forever.
-- ---------------------------------------------------------------------------
create or replace function public.is_project_member(pid text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = pid and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_project_owner(pid text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = pid and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

create or replace function public.can_edit_project(pid text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = pid and m.user_id = auth.uid()
      and m.role in ('owner', 'editor')
  );
$$;

-- Whoever creates a project becomes its owner immediately.
create or replace function public.grant_project_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := coalesce(auth.uid(), new.created_by);
begin
  if uid is not null then
    insert into public.project_members (project_id, user_id, role)
    values (new.id, uid, 'owner')
    on conflict (project_id, user_id) do update set role = 'owner';
  end if;
  return new;
end;
$$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created
  after insert on public.projects
  for each row execute function public.grant_project_owner();

-- ---------------------------------------------------------------------------
-- 5. Sharing RPCs. The client cannot read auth.users, so adding someone by
--    email goes through these guarded functions.
-- ---------------------------------------------------------------------------
create or replace function public.project_members_list(pid text)
returns table (user_id uuid, email text, role text)
language sql
security definer
stable
set search_path = public
as $$
  select m.user_id, p.email, m.role
  from public.project_members m
  join public.profiles p on p.id = m.user_id
  where m.project_id = pid
    and public.is_project_member(pid)
  order by (m.role = 'owner') desc, p.email;
$$;

create or replace function public.project_member_add(
  pid text, member_email text, member_role text default 'editor'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
begin
  if not public.is_project_owner(pid) then
    raise exception 'Only the project owner can share this project.';
  end if;
  if member_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Unknown role: %', member_role;
  end if;

  select id into uid from public.profiles
  where lower(email) = lower(trim(member_email));

  if uid is null then
    raise exception 'No account for %. They need to sign up first, then you can add them.', member_email;
  end if;

  insert into public.project_members (project_id, user_id, role)
  values (pid, uid, member_role)
  on conflict (project_id, user_id) do update set role = excluded.role;
end;
$$;

create or replace function public.project_member_remove(pid text, member_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_project_owner(pid) then
    raise exception 'Only the project owner can change access.';
  end if;
  if (select count(*) from public.project_members
      where project_id = pid and role = 'owner') <= 1
     and exists (select 1 from public.project_members
                 where project_id = pid and user_id = member_user_id and role = 'owner') then
    raise exception 'A project must keep at least one owner.';
  end if;
  delete from public.project_members
  where project_id = pid and user_id = member_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.project_members  enable row level security;
alter table public.project_partners enable row level security;
alter table public.expenses         enable row level security;
alter table public.draws            enable row level security;

-- Replace the old blanket policies from the single-project schema.
drop policy if exists "authenticated full access" on public.expenses;
drop policy if exists "authenticated full access" on public.draws;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "members read projects" on public.projects;
create policy "members read projects" on public.projects
  for select to authenticated using (public.is_project_member(id));

drop policy if exists "any user creates projects" on public.projects;
create policy "any user creates projects" on public.projects
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "editors update projects" on public.projects;
create policy "editors update projects" on public.projects
  for update to authenticated
  using (public.can_edit_project(id)) with check (public.can_edit_project(id));

drop policy if exists "owners delete projects" on public.projects;
create policy "owners delete projects" on public.projects
  for delete to authenticated using (public.is_project_owner(id));

drop policy if exists "members read membership" on public.project_members;
create policy "members read membership" on public.project_members
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "members read partners" on public.project_partners;
create policy "members read partners" on public.project_partners
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "editors write partners" on public.project_partners;
create policy "editors write partners" on public.project_partners
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

drop policy if exists "members read expenses" on public.expenses;
create policy "members read expenses" on public.expenses
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "editors write expenses" on public.expenses;
create policy "editors write expenses" on public.expenses
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

drop policy if exists "members read draws" on public.draws;
create policy "members read draws" on public.draws
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "editors write draws" on public.draws;
create policy "editors write draws" on public.draws
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

-- ---------------------------------------------------------------------------
-- 7. Grants. RLS decides which rows; these decide which tables are reachable
--    at all. Explicit so the script does not depend on default privileges.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on
  public.projects, public.project_members, public.project_partners,
  public.expenses, public.draws
  to authenticated;
grant execute on function
  public.is_project_member(text), public.is_project_owner(text),
  public.can_edit_project(text), public.project_members_list(text),
  public.project_member_add(text, text, text),
  public.project_member_remove(text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Move the existing single-project data into a real project.
--    Runs only if there are orphaned rows, so re-running is harmless.
-- ---------------------------------------------------------------------------
do $$
declare
  pid        text := 'proj-450-spring-ocala';
  owner_uid  uuid;
  partner_a  text := 'proj-450-spring-ocala:A';
  partner_z  text := 'proj-450-spring-ocala:Z';
begin
  -- Only adopt orphaned rows. On a fresh database there are none, so no
  -- placeholder project is invented.
  if not exists (select 1 from public.expenses where project_id is null)
     and not exists (select 1 from public.draws where project_id is null) then
    raise notice 'Nothing to migrate.';
    return;
  end if;

  select id into owner_uid from auth.users order by created_at limit 1;

  insert into public.projects (
    id, name, address, status, borrower, lender, settlement_date,
    loan_amount, loan_holdback, created_by
  ) values (
    pid, '450 Spring Dr, Ocala', '450 Spring Dr, Ocala, FL 34472', 'in_progress',
    'Ryan Locksmith LLC', 'National Loan Funding LLC', '2026-07-08',
    137700, 42500, owner_uid
  ) on conflict (id) do nothing;

  -- Every existing account keeps the access it already had.
  insert into public.project_members (project_id, user_id, role)
  select pid, u.id, case when u.id = owner_uid then 'owner' else 'editor' end
  from auth.users u
  on conflict (project_id, user_id) do nothing;

  insert into public.project_partners (id, project_id, name, sort) values
    (partner_a, pid, 'Partner A', 0),
    (partner_z, pid, 'Partner Z', 1)
  on conflict (id) do nothing;

  update public.expenses
     set project_id = pid,
         partner_id = coalesce(partner_id,
                               case when paid_by = 'A' then partner_a else partner_z end)
   where project_id is null;

  update public.draws set project_id = pid where project_id is null;

  raise notice 'Migrated existing ledger into project %', pid;
end;
$$;

-- Now that everything belongs to a project, require it going forward.
alter table public.expenses alter column project_id set not null;
alter table public.draws    alter column project_id set not null;
