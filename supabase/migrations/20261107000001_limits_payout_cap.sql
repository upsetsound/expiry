-- Trade limits and the payout cap move into settings (editable without a deploy), and every position keeps the
-- cap it was bought with: existing positions keep 20x, new ones get settings.payout_cap (100x).

alter table public.settings
  add column max_premium_per_trade numeric(12, 2) not null default 1000 check (max_premium_per_trade > 0),
  add column max_premium_per_round numeric(12, 2) not null default 5000 check (max_premium_per_round > 0),
  add column payout_cap numeric(8, 2) not null default 100 check (payout_cap >= 1);

alter table public.positions add column payout_cap numeric(8, 2) not null default 20 check (payout_cap >= 1);
alter table public.positions alter column payout_cap set default 100;

-- Payout for one position: units x intrinsic, capped at the position's own cap x premium.
drop function public.position_payout(text, double precision, double precision, double precision, numeric);
create function public.position_payout(p_side text, p_settle double precision, p_strike double precision, p_units double precision, p_premium numeric, p_cap numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select round(least(
    (p_units * greatest(case when p_side = 'call' then p_settle - p_strike else p_strike - p_settle end, 0))::numeric,
    p_cap * p_premium
  ), 2)
$$;
grant execute on function public.position_payout(text, double precision, double precision, double precision, numeric, numeric) to service_role;

create or replace function public.settle_round(
  p_asset text,
  p_tenor text,
  p_expiry timestamptz,
  p_price double precision,
  p_window_ms integer,
  p_source text,
  p_coverage double precision default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_price double precision;
  v_count integer;
  v_total numeric;
begin
  if p_expiry > now() then
    return jsonb_build_object('error', 'not_expired');
  end if;

  insert into public.settlements (asset, tenor, expiry, price, window_ms, source, coverage)
    values (p_asset, p_tenor, p_expiry, p_price, p_window_ms, p_source, p_coverage)
    on conflict (asset, tenor, expiry) do nothing;
  select price into v_price from public.settlements where asset = p_asset and tenor = p_tenor and expiry = p_expiry;

  with paid as (
    update public.positions
      set status = 'settled',
          settle_price = v_price,
          payout = public.position_payout(side, v_price, strike, units, premium, payout_cap),
          settled_at = now()
      where asset = p_asset and tenor = p_tenor and expiry = p_expiry and status = 'open'
      returning user_id, payout
  ), per_user as (
    select user_id, sum(payout) as total from paid group by user_id
  ), credit as (
    update public.profiles pr set balance = pr.balance + per_user.total
      from per_user where pr.id = per_user.user_id
      returning 1
  )
  select count(*), coalesce(sum(payout), 0) into v_count, v_total from paid;

  if v_total > 0 then
    update public.pool set balance = balance - v_total, paid_out = paid_out + v_total, updated_at = now() where id;
  end if;

  return jsonb_build_object('ok', true, 'price', v_price, 'settled', v_count, 'paid', v_total);
end $$;

-- buy_position: limits and the cap now come from settings; the cap is stored on the position.
create or replace function public.buy_position(
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
  c_side_share constant numeric := 0.3;
  c_total_share constant numeric := 0.6;
  c_points constant integer := 10;
  c_points_per_day constant integer := 24;
  cfg public.settings;
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
  select * into cfg from public.settings limit 1;

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
  if p_premium > cfg.max_premium_per_trade then
    return jsonb_build_object('error', 'max_per_trade', 'limit', cfg.max_premium_per_trade);
  end if;
  if p_premium > prof.balance then
    return jsonb_build_object('error', 'balance');
  end if;

  select coalesce(sum(premium), 0) into spent
    from public.positions where user_id = p_user and asset = p_asset and expiry = p_expiry;
  if spent + p_premium > cfg.max_premium_per_round then
    return jsonb_build_object('error', 'max_per_expiry', 'limit', cfg.max_premium_per_round);
  end if;

  select coalesce(sum(max_payout), 0) into side_liab
    from public.positions where status = 'open' and asset = p_asset and expiry = p_expiry and side = p_side;
  select coalesce(sum(max_payout), 0) into total_liab
    from public.positions where status = 'open';
  if side_liab + p_max_payout > c_side_share * pl.balance or total_liab + p_max_payout > c_total_share * pl.balance then
    return jsonb_build_object('error', 'pool_limit');
  end if;

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
    (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, points_awarded, payout_cap)
    values
    (p_user, p_asset, p_side, p_strike, p_tenor, p_expiry, p_window_ms, p_premium, p_units,
     least(p_max_payout, cfg.payout_cap * p_premium), p_spot, p_sigma, pts, cfg.payout_cap)
    returning * into pos;

  return jsonb_build_object('ok', true, 'position', to_jsonb(pos), 'balance', prof.balance, 'points', prof.points, 'points_awarded', pts);
end $$;
