-- Narrows board_thumbnails_read, which was written far wider than it needed.
--
-- ...000200 created it as:
--
--     for select to authenticated using (bucket_id = 'board-thumbnails')
--
-- The reason it exists is that an upsert reads the existing row before replacing
-- it, so without a select policy the second thumbnail a board ever writes fails.
-- That is a statement about the board being written to, and the policy did not
-- mention the board at all: every signed-in account could list and read every
-- thumbnail in the project. The sibling bucket does this correctly, see
-- board_files_read in ...000400_storage.sql, and the header of that same file
-- says these helpers are what guards the blobs.
--
-- can_read_board rather than can_edit_board, because it also has to cover the
-- dashboard reading a thumbnail for a board someone shared with you. Editing
-- implies reading, so the upsert case is still satisfied.
do $$
begin
  execute 'drop policy if exists board_thumbnails_read on storage.objects';
  execute $p$
    create policy board_thumbnails_read on storage.objects
      for select to authenticated
      using (
        bucket_id = 'board-thumbnails'
        and public.can_read_board(public.path_board_id(name))
      )
  $p$;
exception
  when insufficient_privilege then
    raise warning
      'Could not narrow board_thumbnails_read (%). The policy from ...000200 stays in place, which lets any signed-in user read any thumbnail. Paste this into the Supabase SQL editor.',
      sqlerrm;
end $$;

-- Note on the bucket itself, which this migration deliberately does not change.
--
-- board-thumbnails is public, so the policy above governs the storage API while
-- the CDN serves the same objects to anyone with the URL and no auth at all.
-- That is what public was chosen for: the dashboard grid and link previews read
-- thumbnails without minting a signed URL per card.
--
-- The exposure it leaves is real but narrow. The path is <board_id>/thumb.png
-- and board ids are v4 UUIDs, so it is not enumerable; what it does mean is that
-- anyone who has ever held a board's id keeps a live 640px render of it after
-- their access is removed, because nothing deletes the object when a
-- collaborator is removed or a board is deleted. Closing it properly means
-- signed URLs on the dashboard and a delete alongside every access change, which
-- is a feature-sized change rather than a policy fix, so it is written down in
-- docs/ARCHITECTURE.md rather than half-done here.
