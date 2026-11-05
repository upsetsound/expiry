-- Read access for everyone, writes only through server code (service role) and security-definer functions.
-- New Supabase projects grant nothing on migration-created tables, so every grant here is explicit.

alter table public.profiles enable row level security;
alter table public.positions enable row level security;
alter table public.settlements enable row level security;
alter table public.pool enable row level security;

revoke all on public.profiles, public.positions, public.settlements, public.pool from anon, authenticated;

-- Profiles: other people's balance and top-up time stay private (column grants). Your own come from my_account().
grant select (id, x_handle, avatar_url, points, created_at) on public.profiles to anon, authenticated;
grant select on public.positions, public.settlements, public.pool to anon, authenticated;

create policy "profiles are public" on public.profiles for select to anon, authenticated using (true);
create policy "positions are public" on public.positions for select to anon, authenticated using (true);
create policy "settlements are public" on public.settlements for select to anon, authenticated using (true);
create policy "pool is public" on public.pool for select to anon, authenticated using (true);

-- No insert/update/delete policies: clients cannot write. The service role bypasses RLS but still needs grants.
grant select, insert, update, delete on public.profiles, public.positions, public.settlements, public.pool to service_role;

-- Functions are executable by PUBLIC by default; lock that down and grant per function in later migrations.
alter default privileges in schema public revoke execute on functions from public;
revoke execute on function public.sync_profile_from_auth() from public, anon, authenticated;
