-- Server-side settlement. The `settle` edge function lists due rounds, fetches each round's price and calls
-- settle_round. Idempotent: the round's price is written once (later calls reuse it), and only positions still
-- 'open' are paid. Concurrent calls block on the position row locks and then skip rows already settled.

-- Rounds that have expired and still have open positions. A 2s grace lets the 1-second price data catch up.
create function public.due_rounds()
returns table (asset text, tenor text, expiry timestamptz, window_ms integer, settled_price double precision)
language sql stable security definer set search_path = '' as $$
  select p.asset, p.tenor, p.expiry, max(p.window_ms)::integer, s.price
  from public.positions p
  left join public.settlements s on s.asset = p.asset and s.tenor = p.tenor and s.expiry = p.expiry
  where p.status = 'open' and p.expiry <= now() - interval '2 seconds'
  group by p.asset, p.tenor, p.expiry, s.price
  order by p.expiry
  limit 100
$$;

-- Payout for one position. Same rule as payout() in src/lib/pricing.ts: units x intrinsic, capped at 20 x premium.
create function public.position_payout(p_side text, p_settle double precision, p_strike double precision, p_units double precision, p_premium numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select round(least(
    (p_units * greatest(case when p_side = 'call' then p_settle - p_strike else p_strike - p_settle end, 0))::numeric,
    20 * p_premium
  ), 2)
$$;

create function public.settle_round(
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
          payout = public.position_payout(side, v_price, strike, units, premium),
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

revoke execute on function public.due_rounds() from public, anon, authenticated;
revoke execute on function public.settle_round(text, text, timestamptz, double precision, integer, text, double precision) from public, anon, authenticated;
grant execute on function public.due_rounds() to service_role;
grant execute on function public.settle_round(text, text, timestamptz, double precision, integer, text, double precision) to service_role;
grant execute on function public.position_payout(text, double precision, double precision, double precision, numeric) to service_role;
