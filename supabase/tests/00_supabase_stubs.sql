-- Minimal stand-ins for the Supabase-managed schemas, so the Limn migrations
-- can be validated on stock Postgres. NOT part of the project.
do $r$ begin
  create role anon;       exception when duplicate_object then null; end $r$;
do $r$ begin
  create role authenticated; exception when duplicate_object then null; end $r$;
do $r$ begin
  create role service_role;  exception when duplicate_object then null; end $r$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists realtime;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;

create table realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null,
  payload jsonb,
  inserted_at timestamptz default now()
);

create or replace function realtime.topic() returns text
language sql stable as $$ select current_setting('realtime.topic', true) $$;
