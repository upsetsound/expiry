-- The signed-in user's own account (balance and top-up time are not readable through the profiles table).
create function public.my_account()
returns table (id uuid, x_handle text, avatar_url text, balance numeric, points integer, last_top_up timestamptz)
language sql stable security definer set search_path = '' as $$
  select id, x_handle, avatar_url, balance, points, last_top_up from public.profiles where id = auth.uid()
$$;

-- Weekly top-up: +$10,000 when the balance is under $1,000, at most once every 7 days. Called by POST /api/topup.
create function public.topup(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
begin
  select * into prof from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('error', 'no_profile');
  end if;
  if prof.balance >= 1000 then
    return jsonb_build_object('error', 'balance_too_high');
  end if;
  if now() - prof.last_top_up < interval '7 days' then
    return jsonb_build_object('error', 'too_soon', 'next_at', prof.last_top_up + interval '7 days');
  end if;
  update public.profiles set balance = balance + 10000, last_top_up = now() where id = p_user returning * into prof;
  return jsonb_build_object('ok', true, 'balance', prof.balance);
end $$;

-- Weekly leaderboard (weeks start Monday 00:00 UTC), ranked by realized P/L on positions settled that week.
-- Returns the top 50 plus the caller's own row wherever it ranks.
create function public.leaderboard(p_week_start timestamptz default null)
returns table (
  rank bigint,
  user_id uuid,
  x_handle text,
  avatar_url text,
  pnl numeric,
  trades bigint,
  wins bigint,
  win_rate double precision,
  best_multiple double precision,
  points bigint,
  is_me boolean
)
language sql stable security definer set search_path = '' as $$
  with wk as (
    select coalesce(p_week_start, date_trunc('week', now() at time zone 'utc') at time zone 'utc') as start
  ), agg as (
    select p.user_id,
           sum(p.payout - p.premium) as pnl,
           count(*) as trades,
           count(*) filter (where p.payout > p.premium) as wins,
           max(p.payout / p.premium)::double precision as best_multiple
    from public.positions p, wk
    where p.status = 'settled' and p.settled_at >= wk.start and p.settled_at < wk.start + interval '7 days'
    group by p.user_id
  ), pts as (
    select p.user_id, sum(p.points_awarded) as points
    from public.positions p, wk
    where p.created_at >= wk.start and p.created_at < wk.start + interval '7 days'
    group by p.user_id
  ), ranked as (
    select rank() over (order by agg.pnl desc) as rank,
           agg.user_id, pr.x_handle, pr.avatar_url, agg.pnl, agg.trades, agg.wins,
           agg.wins::double precision / agg.trades as win_rate,
           agg.best_multiple,
           coalesce(pts.points, 0) as points,
           agg.user_id = auth.uid() as is_me
    from agg
    join public.profiles pr on pr.id = agg.user_id
    left join pts on pts.user_id = agg.user_id
  )
  select * from ranked where rank <= 50 or is_me order by rank, x_handle
$$;

-- Global stats for the stats bar: 24h premium volume and open interest (premium) by side, for one asset.
create function public.asset_stats(p_asset text)
returns table (vol24 numeric, call_oi numeric, put_oi numeric)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(sum(premium) filter (where created_at > now() - interval '24 hours'), 0),
    coalesce(sum(premium) filter (where status = 'open' and side = 'call'), 0),
    coalesce(sum(premium) filter (where status = 'open' and side = 'put'), 0)
  from public.positions
  where asset = p_asset and (created_at > now() - interval '24 hours' or status = 'open')
$$;

revoke execute on function public.topup(uuid) from public, anon, authenticated;
grant execute on function public.topup(uuid) to service_role;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated, service_role;
grant execute on function public.leaderboard(timestamptz) to anon, authenticated, service_role;
grant execute on function public.asset_stats(text) to anon, authenticated, service_role;
