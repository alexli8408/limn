-- boards.thumbnail_url held whatever the client put in it, and the dashboard
-- loaded it into an <img>.
--
-- Nothing constrained the value. boards has a table-wide update grant to
-- authenticated, boards_update only tests can_edit_board, and the sharing guard
-- covers visibility, share_token, link_role and owner_id but not this column.
-- Boards default to visibility 'link' with link_role 'editor', so anyone who has
-- ever opened a share link could point the column at a host they control and
-- have the owner's browser fetch it every time they open their dashboard. There
-- is no Content-Security-Policy on the deployment to stop the request.
--
-- The column now holds the object's path inside the bucket rather than a URL, so
-- the origin comes from the application's own configuration and is no longer
-- something a caller can supply at all. What remains for the database to check
-- is that a board only ever points at its own object, which is a fact it has.

-- Existing rows carry a full public URL. Everything from the bucket name onward
-- is already the path, so the backfill is a substring rather than a reset, and
-- no thumbnail has to be regenerated.
update public.boards
   set thumbnail_url = split_part(thumbnail_url, '/board-thumbnails/', 2)
 where thumbnail_url like '%/board-thumbnails/%';

-- Anything that did not match was not one of ours. Better a blank card than an
-- unexplained request from someone's dashboard.
update public.boards
   set thumbnail_url = null
 where thumbnail_url is not null
   and thumbnail_url not like (id::text || '/%');

create or replace function public.guard_thumbnail_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.thumbnail_url is not null
     and new.thumbnail_url is distinct from old.thumbnail_url
     and new.thumbnail_url not like (new.id::text || '/%') then
    raise exception 'thumbnail_url must be a path inside this board''s own folder'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists boards_guard_thumbnail on public.boards;
create trigger boards_guard_thumbnail
  before update on public.boards
  for each row execute function public.guard_thumbnail_path();

-- Deleting a board left its thumbnail on the CDN, where it stayed readable by
-- anyone who had ever seen the board's id. There was no delete policy on the
-- bucket at all, so the owner could not have removed it even deliberately.
do $$
begin
  execute 'drop policy if exists board_thumbnails_delete on storage.objects';
  execute $p$
    create policy board_thumbnails_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'board-thumbnails'
        and public.can_edit_board(public.path_board_id(name))
      )
  $p$;
exception
  when insufficient_privilege then
    raise warning
      'Could not create board_thumbnails_delete (%). A deleted board leaves its thumbnail readable on the CDN. Paste this into the Supabase SQL editor.',
      sqlerrm;
end $$;
