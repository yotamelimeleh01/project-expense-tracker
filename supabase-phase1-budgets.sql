-- ===========================================================================
-- Phase 1: Scope of Work categories, cost types, and budget vs actuals.
--
-- Run this AFTER supabase-multiproject.sql. Additive and idempotent.
--
-- What it does:
--   * renames expenses.section -> expenses.category (it was always a category)
--   * remaps the old four sections onto the new phase list, without losing the
--     materials-vs-labour distinction (that moves to the new cost_type column)
--   * adds budget_lines so every category can carry a planned number
--   * adds a per-project variance threshold
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Expenses gain a cost type, and "section" becomes "category"
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'section'
  ) then
    alter table public.expenses rename column section to category;
  end if;
end;
$$;

alter table public.expenses add column if not exists cost_type text;

-- ---------------------------------------------------------------------------
-- 2. Remap the old four sections.
--    "Materials, Tools & Supplies" and "Contractors, Crew & Services" were a
--    what-kind-of-spend axis, not a phase. That information moves into
--    cost_type so nothing is lost, and the rows land in a catch-all phase
--    that can be re-tagged from the UI at leisure.
-- ---------------------------------------------------------------------------
update public.expenses set cost_type = 'Materials'
 where cost_type is null and category = 'Materials, Tools & Supplies';

update public.expenses set cost_type = 'Labor'
 where cost_type is null and category = 'Contractors, Crew & Services';

update public.expenses set cost_type = 'Fees'
 where cost_type is null
   and category in ('Closing & Deal Costs', 'Utilities, Insurance, Loan & Taxes');

update public.expenses set category = 'General Construction'
 where category in ('Materials, Tools & Supplies', 'Contractors, Crew & Services');

update public.expenses set category = 'Utilities, Insurance, Taxes & Loan'
 where category = 'Utilities, Insurance, Loan & Taxes';

update public.expenses set cost_type = 'Other' where cost_type is null;

-- ---------------------------------------------------------------------------
-- 3. Budget lines: one planned number per category, per project
-- ---------------------------------------------------------------------------
create table if not exists public.budget_lines (
  id         text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  category   text not null,
  amount     numeric(12,2) not null default 0,
  notes      text,
  created_at timestamptz default now(),
  unique (project_id, category)
);

create index if not exists budget_lines_project_idx on public.budget_lines(project_id);

-- How far a category may drift before the app calls it over budget, in percent.
alter table public.projects
  add column if not exists variance_threshold numeric(5,2) not null default 10;

-- ---------------------------------------------------------------------------
-- 4. Security: same membership rules as the rest of the ledger
-- ---------------------------------------------------------------------------
alter table public.budget_lines enable row level security;

drop policy if exists "members read budget" on public.budget_lines;
create policy "members read budget" on public.budget_lines
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "editors write budget" on public.budget_lines;
create policy "editors write budget" on public.budget_lines
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

grant select, insert, update, delete on public.budget_lines to authenticated;
