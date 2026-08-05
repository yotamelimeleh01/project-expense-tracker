-- ---------------------------------------------------------------------------
-- Phase 8b: the scope of work belongs to you, not to the app.
--
-- Categories used to be a fixed list compiled into the page. Every job is
-- different, so they now live in the database where they can be renamed, added
-- to and dropped.
--
-- A category lives in one of two places:
--
--   project_id set    the categories that project is actually run on. Everyone
--                     with access to the project sees the same list, which is
--                     the whole point of sharing a job with someone.
--
--   project_id null   your own library. Nobody else can see it. It is the list
--                     a new project is started from, so you set your phases up
--                     once rather than on every flip.
--
-- Existing projects are backfilled with the list that was hard-coded before, so
-- nothing that is already filed moves or loses its home.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists public.categories (
  id text primary key,
  project_id text references public.projects(id) on delete cascade,
  owner uuid references auth.users(id) on delete cascade,
  name text not null,
  group_key text not null default 'build',
  default_cost_type text not null default 'Other',
  sort integer not null default 0,
  created_at timestamptz default now(),
  constraint categories_home_check check (
    (project_id is not null and owner is null) or
    (project_id is null and owner is not null)
  ),
  constraint categories_group_check
    check (group_key in ('acquire', 'build', 'hold', 'sell'))
);

-- A name is what an expense is filed under, so it has to be unique within the
-- list it belongs to. Two projects may of course both have a "Flooring".
create unique index if not exists categories_project_name
  on public.categories (project_id, name) where project_id is not null;
create unique index if not exists categories_owner_name
  on public.categories (owner, name) where project_id is null;

create index if not exists categories_project_idx on public.categories (project_id);

alter table public.categories enable row level security;

-- Your library is yours alone.
drop policy if exists "own category library" on public.categories;
create policy "own category library" on public.categories
  for all to authenticated
  using (project_id is null and owner = auth.uid())
  with check (project_id is null and owner = auth.uid());

-- A project's list is visible to everyone on the project and editable by
-- anyone who can edit the project.
drop policy if exists "members read project categories" on public.categories;
create policy "members read project categories" on public.categories
  for select to authenticated
  using (project_id is not null and public.is_project_member(project_id));

drop policy if exists "editors write project categories" on public.categories;
create policy "editors write project categories" on public.categories
  for all to authenticated
  using (project_id is not null and public.can_edit_project(project_id))
  with check (project_id is not null and public.can_edit_project(project_id));

-- ---------------------------------------------------------------------------
-- Give every project that already exists the list it has been running on.
-- Only projects with no categories at all are touched, so re-running this
-- will not resurrect a phase you deliberately deleted.
-- ---------------------------------------------------------------------------
insert into public.categories (id, project_id, name, group_key, default_cost_type, sort)
select gen_random_uuid()::text, p.id, d.name, d.group_key, d.cost_type, d.sort
  from public.projects p
 cross join (values
   ('Closing & Deal Costs',                     'acquire', 'Fees',      10),
   ('Permits & Inspections',                    'build',   'Fees',      20),
   ('Demolition & Debris',                      'build',   'Labor',     30),
   ('Framing & Structural',                     'build',   'Labor',     40),
   ('Roofing & Exterior',                       'build',   'Labor',     50),
   ('Windows & Doors',                          'build',   'Materials', 60),
   ('MEP — Mechanical, Electrical, Plumbing',   'build',   'Labor',     70),
   ('Insulation & Drywall',                     'build',   'Labor',     80),
   ('Kitchen & Bath',                           'build',   'Materials', 90),
   ('Interior Finishes',                        'build',   'Materials', 100),
   ('Flooring',                                 'build',   'Materials', 110),
   ('Landscaping & Curb Appeal',                'build',   'Labor',     120),
   ('General Construction',                     'build',   'Materials', 130),
   ('Contingency & Misc',                       'build',   'Other',     140),
   ('Utilities, Insurance, Taxes & Loan',       'hold',    'Fees',      150),
   ('Sale & Disposition Costs',                 'sell',    'Fees',      160)
 ) as d(name, group_key, cost_type, sort)
 where not exists (
   select 1 from public.categories c where c.project_id = p.id
 );

-- ---------------------------------------------------------------------------
-- Anything already filed under a name that is not in the list gets a home
-- rather than disappearing from the budget sheet. This catches categories that
-- arrived on an expense before this table existed.
-- ---------------------------------------------------------------------------
insert into public.categories (id, project_id, name, group_key, default_cost_type, sort)
select gen_random_uuid()::text, e.project_id, e.category, 'build', 'Other', 900
  from (select distinct project_id, category from public.expenses
         where category is not null and category <> '') e
 where not exists (
   select 1 from public.categories c
    where c.project_id = e.project_id and c.name = e.category
 );
