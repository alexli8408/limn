-- Displace Supabase's default table privileges instead of merely adding to them.
--
-- A hosted project ships default ACLs on schema public granting `arwdDxtm` —
-- insert, select, update, delete, truncate, references, trigger, maintain — to
-- anon and authenticated for every table created there. The grants in
-- 000500_grants.sql are additive, so they never displaced those: on the real
-- project `authenticated` ended up holding DELETE, INSERT, UPDATE and TRUNCATE
-- on board_snapshots despite that migration granting it SELECT alone.
--
-- How bad: not exploitable as it stands. PostgREST does not expose TRUNCATE, and
-- board_snapshots has no insert/update/delete policies, so RLS denies those
-- paths — it fails closed. But the entire point of granting narrowly is that
-- privileges are the coarse gate, so a policy that is missing or later dropped
-- fails closed rather than open. That property was not actually holding.
--
-- Note this could only ever be caught against a hosted project: plain Postgres
-- has no such defaults, so the local test suite passed while the deployed
-- database was wide open at the privilege layer. The stub in supabase/tests now
-- installs the same defaults so the assertion below is meaningful.

-- 1. Take everything back.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 2. Stop future tables inheriting it. No `for role` clause, so this targets
--    current_user's own default ACL — `postgres` when the CLI applies it, and
--    whoever runs the test harness locally. supabase_admin's separate default
--    ACL is not ours to change, but every table these migrations create is
--    created by the migrating role, so this is the entry that governs them.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- 3. Re-grant exactly what each role legitimately needs, and nothing more.
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.boards              to authenticated;
grant select, update                 on public.profiles            to authenticated;
grant select, insert, delete         on public.board_collaborators to authenticated;
grant select, insert                 on public.ai_generations      to authenticated;
grant select, insert                 on public.vision_jobs         to authenticated;

-- Read-only by privilege, not merely by policy. Scene writes must go through
-- save_board_snapshot() so the version compare-and-swap cannot be bypassed.
grant select on public.board_snapshots to authenticated;
grant select on public.board_revisions to authenticated;

-- stats_cache stays absent: reachable only through platform_stats(), which is
-- SECURITY DEFINER.

-- anon gets no table privileges at all. The landing page's only query is
-- platform_stats(), and EXECUTE on a SECURITY DEFINER function does not require
-- the caller to reach the underlying tables.

-- Realtime authorization still needs these; they live outside schema public and
-- were untouched by the revoke above, but stating them keeps the intent local.
grant select, insert on realtime.messages to authenticated;
