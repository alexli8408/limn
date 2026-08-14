-- Row-level security, including authorization for Realtime channels.

-- Topics are named `board:<uuid>` and storage paths `<uuid>/<file>`. Both need
-- a cast that returns null instead of raising on anything malformed — these run
-- inside policies, where an exception is a 500 rather than a denial.
create or replace function public.safe_uuid(p_text text)
returns uuid
language plpgsql
immutable
as $$
begin
  if p_text is null or p_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  return p_text::uuid;
end;
$$;

create or replace function public.topic_board_id(p_topic text)
returns uuid
language sql
immutable
as $$
  select case
    when p_topic like 'board:%' then public.safe_uuid(split_part(p_topic, ':', 2))
    else null
  end;
$$;

create or replace function public.path_board_id(p_name text)
returns uuid
language sql
immutable
as $$
  select public.safe_uuid(split_part(p_name, '/', 1));
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

-- Readable by yourself, and by anyone you actually share a board with — enough
-- for collaborator lists and avatars, without exposing the whole user table.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.board_collaborators mine
      join public.board_collaborators theirs on theirs.board_id = mine.board_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
    or exists (
      select 1
      from public.board_collaborators c
      join public.boards b on b.id = c.board_id
      where c.user_id = auth.uid() and b.owner_id = profiles.id
    )
  );

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------------------

alter table public.boards enable row level security;

create policy boards_select on public.boards
  for select to authenticated
  using (public.can_read_board(id));

create policy boards_insert_own on public.boards
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy boards_update on public.boards
  for update to authenticated
  using (public.can_edit_board(id))
  with check (public.can_edit_board(id));

create policy boards_delete_owner on public.boards
  for delete to authenticated
  using (owner_id = auth.uid());

-- Editors may rename a board; only the owner may change who can reach it.
-- Expressed as a trigger rather than a policy because RLS `with check` cannot
-- compare a column against its own previous value.
create or replace function public.guard_board_ownership_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and new.owner_id <> auth.uid() then
    if new.visibility  is distinct from old.visibility
       or new.share_token is distinct from old.share_token
       or new.link_role   is distinct from old.link_role
       or new.owner_id    is distinct from old.owner_id then
      raise exception 'only the owner may change board sharing settings'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger boards_guard_sharing
  before update on public.boards
  for each row execute function public.guard_board_ownership_fields();

-- ---------------------------------------------------------------------------
-- collaborators
-- ---------------------------------------------------------------------------

alter table public.board_collaborators enable row level security;

create policy board_collaborators_select on public.board_collaborators
  for select to authenticated
  using (public.can_read_board(board_id));

create policy board_collaborators_write_owner on public.board_collaborators
  for all to authenticated
  using (public.board_role_for(board_id) = 'owner')
  with check (public.board_role_for(board_id) = 'owner');

-- Leaving a board you were invited to does not require the owner.
create policy board_collaborators_leave on public.board_collaborators
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- snapshots and revisions
-- ---------------------------------------------------------------------------

alter table public.board_snapshots enable row level security;
alter table public.board_revisions enable row level security;

create policy board_snapshots_select on public.board_snapshots
  for select to authenticated
  using (public.can_read_board(board_id));

create policy board_revisions_select on public.board_revisions
  for select to authenticated
  using (public.can_read_board(board_id));

-- Note the absence of insert/update policies. Writes go exclusively through
-- save_board_snapshot(), which is SECURITY DEFINER; that is what makes the
-- compare-and-swap on `version` impossible for a client to route around.

-- ---------------------------------------------------------------------------
-- usage records
-- ---------------------------------------------------------------------------

alter table public.ai_generations enable row level security;
alter table public.vision_jobs enable row level security;
alter table public.stats_cache enable row level security;

create policy ai_generations_select_own on public.ai_generations
  for select to authenticated
  using (user_id = auth.uid());

create policy ai_generations_insert_own on public.ai_generations
  for insert to authenticated
  with check (user_id = auth.uid());

create policy vision_jobs_select_own on public.vision_jobs
  for select to authenticated
  using (user_id = auth.uid());

create policy vision_jobs_insert_own on public.vision_jobs
  for insert to authenticated
  with check (user_id = auth.uid());

-- stats_cache has RLS on and no policies at all: reachable only through
-- platform_stats(), which is SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- Realtime channel authorization
-- ---------------------------------------------------------------------------

-- Realtime consults RLS on realtime.messages for private channels, which is the
-- only enforcement point available: the client picks its own topic string, so
-- without these an authenticated user could subscribe to any board's channel
-- just by knowing its id.
alter table realtime.messages enable row level security;

create policy realtime_board_receive on realtime.messages
  for select to authenticated
  using (
    extension in ('broadcast', 'presence')
    and public.can_read_board(public.topic_board_id(realtime.topic()))
  );

-- Split deliberately by extension. Editors broadcast scene deltas and cursors;
-- viewers get presence only, so a read-only collaborator cannot inject element
-- updates into everyone else's live canvas. (They could never *persist* them —
-- save_board_snapshot checks can_edit_board — but transient corruption of a
-- session is still worth preventing.) The client publishes viewer cursors as
-- presence state instead.
create policy realtime_board_send on realtime.messages
  for insert to authenticated
  with check (
    (extension = 'presence' and public.can_read_board(public.topic_board_id(realtime.topic())))
    or
    (extension = 'broadcast' and public.can_edit_board(public.topic_board_id(realtime.topic())))
  );
