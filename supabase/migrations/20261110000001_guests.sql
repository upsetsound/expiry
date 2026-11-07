-- Guest trading: visitors get an anonymous Supabase account on first visit (same $10,000 balance and server-side
-- trading as everyone), and "Save with X" links their X identity to the same user id. Guests stay out of everything
-- public: the leaderboard, other people's view of trades (live feed) and share cards.

alter table public.profiles add column is_guest boolean not null default false;

-- Funnel events, written only by triggers (clients can't read or write). user_id has no foreign key so events
-- outlive deleted guests.
create table public.events (
  id bigserial primary key,
  name text not null,
  user_id uuid,
  created_at timestamptz not null default now()
);
create index events_name_created on public.events (name, created_at);
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;
grant select, insert, delete on public.events to service_role;
grant usage on sequence public.events_id_seq to service_role;

-- Profiles: X handle/avatar from X metadata (as before), plus the guest flag. Logs guest_created and guest_linked_x.
create or replace function public.sync_profile_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  handle text := coalesce(meta ->> 'user_name', meta ->> 'preferred_username', meta ->> 'username', meta ->> 'name');
  avatar text := coalesce(meta ->> 'avatar_url', meta ->> 'picture');
  guest boolean := coalesce(new.is_anonymous, false);
begin
  insert into public.profiles (id, x_handle, avatar_url, is_guest)
  values (new.id, handle, avatar, guest)
  on conflict (id) do update
    set x_handle = coalesce(excluded.x_handle, public.profiles.x_handle),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        is_guest = excluded.is_guest;
  if tg_op = 'INSERT' and guest then
    insert into public.events (name, user_id) values ('guest_created', new.id);
  elsif tg_op = 'UPDATE' and coalesce(old.is_anonymous, false) and not guest then
    insert into public.events (name, user_id) values ('guest_linked_x', new.id);
  end if;
  return new;
end $$;

drop trigger on_auth_user_meta_updated on auth.users;
create trigger on_auth_user_meta_updated after update of raw_user_meta_data, is_anonymous on auth.users
  for each row execute function public.sync_profile_from_auth();

-- When an X identity is linked to a guest, take the handle and avatar from it (whether or not the user's metadata
-- is updated by the link).
create function public.sync_profile_from_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider in ('x', 'twitter') then
    update public.profiles
      set x_handle = coalesce(new.identity_data ->> 'user_name', new.identity_data ->> 'preferred_username', x_handle),
          avatar_url = coalesce(new.identity_data ->> 'avatar_url', new.identity_data ->> 'picture', avatar_url)
      where id = new.user_id;
  end if;
  return new;
end $$;
create trigger on_auth_identity_created after insert on auth.identities
  for each row execute function public.sync_profile_from_identity();

-- guest_first_trade
create function public.log_guest_first_trade() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select is_guest from public.profiles where id = new.user_id)
     and not exists (select 1 from public.positions where user_id = new.user_id and id <> new.id) then
    insert into public.events (name, user_id) values ('guest_first_trade', new.user_id);
  end if;
  return new;
end $$;
create trigger on_position_created_log after insert on public.positions
  for each row execute function public.log_guest_first_trade();

-- Trades are public, except guests' (each guest still sees their own). Realtime follows the same policy.
create function public.is_guest(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_guest from public.profiles where id = p_user), false)
$$;
revoke execute on function public.is_guest(uuid) from public;
grant execute on function public.is_guest(uuid) to anon, authenticated, service_role;
drop policy "positions are public" on public.positions;
create policy "positions are public except guests" on public.positions for select to anon, authenticated
  using (user_id = (select auth.uid()) or not public.is_guest(user_id));

drop function public.my_account();
create function public.my_account()
returns table (id uuid, x_handle text, avatar_url text, balance numeric, points integer, last_top_up timestamptz, is_guest boolean)
language sql stable security definer set search_path = '' as $$
  select id, x_handle, avatar_url, balance, points, last_top_up, is_guest from public.profiles where id = auth.uid()
$$;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated, service_role;

-- Delete idle guests (their profile and trades cascade): no trades and older than a day, or no activity for 30
-- days. Never while they have an open trade.
create function public.cleanup_guests() returns integer
language sql security definer set search_path = '' as $$
  with gone as (
    delete from auth.users u
    where u.is_anonymous
      and not exists (select 1 from public.positions p where p.user_id = u.id and p.status = 'open')
      and (
        (not exists (select 1 from public.positions p where p.user_id = u.id) and u.created_at < now() - interval '1 day')
        or greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at),
                    coalesce((select max(p.created_at) from public.positions p where p.user_id = u.id), u.created_at))
           < now() - interval '30 days'
      )
    returning 1
  )
  select count(*)::integer from gone
$$;
revoke execute on function public.cleanup_guests() from public, anon, authenticated;
grant execute on function public.cleanup_guests() to service_role;
select cron.schedule('cleanup-guests', '17 4 * * *', 'select public.cleanup_guests()');

-- Leaderboard without guests.
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
    where not pr.is_guest
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
