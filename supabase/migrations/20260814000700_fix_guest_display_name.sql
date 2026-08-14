-- Anonymous users were getting an empty display name, not 'Guest'.
--
-- The fallback chain in handle_new_user() ended with:
--
--     split_part(coalesce(new.email, ''), '@', 1),
--     'Guest'
--
-- For an anonymous sign-in `email` is null, so that expression evaluates
-- split_part('', '@', 1), which returns the empty string rather than null.
-- coalesce stops at the first non-null argument, so it returned '' and never
-- reached 'Guest'. Every guest ended up nameless in the presence bar and on
-- their own cursor label.
--
-- Only a real anonymous sign-in shows this: the local test suite creates users
-- with email addresses, where the same expression correctly yields the local
-- part. The test now covers the null-email case too.

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
      -- nullif on each branch: an empty string is a missing name, not a name.
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Guest'
    ),
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    coalesce((new.raw_app_meta_data ->> 'provider') = 'anonymous', false)
      or new.email is null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Repair anyone who already signed up nameless.
update public.profiles
set display_name = 'Guest'
where coalesce(btrim(display_name), '') = '';
