\set ON_ERROR_STOP on
\pset pager off

-- Three actors: the board owner, someone who redeems a share link, and a
-- stranger who should see nothing.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'owner@limn.test',  '{"display_name":"Owner"}'),
  ('22222222-2222-2222-2222-222222222222', 'friend@limn.test', '{"display_name":"Friend"}'),
  ('33333333-3333-3333-3333-333333333333', 'nosy@limn.test',   '{"display_name":"Nosy"}');

\echo '--- profiles auto-created by trigger (expect 3)'
select count(*) as profiles from public.profiles;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;

\echo '--- owner creates a board'
select id as board_id, title, visibility from public.create_board('Systems diagram') \gset
select :'board_id' as created;

\echo '--- role resolution: owner'
select public.board_role_for(:'board_id'::uuid) as role,
       public.can_edit_board(:'board_id'::uuid) as can_edit;

\echo '--- CAS: first save from base version 0 must succeed'
select * from public.save_board_snapshot(
  :'board_id'::uuid,
  '[{"id":"a","version":1,"versionNonce":10},
    {"id":"b","version":1,"versionNonce":11},
    {"id":"c","version":3,"versionNonce":12,"isDeleted":true}]'::jsonb,
  0);

\echo '--- element_count must exclude tombstones (expect 2)'
select element_count from public.boards where id = :'board_id'::uuid;

\echo '--- CAS: a stale writer must be rejected, not silently clobber'
select * from public.save_board_snapshot(
  :'board_id'::uuid, '[]'::jsonb, 0);

\echo '--- scene must be unchanged after the rejected write (expect 3 elements, version 1)'
select version, jsonb_array_length(elements) as elements
from public.board_snapshots where board_id = :'board_id'::uuid;

\echo '--- CAS: retry at the current version succeeds'
select * from public.save_board_snapshot(
  :'board_id'::uuid,
  '[{"id":"a","version":2,"versionNonce":20}]'::jsonb, 1);

\echo '--- revision history is sampled every 10th version, not every save (expect 0)'
select count(*) as revisions from public.board_revisions where board_id = :'board_id'::uuid;

reset role;

-- ---------------------------------------------------------------------------
\echo ''
\echo '=== stranger: no access before redeeming a link ==='
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set role authenticated;

select coalesce(public.board_role_for(:'board_id'::uuid)::text, 'NONE') as role;
\echo '--- RLS must hide the board entirely (expect 0)'
select count(*) as visible_boards from public.boards where id = :'board_id'::uuid;
\echo '--- and hide the scene (expect 0)'
select count(*) as visible_snapshots from public.board_snapshots where board_id = :'board_id'::uuid;

\echo '--- direct snapshot writes must be denied even for a would-be editor'
do $$
begin
  update public.board_snapshots set elements = '[]'::jsonb;
  raise notice 'UNEXPECTED: direct snapshot write succeeded';
exception when others then
  raise notice 'correctly blocked: %', sqlerrm;
end $$;

reset role;

-- ---------------------------------------------------------------------------
\echo ''
\echo '=== friend redeems the share link ==='
select share_token from public.boards where id = :'board_id'::uuid \gset

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set role authenticated;

select id = :'board_id'::uuid as claimed_right_board
from public.claim_board_access(:'share_token');

\echo '--- friend is now an editor (link_role default)'
select public.board_role_for(:'board_id'::uuid) as role,
       public.can_edit_board(:'board_id'::uuid) as can_edit;

\echo '--- and can now see the board through RLS (expect 1)'
select count(*) as visible_boards from public.boards where id = :'board_id'::uuid;

\echo '--- friend can save (expect saved=t)'
select saved from public.save_board_snapshot(
  :'board_id'::uuid, '[{"id":"a","version":3,"versionNonce":30}]'::jsonb, 2);

\echo '--- but must NOT be able to change sharing settings'
do $$
begin
  update public.boards set visibility = 'public';
  raise notice 'UNEXPECTED: non-owner changed visibility';
exception when others then
  raise notice 'correctly blocked: %', sqlerrm;
end $$;

reset role;

-- ---------------------------------------------------------------------------
\echo ''
\echo '=== realtime channel authorization ==='
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set role authenticated;
select public.can_read_board(public.topic_board_id('board:' || :'board_id')) as stranger_may_subscribe;
reset role;

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set role authenticated;
select public.can_read_board(public.topic_board_id('board:' || :'board_id')) as friend_may_subscribe,
       public.can_edit_board(public.topic_board_id('board:' || :'board_id')) as friend_may_broadcast;
reset role;

\echo '--- malformed topics must return null, never raise'
select public.topic_board_id('board:not-a-uuid') as bad_uuid,
       public.topic_board_id('haxx:11111111-1111-1111-1111-111111111111') as wrong_prefix,
       public.topic_board_id(null) as null_topic;

\echo ''
\echo '=== platform_stats ==='
select public.platform_stats() -> 'boards' as boards,
       public.platform_stats() -> 'elements' as elements;
