-- Storage buckets for images pasted onto a board, and for board thumbnails.
--
-- Object naming convention is `<board_id>/<file_id>`, which lets the same
-- can_read_board / can_edit_board helpers that guard the tables also guard the
-- blobs — see path_board_id() in the RLS migration.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'board-files',
  'board-files',
  false,
  10 * 1024 * 1024,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public so thumbnails can be served straight off the CDN into share previews
-- and the dashboard grid without minting a signed URL per card.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'board-thumbnails',
  'board-thumbnails',
  true,
  2 * 1024 * 1024,
  array['image/png', 'image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit;

drop policy if exists board_files_read on storage.objects;
create policy board_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'board-files'
    and public.can_read_board(public.path_board_id(name))
  );

drop policy if exists board_files_write on storage.objects;
create policy board_files_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'board-files'
    and public.can_edit_board(public.path_board_id(name))
  );

drop policy if exists board_files_delete on storage.objects;
create policy board_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'board-files'
    and public.can_edit_board(public.path_board_id(name))
  );

drop policy if exists board_thumbnails_write on storage.objects;
create policy board_thumbnails_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'board-thumbnails'
    and public.can_edit_board(public.path_board_id(name))
  );

drop policy if exists board_thumbnails_update on storage.objects;
create policy board_thumbnails_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'board-thumbnails'
    and public.can_edit_board(public.path_board_id(name))
  )
  with check (
    bucket_id = 'board-thumbnails'
    and public.can_edit_board(public.path_board_id(name))
  );
