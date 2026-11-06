-- Share cards: start-of-day balance for the day card, remembered background photo, and the photo bucket.

alter table public.positions add column balance_before numeric(14, 2); -- buyer's balance just before this buy (null before this migration)
alter table public.profiles add column card_bg text; -- last background used on a share card: 'purple' or a photo id
grant select (card_bg) on public.profiles to authenticated;

-- Private bucket for card background photos, one folder per user id. Uploads normally go through /api/card-bg
-- (service role); these policies also confine any direct access to the user's own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-backgrounds', 'card-backgrounds', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "card bg: read own" on storage.objects for select to authenticated
  using (bucket_id = 'card-backgrounds' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "card bg: write own" on storage.objects for insert to authenticated
  with check (bucket_id = 'card-backgrounds' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "card bg: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'card-backgrounds' and (storage.foldername(name))[1] = auth.uid()::text);

-- buy_position now also records the buyer's balance just before the purchase (for the day card's % P/L).
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
  balance_before numeric;
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

  balance_before := prof.balance;
  update public.profiles
    set balance = balance - p_premium, points = points + pts, last_buy_at = now()
    where id = p_user
    returning * into prof;
  update public.pool
    set balance = balance + p_premium, premiums_in = premiums_in + p_premium, updated_at = now()
    where id;
  insert into public.positions
    (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, points_awarded, payout_cap, balance_before)
    values
    (p_user, p_asset, p_side, p_strike, p_tenor, p_expiry, p_window_ms, p_premium, p_units,
     least(p_max_payout, cfg.payout_cap * p_premium), p_spot, p_sigma, pts, cfg.payout_cap, balance_before)
    returning * into pos;

  return jsonb_build_object('ok', true, 'position', to_jsonb(pos), 'balance', prof.balance, 'points', prof.points, 'points_awarded', pts);
end $$;
