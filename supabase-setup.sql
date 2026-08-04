-- ---------------------------------------------------------------------------
-- Project Expense Tracker — Supabase schema
--
-- Run this once in your Supabase project:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Security model: Row Level Security is ON for both tables and only
-- authenticated users can read or write. The public anon key alone grants
-- nothing. Keep public sign-ups DISABLED in Authentication -> Sign In / Up
-- so only users you create in the dashboard can log in.
-- ---------------------------------------------------------------------------

create table if not exists public.expenses (
  id          text primary key,
  date        text,
  description text not null,
  notes       text,
  section     text not null,
  paid_by     text not null check (paid_by in ('A', 'Z')),
  amount      numeric(12, 2) not null default 0,
  receipts    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.draws (
  id         text primary key,
  date       text,
  note       text,
  amount     numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.expenses enable row level security;
alter table public.draws    enable row level security;

-- Signed-in users get full access; anonymous visitors get nothing.
drop policy if exists "authenticated full access" on public.expenses;
create policy "authenticated full access"
  on public.expenses
  for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated full access" on public.draws;
create policy "authenticated full access"
  on public.draws
  for all
  to authenticated
  using (true)
  with check (true);
