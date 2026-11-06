# Expiry

BTC and ETH calls and puts that expire every minute, 5 minutes, 15 minutes or hour. Pick a payout multiple, pay a premium, and the round settles on the clock. Paper money, a shared house pool, a live tape of everyone's trades and a weekly leaderboard.

- **Live mode** (default): sign in with X; buys are priced and recorded on the server, rounds settle on the server, everyone trades against one pool.
- **Demo mode** (`/?demo`): local only, simulated prices, a separate paper account in the browser. No Supabase.

## How it works

| Piece | Where |
|---|---|
| Pricing rules (Black-Scholes × 1.10, vol, caps, win multiple) | `src/lib/pricing.ts` — shared by browser and server |
| Rounds, sales cutoff, settlement window | `src/lib/schedule.ts` |
| Live prices (median of Coinbase, Binance, OKX, Hyperliquid) | `src/lib/feeds.ts` (browser), `src/lib/server/market.ts` (server) |
| Buying | `POST /api/buy` → `buy_position()` in Postgres (row-locked caps, balance, 1 buy/s, points) |
| Settlement | `supabase/functions/settle` (Binance 1s average, Coinbase 1m fallback) → `settle_round()`; pg_cron runs it every 15s, `POST /api/settle` runs it early |
| Accounts, tape, leaderboard | `src/lib/liveAccount.ts` (Supabase + Realtime) |
| Prizes on/off, amounts, minimum trades | the `settings` row in Supabase (Table editor → `settings`) |
| Share pages and images | `/w/<positionId>`, `src/app/**/opengraph-image.tsx` |
| Stats | `/admin` (only `ADMIN_USER_ID`), views `admin_daily`, `admin_totals`, `admin_retention` |

## Run locally

```bash
npm install
cp .env.local.example .env.local   # fill it in (see below)
npm run dev                        # http://localhost:3000  ·  http://localhost:3000/?demo
```

Demo mode works without any env vars.

### Environment variables

| Variable | Where it comes from | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → Data API | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys (anon / publishable) | browser + server |
| `SUPABASE_SERVICE_ROLE_KEY` | same page (service_role / secret). **Server only.** | API routes, /admin |
| `SETTLE_SECRET` | any long random string: `openssl rand -hex 32`. Must match the edge function secret and the Vault secret below | `/api/settle` |
| `NEXT_PUBLIC_X_HANDLE` | your X handle without `@` (optional) | share text, Twitter card |
| `NEXT_PUBLIC_SITE_URL` | the public URL, e.g. `https://expiry.example` (optional; defaults to the Vercel URL) | share links, OG images |
| `ADMIN_USER_ID` | Supabase → Authentication → Users → your user's id | /admin |
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | your project ref and database password | Supabase CLI only |

## Supabase setup (once per project)

```bash
set -a; . ./.env.local; set +a
npx supabase link --project-ref "$SUPABASE_PROJECT_REF" -p "$SUPABASE_DB_PASSWORD"
npx supabase db push --remote -p "$SUPABASE_DB_PASSWORD"          # all migrations in supabase/migrations
npx supabase functions deploy settle --project-ref "$SUPABASE_PROJECT_REF"
printf 'SETTLE_SECRET=%s\n' "$SETTLE_SECRET" > /tmp/settle.env && npx supabase secrets set --env-file /tmp/settle.env && rm /tmp/settle.env
```

Then, in the Supabase SQL editor, give the 15-second cron job its target (replace both values):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/settle', 'settle_url');
select vault.create_secret('<SETTLE_SECRET>', 'settle_secret');
```

Check it: `select * from cron.job;` shows `settle-expired-rounds` every `15 seconds`, and
`select * from cron.job_run_details order by start_time desc limit 5;` shows successful runs.

**Sign in with X**

1. X developer console (console.x.com) → your app → User authentication settings: type *Web App*, callback `https://<project-ref>.supabase.co/auth/v1/callback`, website = your site URL. Copy the **OAuth 2.0 Client ID and Client Secret**.
2. Supabase → Authentication → Sign In / Providers → **X / Twitter (OAuth 2.0)**: enable, paste both, save.
3. Supabase → Authentication → URL Configuration: Site URL = your site; Redirect URLs include `<site>/auth/callback` (and `http://localhost:3000/auth/callback` for local dev).

## Deploy (Vercel)

1. Push to GitHub, then Vercel → Add New → Project → import the repo (framework: Next.js, defaults are fine).
2. Settings → Environment Variables (Production): every variable in the table above except the two CLI-only ones.
3. Deploy. Then add the production URL to Supabase Auth (Site URL + `<url>/auth/callback` in Redirect URLs) and to the X app (website; the callback stays the Supabase one).
4. Vercel → Analytics → Enable, for page views.
5. Every push to `main` deploys.

Settlement does not depend on Vercel: pg_cron inside Supabase calls the edge function every 15 seconds. Vercel only speeds it up through `/api/settle`.

## Prizes

Prizes ship **off**. To turn them on, edit the single row in the `settings` table: `prizes_enabled`, `prize_amounts` (1st, 2nd, 3rd in USDC), `prize_min_trades`. The banner, leaderboard tags and `/rules` update within a minute; no deploy needed.

## Tests

```bash
npx supabase start     # local Supabase in Docker — the database tests never touch a hosted project
npm test               # pricing, quotes, settlement rule, multiples, share text, database rules
```

The database tests (concurrent buys vs balances and pool caps, idempotent settlement, access rules, prizes) skip themselves when the local stack isn't running.
