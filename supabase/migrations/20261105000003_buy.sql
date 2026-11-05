-- buy_position: the only way a position gets created. Called by POST /api/buy with the service role after the
-- server has priced the trade. Locks the buyer's profile row and the pool row, so concurrent buys run one at a
-- time and can't overdraw a balance or push the shared pool past its liability limits.
-- Limits mirror RULES in src/lib/pricing.ts (tests check they stay in sync).

create function public.buy_position(
  p_user uuid,
  p_asset text,
  p_side text,
  p_strike double precision,
  p_tenor text,
  p_expiry timestamptz,
  p_window_ms integer,
  p_premium numeric,
  p_units double precision,
  p_max_payout numeric,
  p_spot double precision,
  p_sigma double precision
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_min_premium constant numeric := 1;
  c_max_per_trade constant numeric := 250;
  c_max_per_expiry constant numeric := 1000;
  c_side_share constant numeric := 0.3;
  c_total_share constant numeric := 0.6;
  c_points constant integer := 10;
  c_points_per_day constant integer := 24;
  prof public.profiles;
  pl public.pool;
  spent numeric;
  side_liab numeric;
  total_liab numeric;
  day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  earned_today integer;
  pts integer := 0;
  pos public.positions;
begin
  -- Lock order is always profile, then pool, to avoid deadlocks.
  select * into prof from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('error', 'no_profile');
  end if;
  select * into pl from public.pool where id for update;

  if prof.last_buy_at is not null and now() - prof.last_buy_at < interval '1 second' then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_premium < c_min_premium then
    return jsonb_build_object('error', 'min_premium');
  end if;
  if p_premium > c_max_per_trade then
    return jsonb_build_object('error', 'max_per_trade');
  end if;
  if p_premium > prof.balance then
    return jsonb_build_object('error', 'balance');
  end if;

  select coalesce(sum(premium), 0) into spent
    from public.positions where user_id = p_user and asset = p_asset and expiry = p_expiry;
  if spent + p_premium > c_max_per_expiry then
    return jsonb_build_object('error', 'max_per_expiry');
  end if;

  select coalesce(sum(max_payout), 0) into side_liab
    from public.positions where status = 'open' and asset = p_asset and expiry = p_expiry and side = p_side;
  select coalesce(sum(max_payout), 0) into total_liab
    from public.positions where status = 'open';
  if side_liab + p_max_payout > c_side_share * pl.balance or total_liab + p_max_payout > c_total_share * pl.balance then
    return jsonb_build_object('error', 'pool_limit');
  end if;

  -- 10 points for the first trade in a new expiry (per asset), at most 24 awards per UTC day.
  if not exists (select 1 from public.positions where user_id = p_user and asset = p_asset and expiry = p_expiry) then
    select count(*) into earned_today
      from public.positions where user_id = p_user and points_awarded > 0 and created_at >= day_start;
    if earned_today < c_points_per_day then
      pts := c_points;
    end if;
  end if;

  update public.profiles
    set balance = balance - p_premium, points = points + pts, last_buy_at = now()
    where id = p_user
    returning * into prof;
  update public.pool
    set balance = balance + p_premium, premiums_in = premiums_in + p_premium, updated_at = now()
    where id;
  insert into public.positions
    (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, points_awarded)
    values
    (p_user, p_asset, p_side, p_strike, p_tenor, p_expiry, p_window_ms, p_premium, p_units, p_max_payout, p_spot, p_sigma, pts)
    returning * into pos;

  return jsonb_build_object('ok', true, 'position', to_jsonb(pos), 'balance', prof.balance, 'points', prof.points, 'points_awarded', pts);
end $$;

revoke execute on function public.buy_position(uuid, text, text, double precision, text, timestamptz, integer, numeric, double precision, numeric, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.buy_position(uuid, text, text, double precision, text, timestamptz, integer, numeric, double precision, numeric, double precision, double precision)
  to service_role;
