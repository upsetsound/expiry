-- Stats for /admin. Readable only by the service role (the /admin page checks ADMIN_USER_ID server-side).
-- "Active" means placed at least one trade that UTC day.

-- One row per UTC day for the last 60 days.
create view public.admin_daily as
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
  (select count(*) from public.positions x where x.status = 'settled' and (x.settled_at at time zone 'utc')::date = d.day and x.payout > x.premium) as wins,
  (select count(*) from public.positions x where x.status = 'settled' and (x.settled_at at time zone 'utc')::date = d.day and x.payout <= x.premium) as losses,
  (select sp.opening
          + coalesce((select sum(x.premium) from public.positions x where (x.created_at at time zone 'utc')::date <= d.day), 0)
          - coalesce((select sum(x.payout) from public.positions x where x.status = 'settled' and (x.settled_at at time zone 'utc')::date <= d.day), 0)
   from start_pool sp) as pool_close
from days d
order by d.day;

create view public.admin_totals as
select
  (select count(*) from public.profiles) as signups,
  (select count(distinct user_id) from public.positions) as traders,
  (select count(*) from public.positions) as trades,
  (select coalesce(sum(premium), 0) from public.positions) as premium_volume,
  (select count(*) from public.positions where status = 'settled' and payout > premium) as wins,
  (select count(*) from public.positions where status = 'settled' and payout <= premium) as losses,
  (select balance from public.pool limit 1) as pool_balance;

-- Retention by signup day: of the people who signed up that day, how many traded again on day 1 / day 7.
-- d1_eligible / d7_eligible: the cohort is old enough for that day to have happened.
create view public.admin_retention as
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
