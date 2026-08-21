-- An editor could take a board off its owner.
--
-- guard_board_ownership_fields() decides whether to run its checks like this:
--
--     if auth.uid() is not null and new.owner_id <> auth.uid() then
--
-- The test is on `new`, the row as it will be after the update. So the way past
-- every check inside it is to set the very column the checks exist to protect:
--
--     update public.boards set owner_id = '<my uid>' where id = '<the board>';
--
-- With new.owner_id equal to auth.uid(), the outer condition is false, the body
-- never runs, and the update proceeds. boards_update's `with check` then
-- re-evaluates can_edit_board against the post-trigger row, where the caller is
-- already the owner, so it passes too. Column-level grants do not help: the
-- update grant on boards is column-unrestricted.
--
-- Afterwards board_role_for returns 'owner' for the attacker and null for the
-- real owner, who loses the board, its snapshots and its collaborator list, and
-- has no way back because every policy that could restore it is owner-gated.
-- Anyone holding an editor share link could do it with one PATCH.
--
-- The fix is one word: the guard belongs on `old`. Whether these columns may be
-- touched is a fact about who the caller is now, not about what they would like
-- the row to say afterwards.
--
-- auth.uid() null still passes through, as before. That is the service role,
-- which bypasses RLS anyway, and the SECURITY DEFINER functions that legitimately
-- rewrite these columns: claim_board_access and rotate_share_token.
create or replace function public.guard_board_ownership_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and old.owner_id <> auth.uid() then
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
