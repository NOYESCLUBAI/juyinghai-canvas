-- Run after the tables migration, in the Supabase SQL editor.
-- The storage schema exists on Supabase projects. FastAPI uploads with the
-- service role; these policies stop a signed-in browser from listing or
-- reading another user's objects. Object keys are `{user_id}/{asset_id}`.

insert into storage.buckets (id, name, public)
values ('manjinhai-media', 'manjinhai-media', false)
on conflict (id) do update set public = false;

drop policy if exists manjinhai_media_owner_read on storage.objects;
create policy manjinhai_media_owner_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'manjinhai-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists manjinhai_media_owner_insert on storage.objects;
create policy manjinhai_media_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'manjinhai-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists manjinhai_media_owner_delete on storage.objects;
create policy manjinhai_media_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'manjinhai-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
