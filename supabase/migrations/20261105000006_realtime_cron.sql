-- Live updates: everyone's trades and settlements, and the shared pool.
alter publication supabase_realtime add table public.positions, public.pool;

-- Settlement runs every 15 seconds (pg_cron 1.5+ supports second intervals; Supabase ships 1.6).
-- It calls the `settle` edge function with pg_net. The URL and secret live in Vault, set once per environment:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/settle', 'settle_url');
--   select vault.create_secret('<random secret>', 'settle_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;

create function public.invoke_settle() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'settle_url' limit 1);
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'settle_secret' limit 1);
begin
  if v_url is null or v_secret is null then
    return null; -- not configured in this environment
  end if;
  -- Skip the HTTP call entirely when nothing is due.
  if not exists (select 1 from public.positions where status = 'open' and expiry <= now() - interval '2 seconds') then
    return null;
  end if;
  return net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-settle-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end $$;

revoke execute on function public.invoke_settle() from public, anon, authenticated;

select cron.schedule('settle-expired-rounds', '15 seconds', 'select public.invoke_settle()');
