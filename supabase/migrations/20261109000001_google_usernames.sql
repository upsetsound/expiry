-- Sign in with Google. Google gives a real name, not a username, so Google players pick a username once
-- (shown without "@", so it cannot pass as an X account). Real names and Google photos are never stored.

alter table public.profiles add column username text
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,15}$');
create unique index profiles_username_lower on public.profiles (lower(username));
grant select (username) on public.profiles to anon, authenticated;

-- Handle and avatar come only from X sign-ins (X metadata has user_name). Google metadata (name, picture) is ignored,
-- including when a Google login is linked to an existing X account.
create or replace function public.sync_profile_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  handle text := coalesce(meta ->> 'user_name', meta ->> 'preferred_username');
  avatar text := case when handle is not null then coalesce(meta ->> 'avatar_url', meta ->> 'picture') end;
begin
  insert into public.profiles (id, x_handle, avatar_url)
  values (new.id, handle, avatar)
  on conflict (id) do update
    set x_handle = coalesce(excluded.x_handle, public.profiles.x_handle),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end $$;

-- Pick a username (players without an X handle, once). Case-insensitively unique against usernames and X handles.
create function public.set_username(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if v_name !~ '^[A-Za-z0-9_]{3,15}$' then return jsonb_build_object('ok', false, 'error', 'bad_format'); end if;
  select * into prof from public.profiles where id = uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if prof.x_handle is not null then return jsonb_build_object('ok', false, 'error', 'has_x'); end if;
  if prof.username is not null then return jsonb_build_object('ok', false, 'error', 'already_set'); end if;
  if lower(v_name) = any (array['expiry', 'expirytrade', 'admin', 'support', 'official', 'moderator', 'anon'])
     or exists (select 1 from public.profiles p where lower(p.x_handle) = lower(v_name) or lower(p.username) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  update public.profiles set username = v_name where id = uid;
  return jsonb_build_object('ok', true, 'username', v_name);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'taken');
end $$;
revoke execute on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated, service_role;

drop function public.my_account();
create function public.my_account()
returns table (id uuid, x_handle text, avatar_url text, balance numeric, points integer, last_top_up timestamptz, username text)
language sql stable security definer set search_path = '' as $$
  select id, x_handle, avatar_url, balance, points, last_top_up, username from public.profiles where id = auth.uid()
$$;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated, service_role;

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
  prize numeric,
  username text
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
           agg.user_id, pr.x_handle, pr.username, pr.avatar_url, agg.pnl, agg.trades, agg.wins,
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
         case when cfg.prizes_enabled and pl.place <= coalesce(array_length(cfg.prize_amounts, 1), 0) then cfg.prize_amounts[pl.place] end,
         pl.username
  from placed pl, cfg
  where pl.rank <= 50 or pl.is_me
  order by pl.rank, coalesce(pl.x_handle, pl.username)
$$;

revoke execute on function public.leaderboard(timestamptz) from public;
grant execute on function public.leaderboard(timestamptz) to anon, authenticated, service_role;
