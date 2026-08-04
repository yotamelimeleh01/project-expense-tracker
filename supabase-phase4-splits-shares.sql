-- ===========================================================================
-- Phase 4 — profit splits and read-only stakeholder links
--
-- Run this in the Supabase SQL editor after supabase-phase3-contractors.sql.
-- Additive and safe to re-run.
-- ===========================================================================

-- Each partner's slice of the profit, and the preferred return the deal pays
-- on money that has been sitting in it. Both default to zero, so nothing
-- changes for a project until you fill them in.
alter table public.project_partners
  add column if not exists equity_pct numeric not null default 0;

alter table public.projects
  add column if not exists pref_annual_pct numeric not null default 0;

-- ---------------------------------------------------------------------------
-- Share links
--
-- A link is a random token that lets someone with no account read one project.
-- Three switches decide how much they see. Every link can be given an expiry
-- and can be deleted, which kills it immediately.
-- ---------------------------------------------------------------------------
create table if not exists public.share_links (
  token       text primary key,
  project_id  text not null references public.projects(id) on delete cascade,
  created_by  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label       text,
  show_ledger boolean not null default false,
  show_splits boolean not null default false,
  show_budget boolean not null default true,
  expires_at  timestamptz,
  created_at  timestamptz default now()
);

create index if not exists share_links_project_idx on public.share_links(project_id);

alter table public.share_links enable row level security;

-- Only the owner of a project can see or manage the links handed out for it.
-- Editors cannot, because giving away a project is an ownership decision.
drop policy if exists "owner manages share links" on public.share_links;
create policy "owner manages share links" on public.share_links
  for all
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

-- ---------------------------------------------------------------------------
-- Creating a link
--
-- The token is generated here rather than in the browser so it is always a
-- full-strength random value.
-- ---------------------------------------------------------------------------
create or replace function public.share_link_create(
  pid        text,
  link_label text,
  ledger     boolean,
  splits     boolean,
  budget     boolean,
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
    (token, project_id, created_by, label, show_ledger, show_splits, show_budget, expires_at)
  values
    (tok, pid, auth.uid(),
     nullif(btrim(coalesce(link_label, '')), ''),
     coalesce(ledger, false),
     coalesce(splits, false),
     coalesce(budget, true),
     case when days is null or days <= 0 then null else now() + (days || ' days')::interval end);

  return tok;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading through a link
--
-- This is the only thing an anonymous visitor can call. It runs as the
-- definer, so the token check below is the entire security boundary — an
-- unknown or expired token gets null and nothing else.
--
-- What comes back is deliberately trimmed: no borrower name, no internal
-- notes, no receipts, no contractors, no member list. Descriptions, partner
-- names and budgets appear only if that switch was turned on for the link.
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
      'budget', l.show_budget
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

grant select, insert, update, delete on public.share_links to authenticated;
grant execute on function public.share_link_create(text, text, boolean, boolean, boolean, integer) to authenticated;
grant execute on function public.share_view(text) to anon, authenticated;
