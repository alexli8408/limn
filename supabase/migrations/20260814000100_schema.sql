-- Limn core schema.
--
-- Design note: there is no application server. The Next.js app is served from
-- Vercel's edge and sync runs over Supabase Realtime, which is a fan-out pipe
-- with no hook to run code in. That makes Postgres the only place a rule can be
-- enforced for everyone, so anything that must not be client-overridable —
-- access control, snapshot concurrency, usage accounting — is implemented here
-- as RLS or as a SECURITY DEFINER function, never in TypeScript.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Anonymous',
  avatar_url  text,
  -- Anonymous sign-in is the frictionless demo path; guests are real rows so
  -- they can own boards, and get upgraded in place if they later sign up.
  is_guest    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'One row per auth user, including anonymous guests.';

-- ---------------------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------------------

create type public.board_visibility as enum ('private', 'link', 'public');
create type public.board_role as enum ('owner', 'editor', 'viewer');

create table if not exists public.boards (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  title         text not null default 'Untitled board',
  visibility    public.board_visibility not null default 'link',
  -- Unguessable, and rotatable without changing the board id in existing URLs.
  share_token   text not null default encode(gen_random_bytes(16), 'hex'),
  -- Role granted to whoever arrives holding the share token.
  link_role     public.board_role not null default 'editor',
  thumbnail_url text,
  element_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  constraint boards_title_len check (char_length(title) between 1 and 200)
);

create index if not exists boards_owner_idx on public.boards (owner_id, updated_at desc);
create unique index if not exists boards_share_token_idx on public.boards (share_token);
create index if not exists boards_title_trgm_idx on public.boards using gin (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- collaborators
-- ---------------------------------------------------------------------------

create table if not exists public.board_collaborators (
  board_id   uuid not null references public.boards(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       public.board_role not null default 'editor',
  added_at   timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index if not exists board_collaborators_user_idx
  on public.board_collaborators (user_id, added_at desc);

-- ---------------------------------------------------------------------------
-- snapshots
-- ---------------------------------------------------------------------------

-- Exactly one row per board: the current scene. History lives in board_revisions.
create table if not exists public.board_snapshots (
  board_id    uuid primary key references public.boards(id) on delete cascade,
  version     integer not null default 0,
  elements    jsonb not null default '[]'::jsonb,
  files       jsonb not null default '[]'::jsonb,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  constraint board_snapshots_elements_is_array check (jsonb_typeof(elements) = 'array')
);

create table if not exists public.board_revisions (
  id         bigint generated always as identity primary key,
  board_id   uuid not null references public.boards(id) on delete cascade,
  version    integer not null,
  elements   jsonb not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists board_revisions_board_idx
  on public.board_revisions (board_id, version desc);

-- ---------------------------------------------------------------------------
-- usage accounting
-- ---------------------------------------------------------------------------

create type public.ai_mode as enum ('refine', 'recompose', 'prompt', 'vectorize');

create table if not exists public.ai_generations (
  id             uuid primary key default gen_random_uuid(),
  board_id       uuid references public.boards(id) on delete set null,
  user_id        uuid references public.profiles(id) on delete set null,
  mode           public.ai_mode not null,
  model          text not null,
  prompt         text,
  input_elements  integer not null default 0,
  output_elements integer not null default 0,
  latency_ms     integer not null default 0,
  prompt_tokens  integer not null default 0,
  output_tokens  integer not null default 0,
  ok             boolean not null default true,
  error          text,
  created_at     timestamptz not null default now()
);

create index if not exists ai_generations_user_idx
  on public.ai_generations (user_id, created_at desc);
create index if not exists ai_generations_created_idx
  on public.ai_generations (created_at desc);

create table if not exists public.vision_jobs (
  id           uuid primary key default gen_random_uuid(),
  board_id     uuid references public.boards(id) on delete set null,
  user_id      uuid references public.profiles(id) on delete set null,
  kind         text not null,
  strokes_in   integer not null default 0,
  shapes_out   integer not null default 0,
  latency_ms   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists vision_jobs_created_idx on public.vision_jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger boards_touch before update on public.boards
  for each row execute function public.touch_updated_at();

-- New auth users get a profile automatically, so the client never has to make a
-- second round trip before it can create a board.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url, is_guest)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, ''), '@', 1),
      'Guest'
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce((new.raw_app_meta_data ->> 'provider') = 'anonymous', false)
      or new.email is null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep revision history bounded. Unbounded history on a board that autosaves
-- every four seconds would dominate the database within a day.
create or replace function public.prune_board_revisions()
returns trigger
language plpgsql
as $$
begin
  delete from public.board_revisions r
  where r.board_id = new.board_id
    and r.id not in (
      select id from public.board_revisions
      where board_id = new.board_id
      order by version desc
      limit 50
    );
  return null;
end;
$$;

create trigger board_revisions_prune
  after insert on public.board_revisions
  for each row execute function public.prune_board_revisions();
