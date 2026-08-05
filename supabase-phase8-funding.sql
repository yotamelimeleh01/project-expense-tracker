-- ---------------------------------------------------------------------------
-- Phase 8a: not every deal has a lender.
--
-- A deal is either financed or paid for out of pocket. Until now the loan
-- fields were always on show and always part of the all-in, which meant a cash
-- purchase had to be described by leaving three fields at zero and hoping the
-- arithmetic came out right.
--
-- Existing projects are assumed to be financed, except the ones that never
-- named a lender and never carried a note — those were cash deals all along.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists funding text not null default 'financed';

alter table public.projects drop constraint if exists projects_funding_check;
alter table public.projects
  add constraint projects_funding_check check (funding in ('financed', 'cash'));

update public.projects
   set funding = 'cash'
 where funding = 'financed'
   and coalesce(loan_amount, 0) = 0
   and coalesce(lender, '') = '';
