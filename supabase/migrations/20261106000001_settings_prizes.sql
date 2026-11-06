-- App settings (one row), editable in the Supabase table editor without a deploy. Prizes ship turned OFF.
create table public.settings (
  id boolean primary key default true check (id),
  prizes_enabled boolean not null default false,
  prize_amounts numeric[] not null default '{100,50,25}', -- USDC for 1st, 2nd, 3rd
  prize_min_trades integer not null default 20 check (prize_min_trades >= 0), -- settled trades in the week
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (true);

alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;
grant select on public.settings to anon, authenticated;
grant select, insert, update, delete on public.settings to service_role;
create policy "settings are public" on public.settings for select to anon, authenticated using (true);

-- Leaderboard v2: ties on P/L go to the trader with more trades; adds prize eligibility (at least
-- prize_min_trades settled trades this week) and prize_place (1..n among eligible traders, only while prizes are on).
drop function public.leaderboard(timestamptz);
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

revoke execute on function public.leaderboard(timestamptz) from public;
grant execute on function public.leaderboard(timestamptz) to anon, authenticated, service_role;
