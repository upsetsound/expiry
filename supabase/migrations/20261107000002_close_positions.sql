-- Closing a position before expiry: the pool buys it back at its bid. A closed position never settles
-- (settle_round only pays status = 'open'), and the leaderboard and admin stats count it as realized P/L.

alter table public.positions drop constraint positions_status_check;
alter table public.positions add constraint positions_status_check check (status in ('open', 'settled', 'closed'));
alter table public.positions
  add column close_price double precision,
  add column close_proceeds numeric(14, 2),
  add column closed_at timestamptz;

-- Called by POST /api/close with the service role after the server has priced the bid.
-- Lock order matches settle_round (position, then profile, then pool) so the two can't deadlock.
create function public.close_position(p_user uuid, p_position uuid, p_price double precision, p_proceeds numeric)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pos public.positions;
  prof public.profiles;
  proceeds numeric := round(p_proceeds, 2);
begin
  select * into pos from public.positions where id = p_position for update;
  if not found or pos.user_id <> p_user then
    return jsonb_build_object('error', 'not_found');
  end if;
  if pos.status <> 'open' then
    return jsonb_build_object('error', 'not_open', 'status', pos.status);
  end if;
  if now() >= pos.expiry - make_interval(secs => pos.window_ms / 1000.0) then
    return jsonb_build_object('error', 'settling');
  end if;
  if proceeds < 0 or proceeds > pos.payout_cap * pos.premium then
    return jsonb_build_object('error', 'bad_proceeds');
  end if;

  select * into prof from public.profiles where id = p_user for update;
  perform 1 from public.pool where id for update;

  update public.positions
    set status = 'closed', close_price = p_price, close_proceeds = proceeds, closed_at = now()
    where id = p_position
    returning * into pos;
  update public.profiles set balance = balance + proceeds where id = p_user returning * into prof;
  update public.pool set balance = balance - proceeds, paid_out = paid_out + proceeds, updated_at = now() where id;

  return jsonb_build_object('ok', true, 'position', to_jsonb(pos), 'balance', prof.balance);
end $$;

revoke execute on function public.close_position(uuid, uuid, double precision, numeric) from public, anon, authenticated;
grant execute on function public.close_position(uuid, uuid, double precision, numeric) to service_role;

create or replace function public.leaderboard(p_week_start timestamptz default null)
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
  is_me boolean,
  eligible boolean,
  prize_place integer,
  prize numeric
)
language sql stable security definer set search_path = '' as $$
  with cfg as (
    select prizes_enabled, prize_amounts, prize_min_trades from public.settings limit 1
  ), wk as (
    select coalesce(p_week_start, date_trunc('week', now() at time zone 'utc') at time zone 'utc') as start
  ), agg as (
    select p.user_id,
           sum(coalesce(p.payout, p.close_proceeds) - p.premium) as pnl,
           count(*) as trades,
           count(*) filter (where coalesce(p.payout, p.close_proceeds) > p.premium) as wins,
           max(coalesce(p.payout, p.close_proceeds) / p.premium)::double precision as best_multiple
    from public.positions p, wk
    -- Realized P/L: settled positions (payout) and positions closed early (close proceeds).
    where p.status in ('settled', 'closed')
      and coalesce(p.settled_at, p.closed_at) >= wk.start and coalesce(p.settled_at, p.closed_at) < wk.start + interval '7 days'
    group by p.user_id
  ), pts as (
    select p.user_id, sum(p.points_awarded) as points
    from public.positions p, wk
    where p.created_at >= wk.start and p.created_at < wk.start + interval '7 days'
    group by p.user_id
  ), ranked as (
    select rank() over (order by agg.pnl desc, agg.trades desc) as rank,
           agg.user_id, pr.x_handle, pr.avatar_url, agg.pnl, agg.trades, agg.wins,
           agg.wins::double precision / agg.trades as win_rate,
           agg.best_multiple,
           coalesce(pts.points, 0) as points,
           agg.user_id = auth.uid() as is_me,
           agg.trades >= coalesce((select prize_min_trades from cfg), 20) as eligible
    from agg
    join public.profiles pr on pr.id = agg.user_id
    left join pts on pts.user_id = agg.user_id
  ), placed as (
    select r.*,
           case when r.eligible
                then row_number() over (partition by r.eligible order by r.rank, r.user_id)
           end as place
    from ranked r
  )
  select pl.rank, pl.user_id, pl.x_handle, pl.avatar_url, pl.pnl, pl.trades, pl.wins, pl.win_rate, pl.best_multiple,
         pl.points, pl.is_me, pl.eligible,
         case when cfg.prizes_enabled and pl.place <= coalesce(array_length(cfg.prize_amounts, 1), 0) then pl.place::integer end,
         case when cfg.prizes_enabled and pl.place <= coalesce(array_length(cfg.prize_amounts, 1), 0) then cfg.prize_amounts[pl.place] end
  from placed pl, cfg
  where pl.rank <= 50 or pl.is_me
  order by pl.rank, pl.x_handle
