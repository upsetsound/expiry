-- Expiry multiplayer: accounts, positions, per-round settlements and one shared house pool.
-- Money is numeric (cents); prices, strikes, units and vol are double precision like the client.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  x_handle text,
  avatar_url text,
  balance numeric(14, 2) not null default 10000 check (balance >= 0),
  points integer not null default 0,
  last_top_up timestamptz not null default now(),
  last_buy_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset text not null check (asset in ('BTC', 'ETH')),
  side text not null check (side in ('call', 'put')),
  strike double precision not null check (strike > 0),
  tenor text not null check (tenor in ('1m', '5m', '15m', '1h')),
  expiry timestamptz not null,
  window_ms integer not null check (window_ms > 0), -- settlement averaging window, TENORS[tenor].window at buy time
  premium numeric(12, 2) not null check (premium > 0),
  units double precision not null check (units > 0),
  max_payout numeric(14, 2) not null check (max_payout >= 0),
  spot_at_buy double precision not null,
  sigma double precision not null,
  points_awarded integer not null default 0,
  status text not null default 'open' check (status in ('open', 'settled')),
  settle_price double precision,
  payout numeric(14, 2),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index positions_open_round on public.positions (asset, tenor, expiry) where status = 'open';
create index positions_open_expiry on public.positions (expiry) where status = 'open';
create index positions_user_recent on public.positions (user_id, created_at desc);
create index positions_user_round on public.positions (user_id, asset, expiry);
create index positions_settled_at on public.positions (settled_at) where status = 'settled';
create index positions_recent on public.positions (created_at desc);

-- One settlement price per round, written once. Every position in the round settles at this price.
create table public.settlements (
  asset text not null,
  tenor text not null,
  expiry timestamptz not null,
  price double precision not null check (price > 0),
  window_ms integer not null,
  source text not null, -- 'binance-1s' | 'coinbase-1m'
  coverage double precision,
  created_at timestamptz not null default now(),
  primary key (asset, tenor, expiry)
);

-- The single shared house pool.
create table public.pool (
  id boolean primary key default true check (id),
  balance numeric(16, 2) not null default 250000,
  premiums_in numeric(16, 2) not null default 0,
  paid_out numeric(16, 2) not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.pool (id) values (true);

-- Profiles come from the X login: handle and avatar are refreshed on every sign-in.
create function public.sync_profile_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  handle text := coalesce(meta ->> 'user_name', meta ->> 'preferred_username', meta ->> 'username', meta ->> 'name');
  avatar text := coalesce(meta ->> 'avatar_url', meta ->> 'picture');
begin
  insert into public.profiles (id, x_handle, avatar_url)
  values (new.id, handle, avatar)
  on conflict (id) do update
    set x_handle = coalesce(excluded.x_handle, public.profiles.x_handle),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.sync_profile_from_auth();
create trigger on_auth_user_meta_updated after update of raw_user_meta_data on auth.users
  for each row execute function public.sync_profile_from_auth();
