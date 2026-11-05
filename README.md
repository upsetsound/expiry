# Expiry — paper mode v0

BTC and ETH calls and puts that expire every hour (or daily at 08:00 UTC), priced live, paper money only.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

Deploy: push to GitHub and import the repo on Vercel (no environment variables needed).

## What's in v0

- In-house chart: live price line with 1-minute history, expected-move cone to expiry, settlement window, strike, breakeven and open positions; 15m / 1h / 4h ranges.
- Live price = median across Coinbase, Binance, OKX and Hyperliquid websockets (outliers >0.5% dropped).
- Pricing = Black-Scholes × 1.10 house edge, vol = max(Deribit DVOL, 1.25 × 60-min realized, 35%).
- Strike ladder = spot ± {0, 0.5, 1, 1.5, 2} expected moves, fixed per expiry when first shown.
- Caps: $250/position, $1,000/expiry, 20× payout cap, pool liability limits (30% per side, 60% total).
- Settlement = 5-minute average of the median price before expiry; falls back to Coinbase 1-minute candles if the tab was closed.
- $10,000 paper balance, simulated $250,000 house pool, 10 points per expiry traded (max 24/day).
- State lives in the browser's localStorage.

## Not yet

- Accounts, a shared pool and the leaderboard (needs a backend — Supabase is the plan).
- 15-minute expiries, macro-event pauses, exposure-based edge skew.

Rules source: the Expiry mechanism one-pager. Code: `src/lib/pricing.ts` (rules), `src/lib/feeds.ts` (prices, settlement), `src/lib/schedule.ts` (expiries), `src/app/page.tsx` (UI).
