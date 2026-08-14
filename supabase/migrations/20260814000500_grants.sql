-- Explicit table privileges.
--
-- A hosted Supabase project ships `alter default privileges ... grant all on
-- tables to anon, authenticated`, so migrations usually appear to work without
-- this file. Depending on that is a trap: the schema then cannot be applied to
-- a plain Postgres instance (local validation, a self-hosted deploy, CI), and
-- the grants are wider than anything here actually needs.
--
-- Privileges are the coarse gate and RLS is the fine one. Both have to pass, so
-- granting only what a role could ever legitimately do means a missing policy
-- fails closed rather than open.

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.boards               to authenticated;
grant select, update                 on public.profiles             to authenticated;
grant select, insert, delete         on public.board_collaborators  to authenticated;
grant select, insert                 on public.ai_generations       to authenticated;
grant select, insert                 on public.vision_jobs          to authenticated;

-- Read-only by grant, not merely by policy. Scene writes must go through
-- save_board_snapshot() so the version compare-and-swap cannot be bypassed.
grant select on public.board_snapshots to authenticated;
grant select on public.board_revisions to authenticated;

-- stats_cache is deliberately absent: reachable only via platform_stats(),
-- which is SECURITY DEFINER.

-- Realtime consults RLS on this table for private channels; a role that cannot
-- select from it cannot receive on any topic.
grant select, insert on realtime.messages to authenticated;
