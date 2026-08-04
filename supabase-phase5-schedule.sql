-- ===========================================================================
-- Phase 5 — the schedule, and what a slipping schedule costs
--
-- Run this in the Supabase SQL editor after supabase-phase4-splits-shares.sql.
-- Additive and safe to re-run.
-- ===========================================================================

-- One row per phase of work. Dates are deliberately sparse: a task normally
-- has only a duration and a list of what it waits for, and the app works out
-- when it can actually start. Filling in planned_start pins it to a date.
create table if not exists public.tasks (
  id            text primary key,
  project_id    text not null references public.projects(id) on delete cascade,
  name          text not null,
  category      text,
  contractor_id text references public.contractors(id) on delete set null,
  duration_days integer not null default 1,
  planned_start date,
  actual_start  date,
  actual_end    date,
  status        text not null default 'not_started',
  depends_on    text[] not null default '{}',
  sort          integer not null default 0,
  notes         text,
  created_at    timestamptz default now()
);

create index if not exists tasks_project_idx on public.tasks(project_id);

alter table public.tasks enable row level security;

drop policy if exists "members read tasks" on public.tasks;
create policy "members read tasks" on public.tasks
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists "editors write tasks" on public.tasks;
create policy "editors write tasks" on public.tasks
  for all to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

grant select, insert, update, delete on public.tasks to authenticated;

-- ---------------------------------------------------------------------------
-- Share links learn one more switch
--
-- A lender asking "when will it be finished" is the most common question a
-- read-only link exists to answer, so the schedule gets its own switch.
-- ---------------------------------------------------------------------------
alter table public.share_links
  add column if not exists show_schedule boolean not null default false;

create or replace function public.share_link_create(
  pid        text,
  link_label text,
  ledger     boolean,
  splits     boolean,
  budget     boolean,
  schedule   boolean,
  days       integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  tok text;
begin
  if not public.is_project_owner(pid) then
    raise exception 'Only the owner of a project can create a share link';
  end if;

  tok := replace(gen_random_uuid()::text, '-', '');

  insert into public.share_links
    (token, project_id, created_by, label,
     show_ledger, show_splits, show_budget, show_schedule, expires_at)
  values
    (tok, pid, auth.uid(),
     nullif(btrim(coalesce(link_label, '')), ''),
     coalesce(ledger, false),
     coalesce(splits, false),
     coalesce(budget, true),
     coalesce(schedule, false),
     case when days is null or days <= 0 then null else now() + (days || ' days')::interval end);

  return tok;
end;
$$;

-- The six-argument version from phase 4 is replaced, not kept alongside, so
-- there is only ever one way in.
drop function if exists public.share_link_create(text, text, boolean, boolean, boolean, integer);

-- ---------------------------------------------------------------------------
-- Reading through a link, now with the schedule
--
-- Task notes and the contractor behind each phase stay private. A stakeholder
-- sees what is happening and when, not who is doing it or what was said about
-- them.
-- ---------------------------------------------------------------------------
create or replace function public.share_view(tok text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  l public.share_links;
  p public.projects;
begin
  select * into l from public.share_links where token = tok;
  if not found then
    return null;
  end if;
  if l.expires_at is not null and l.expires_at <= now() then
    return null;
  end if;

  select * into p from public.projects where id = l.project_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'label', l.label,
    'expires_at', l.expires_at,
    'scope', jsonb_build_object(
      'ledger', l.show_ledger,
      'splits', l.show_splits,
      'budget', l.show_budget,
      'schedule', l.show_schedule
    ),
    'project', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'address', p.address,
      'status', p.status,
      'lender', p.lender,
      'settlement_date', p.settlement_date,
      'loan_amount', p.loan_amount,
      'loan_holdback', p.loan_holdback,
      'purchase_price', p.purchase_price,
      'sale_price', p.sale_price,
      'sale_date', p.sale_date,
      'variance_threshold', p.variance_threshold,
      'pref_annual_pct', p.pref_annual_pct
    ),
    'partners', case when l.show_splits then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pp.id, 'project_id', pp.project_id, 'name', pp.name,
               'sort', pp.sort, 'equity_pct', pp.equity_pct
             ) order by pp.sort)
      from public.project_partners pp where pp.project_id = p.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'budget_lines', case when l.show_budget then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'project_id', b.project_id,
               'category', b.category, 'amount', b.amount
             ))
      from public.budget_lines b where b.project_id = p.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'tasks', case when l.show_schedule then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'project_id', t.project_id, 'name', t.name,
               'category', t.category, 'duration_days', t.duration_days,
               'planned_start', t.planned_start, 'actual_start', t.actual_start,
               'actual_end', t.actual_end, 'status', t.status,
               'depends_on', t.depends_on, 'sort', t.sort
             ) order by t.sort, t.id)
      from public.tasks t where t.project_id = p.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'project_id', e.project_id,
               'date', e.date,
               'category', e.category,
               'cost_type', e.cost_type,
               'amount', e.amount,
               'partner_id', case when l.show_splits then e.partner_id else null end,
               'description', case when l.show_ledger then e.description else null end,
               'notes', case when l.show_ledger then e.notes else null end
             ) order by e.date, e.id)
      from public.expenses e where e.project_id = p.id
    ), '[]'::jsonb),
    'draws', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'project_id', d.project_id,
               'date', d.date, 'amount', d.amount,
               'note', case when l.show_ledger then d.note else null end
             ) order by d.date, d.id)
      from public.draws d where d.project_id = p.id
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.share_link_create(text, text, boolean, boolean, boolean, boolean, integer) to authenticated;
grant execute on function public.share_view(text) to anon, authenticated;
