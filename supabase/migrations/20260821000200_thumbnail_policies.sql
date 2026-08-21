-- Re-creates the board-thumbnails storage policies.
--
-- They are already written in ...000400_storage.sql, but they are not in the
-- live database: an authenticated owner uploading to board-files succeeds while
-- the identical shape against board-thumbnails returns "new row violates
-- row-level security policy". Whatever happened during the original push,
-- re-running that migration will not fix it, because a migration already
-- recorded as applied is skipped. Hence a new one.
--
-- Everything here is idempotent and safe to apply twice.
--
-- Wrapped in DO/EXECUTE with a handler for the same reason the realtime.messages
-- policies are: on a hosted project storage.objects belongs to
-- supabase_storage_admin, and CREATE POLICY on a table you do not own raises
-- insufficient_privilege. Failing loudly there would abort the whole migration
-- and leave the schema half applied, so this warns and says what to do instead.
do $$
begin
  execute 'drop policy if exists board_thumbnails_write on storage.objects';
  execute $p$
    create policy board_thumbnails_write on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'board-thumbnails'
        and public.can_edit_board(public.path_board_id(name))
      )
  $p$;

  execute 'drop policy if exists board_thumbnails_update on storage.objects';
  execute $p$
    create policy board_thumbnails_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'board-thumbnails'
        and public.can_edit_board(public.path_board_id(name))
      )
      with check (
        bucket_id = 'board-thumbnails'
        and public.can_edit_board(public.path_board_id(name))
      )
  $p$;

  -- Upsert reads the existing row before replacing it, and the bucket being
  -- public only covers anonymous reads through the CDN, not the storage API.
  -- Without this the second thumbnail a board ever writes would fail.
  execute 'drop policy if exists board_thumbnails_read on storage.objects';
  execute $p$
    create policy board_thumbnails_read on storage.objects
      for select to authenticated
      using (bucket_id = 'board-thumbnails')
  $p$;
exception
  when insufficient_privilege then
    raise warning
      'Could not create the board-thumbnails storage policies (%). Dashboard thumbnails stay blank until these three policies exist. Paste them into the Supabase SQL editor.',
      sqlerrm;
end $$;
