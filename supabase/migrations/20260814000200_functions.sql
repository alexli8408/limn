-- Authorization helpers and the RPCs that carry rules the client must not own.

-- ---------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose. These are called *from* the RLS policies on
-- boards and board_collaborators; if they ran with the caller's privileges the
-- policy would re-enter itself and Postgres would abort with infinite recursion.
create or replace function public.board_role_for(
  p_board_id uuid,
  p_user_id uuid default auth.uid()
)
returns public.board_role
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_user_id is not null and b.owner_id = p_user_id then 'owner'::public.board_role
    when c.role is not null then c.role
    when b.visibility = 'public' then 'viewer'::public.board_role
    else null
  end
  from public.boards b
  left join public.board_collaborators c
    on c.board_id = b.id and c.user_id = p_user_id
  where b.id = p_board_id;
$$;

create or replace function public.can_read_board(p_board_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.board_role_for(p_board_id) is not null;
$$;

create or replace function public.can_edit_board(p_board_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.board_role_for(p_board_id) in ('owner', 'editor');
$$;

-- ---------------------------------------------------------------------------
-- board lifecycle
-- ---------------------------------------------------------------------------

-- Every board gets its snapshot row up front, so save_board_snapshot only ever
-- has to deal with the update path and can take a row lock unconditionally.
create or replace function public.ensure_board_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.board_snapshots (board_id, version, elements, updated_by)
  values (new.id, 0, '[]'::jsonb, new.owner_id)
  on conflict (board_id) do nothing;
  return new;
end;
$$;

create trigger boards_ensure_snapshot
  after insert on public.boards
  for each row execute function public.ensure_board_snapshot();

create or replace function public.create_board(p_title text default 'Untitled board')
returns public.boards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board public.boards;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  insert into public.boards (owner_id, title)
  values (auth.uid(), coalesce(nullif(btrim(p_title), ''), 'Untitled board'))
  returning * into v_board;

  return v_board;
end;
$$;

-- Redeeming a share link is what actually grants access. `visibility = 'link'`
-- on its own grants nothing: RLS cannot see a token held by the browser, so the
-- token is exchanged here for a real collaborator row that RLS *can* see.
create or replace function public.claim_board_access(p_share_token text)
returns public.boards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board public.boards;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_board
  from public.boards
  where share_token = p_share_token
    and visibility in ('link', 'public');

  if not found then
    raise exception 'invalid or expired share link' using errcode = '42501';
  end if;

  if v_board.owner_id <> auth.uid() then
    insert into public.board_collaborators (board_id, user_id, role)
    values (v_board.id, auth.uid(), v_board.link_role)
    on conflict (board_id, user_id) do nothing;
  end if;

  return v_board;
end;
$$;

create or replace function public.rotate_share_token(p_board_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if public.board_role_for(p_board_id) <> 'owner' then
    raise exception 'only the owner may rotate the share link' using errcode = '42501';
  end if;

  update public.boards
  set share_token = encode(gen_random_bytes(16), 'hex')
  where id = p_board_id
  returning share_token into v_token;

  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- snapshot persistence
-- ---------------------------------------------------------------------------

-- Compare-and-swap on the scene.
--
-- Presence propagation is not instantaneous, so during a reshuffle two peers can
-- briefly both believe they are the elected writer. Taking the caller's base
-- version as a precondition makes the loser's write fail cleanly instead of
-- silently reverting whatever the winner just saved; the client then merges and
-- retries, which is a no-op in the overwhelmingly common uncontended case.
create or replace function public.save_board_snapshot(
  p_board_id uuid,
  p_elements jsonb,
  p_base_version integer,
  p_files jsonb default '[]'::jsonb
)
returns table (version integer, saved boolean, element_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current integer;
  v_live integer;
begin
  if not public.can_edit_board(p_board_id) then
    raise exception 'not authorized to write board %', p_board_id using errcode = '42501';
  end if;
  if jsonb_typeof(p_elements) <> 'array' then
    raise exception 'elements must be a json array' using errcode = '22023';
  end if;

  select s.version into v_current
  from public.board_snapshots s
  where s.board_id = p_board_id
  for update;

  if v_current is null then
    raise exception 'board % has no snapshot row', p_board_id using errcode = 'P0002';
  end if;

  if p_base_version <> v_current then
    return query select v_current, false, null::integer;
    return;
  end if;

  -- Tombstones are persisted (they are how deletes converge) but they should
  -- not inflate the board's advertised size.
  select count(*)::integer into v_live
  from jsonb_array_elements(p_elements) e
  where coalesce((e ->> 'isDeleted')::boolean, false) = false;

  update public.board_snapshots s
  set version    = v_current + 1,
      elements   = p_elements,
      files      = p_files,
      updated_by = auth.uid(),
      updated_at = now()
  where s.board_id = p_board_id;

  update public.boards b
  set element_count = v_live,
      updated_at    = now()
  where b.id = p_board_id;

  -- Keep every tenth version. At a four-second autosave cadence, retaining all
  -- of them would write ~900 revisions an hour per active board.
  if (v_current + 1) % 10 = 0 then
    insert into public.board_revisions (board_id, version, elements, created_by)
    values (p_board_id, v_current + 1, p_elements, auth.uid());
  end if;

  return query select v_current + 1, true, v_live;
end;
$$;

create or replace function public.touch_board_opened(p_board_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.boards
  set last_opened_at = now()
  where id = p_board_id and public.can_read_board(p_board_id);
$$;

-- ---------------------------------------------------------------------------
-- public stats
-- ---------------------------------------------------------------------------

create table if not exists public.stats_cache (
  key         text primary key,
  value       jsonb not null,
  computed_at timestamptz not null default now()
);

-- Powers the live counters on the landing page. Cached because it is on an
-- anonymous, uncached-by-CDN path and would otherwise run several aggregates
-- per page view.
create or replace function public.platform_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cached jsonb;
  v_at     timestamptz;
  v_stats  jsonb;
begin
  select value, computed_at into v_cached, v_at
  from public.stats_cache where key = 'platform';

  if v_cached is not null and now() - v_at < interval '60 seconds' then
    return v_cached;
  end if;

  select jsonb_build_object(
    'boards',            (select count(*) from public.boards),
    'boards_active_24h', (select count(*) from public.boards where updated_at > now() - interval '24 hours'),
    'users',             (select count(*) from public.profiles),
    'elements',          (select coalesce(sum(element_count), 0) from public.boards),
    'revisions',         (select count(*) from public.board_revisions),
    'ai_generations',    (select count(*) from public.ai_generations where ok),
    'ai_latency_p50_ms', (select coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int
                          from public.ai_generations where ok),
    'ai_latency_p95_ms', (select coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int
                          from public.ai_generations where ok),
    'vision_jobs',       (select count(*) from public.vision_jobs),
    'vision_shapes',     (select coalesce(sum(shapes_out), 0) from public.vision_jobs),
    'vision_latency_p50_ms', (select coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int
                              from public.vision_jobs),
    'computed_at',       now()
  ) into v_stats;

  insert into public.stats_cache (key, value, computed_at)
  values ('platform', v_stats, now())
  on conflict (key) do update set value = excluded.value, computed_at = excluded.computed_at;

  return v_stats;
end;
$$;

-- ---------------------------------------------------------------------------
-- execution grants
-- ---------------------------------------------------------------------------

revoke execute on function public.create_board(text) from public;
revoke execute on function public.claim_board_access(text) from public;
revoke execute on function public.rotate_share_token(uuid) from public;
revoke execute on function public.save_board_snapshot(uuid, jsonb, integer, jsonb) from public;
revoke execute on function public.touch_board_opened(uuid) from public;
revoke execute on function public.platform_stats() from public;

grant execute on function public.create_board(text) to authenticated;
grant execute on function public.claim_board_access(text) to authenticated;
grant execute on function public.rotate_share_token(uuid) to authenticated;
grant execute on function public.save_board_snapshot(uuid, jsonb, integer, jsonb) to authenticated;
grant execute on function public.touch_board_opened(uuid) to authenticated;
grant execute on function public.board_role_for(uuid, uuid) to authenticated;
grant execute on function public.can_read_board(uuid) to authenticated;
grant execute on function public.can_edit_board(uuid) to authenticated;
grant execute on function public.platform_stats() to anon, authenticated;
