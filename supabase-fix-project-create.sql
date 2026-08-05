-- ---------------------------------------------------------------------------
-- Fix: creating a new project failed with
--   "new row violates row-level security policy for table projects"
--
-- Two things could produce that message, and this file closes both.
--
-- 1. The INSERT policy demands created_by = auth.uid(). If the policy went
--    missing, or the column arrived empty, the insert is refused. The column
--    now defaults to auth.uid(), so it is right even when nobody sets it.
--
-- 2. The app inserts with RETURNING, so Postgres also applies the SELECT
--    policy to the row on its way back. That policy asked whether you were a
--    member of the project — but membership is granted by an AFTER INSERT
--    trigger, which has not fired yet at the moment the row is returned. The
--    creator can now read their own row directly, which is true from the
--    first instant of its life rather than a moment later.
--
-- Safe to run more than once. Additive; nothing is dropped but the policies
-- it immediately recreates.
-- ---------------------------------------------------------------------------

-- The creator, recorded without being asked for.
alter table public.projects alter column created_by set default auth.uid();

-- You may create a project as long as you are its creator.
drop policy if exists "any user creates projects" on public.projects;
create policy "any user creates projects" on public.projects
  for insert to authenticated
  with check (created_by = auth.uid());

-- You may read a project you were let into, or one you have just made.
drop policy if exists "members read projects" on public.projects;
create policy "members read projects" on public.projects
  for select to authenticated
  using (created_by = auth.uid() or public.is_project_member(id));

-- ---------------------------------------------------------------------------
-- If a project still refuses to save, run this and read what comes back. It
-- changes nothing; it only shows which policies are actually in force.
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'projects';
--
-- The insert row should read: with_check = (created_by = auth.uid())
-- ---------------------------------------------------------------------------
