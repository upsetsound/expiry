# Expiry — paper mode v0

BTC and ETH calls and puts that expire every hour (or daily at 08:00 UTC), priced live, paper money only.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

Deploy: push to GitHub and import the repo on Vercel (no environment variables needed).

## What's in v0.4

- Rounds: 1m, 5m, 15m, 1h expiries on the clock. Sales stop 15s / 30s / 1m / 10m before expiry; settlement averages the price over the final 5s / 15s / 30s / 5m.
- Live tick chart (canvas): 250ms median price as a step line that scrolls at a steady pace. Drag to pan, scroll or pinch to zoom time, drag or scroll the price bar to zoom prices (double-click it to auto-fit), double-click the chart or RESET to go back to live. Shows the selected strike, your positions, the expiry line, the settlement window and the ±1σ cone.
- Ticket: Call/Put, expiry, strike stepper (steps of about half an expected move from the current price), premium with ½× / 2× / Max, win chance, breakeven, max payout.
- Pricing: Black-Scholes × 1.10, vol = max(Deribit DVOL, 1.25 × 60-min realized, 35%). Caps: $250 per trade, $1,000 per expiry, 20× payout cap, pool liability limits.
- Live price = median of Coinbase, Binance, OKX and Hyperliquid websockets. `?demo` runs on simulated prices with its own separate paper account.
- State lives in the browser's localStorage.

## Not yet

- Accounts, a shared pool and the public leaderboard (Supabase).

Code: `src/lib/pricing.ts` (rules), `src/lib/feeds.ts` (prices, settlement), `src/lib/schedule.ts` (rounds), `src/app/Chart.tsx` (chart), `src/app/page.tsx` (app).