$$;

create or replace view public.admin_daily as
with days as (
  select generate_series(
    (date_trunc('day', now() at time zone 'utc') - interval '59 days')::date,
    (now() at time zone 'utc')::date,
    interval '1 day'
  )::date as day
), start_pool as (
  -- The pool's opening balance: current balance with every premium and payout backed out.
  select balance - premiums_in + paid_out as opening from public.pool limit 1
)
select
  d.day,
  (select count(*) from public.profiles p where (p.created_at at time zone 'utc')::date = d.day) as signups,
  (select count(distinct x.user_id) from public.positions x where (x.created_at at time zone 'utc')::date = d.day) as active_traders,
  (select count(*) from public.positions x where (x.created_at at time zone 'utc')::date = d.day) as trades,
  (select coalesce(sum(x.premium), 0) from public.positions x where (x.created_at at time zone 'utc')::date = d.day) as premium_volume,
  (select count(*) from public.positions x where x.status in ('settled', 'closed') and (coalesce(x.settled_at, x.closed_at) at time zone 'utc')::date = d.day and coalesce(x.payout, x.close_proceeds) > x.premium) as wins,
  (select count(*) from public.positions x where x.status in ('settled', 'closed') and (coalesce(x.settled_at, x.closed_at) at time zone 'utc')::date = d.day and coalesce(x.payout, x.close_proceeds) <= x.premium) as losses,
  (select sp.opening
          + coalesce((select sum(x.premium) from public.positions x where (x.created_at at time zone 'utc')::date <= d.day), 0)
          - coalesce((select sum(x.payout) from public.positions x where x.status = 'settled' and (x.settled_at at time zone 'utc')::date <= d.day), 0)
          - coalesce((select sum(x.close_proceeds) from public.positions x where x.status = 'closed' and (x.closed_at at time zone 'utc')::date <= d.day), 0)
   from start_pool sp) as pool_close
from days d
order by d.day;

create or replace view public.admin_totals as
select
  (select count(*) from public.profiles) as signups,
  (select count(distinct user_id) from public.positions) as traders,
  (select count(*) from public.positions) as trades,
  (select coalesce(sum(premium), 0) from public.positions) as premium_volume,
  (select count(*) from public.positions where status in ('settled', 'closed') and coalesce(payout, close_proceeds) > premium) as wins,
  (select count(*) from public.positions where status in ('settled', 'closed') and coalesce(payout, close_proceeds) <= premium) as losses,
  (select balance from public.pool limit 1) as pool_balance;

-- Retention by signup day: of the people who signed up that day, how many traded again on day 1 / day 7.
-- d1_eligible / d7_eligible: the cohort is old enough for that day to have happened.
create or replace view public.admin_retention as
with cohort as (
  select id, (created_at at time zone 'utc')::date as signup_day from public.profiles
), activity as (
  select distinct user_id, (created_at at time zone 'utc')::date as day from public.positions
)
select
  c.signup_day,
  count(*) as signups,
  count(*) filter (where exists (select 1 from activity a where a.user_id = c.id and a.day = c.signup_day + 1)) as d1_retained,
  count(*) filter (where exists (select 1 from activity a where a.user_id = c.id and a.day = c.signup_day + 7)) as d7_retained,
  (c.signup_day + 1 < (now() at time zone 'utc')::date) as d1_eligible,
  (c.signup_day + 7 < (now() at time zone 'utc')::date) as d7_eligible
from cohort c
group by c.signup_day
order by c.signup_day;


revoke all on public.admin_daily, public.admin_totals, public.admin_retention from public, anon, authenticated, service_role;
grant select on public.admin_daily, public.admin_totals, public.admin_retention to service_role;
