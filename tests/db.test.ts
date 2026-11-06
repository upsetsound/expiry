// Database rules, run against the LOCAL Supabase stack only (`npx supabase start`). Never point this at a hosted
// project: it truncates tables. Skipped when the local stack isn't running.
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { payout as payoutTs } from "@/lib/pricing";

type Local = { API_URL: string; DB_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
function localStack(): Local | null {
  try {
    const s = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as Local;
    return s.API_URL?.includes("127.0.0.1") && s.DB_URL?.includes("127.0.0.1") ? s : null;
  } catch {
    return null;
  }
}
const local = localStack();

describe.skipIf(!local)("database (local Supabase)", () => {
  let sql: pg.Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: string[] = [];

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await sql.query(text, params)).rows as T[];
  const futureExpiry = () => new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000).toISOString();
  const buy = (user: string, over: Record<string, unknown> = {}) =>
    admin.rpc("buy_position", {
      p_user: user,
      p_asset: "BTC",
      p_side: "call",
      p_strike: 76_000,
      p_tenor: "1m",
      p_expiry: over.p_expiry ?? futureExpiry(),
      p_window_ms: 5_000,
      p_premium: 10,
      p_units: 0.5,
      p_max_payout: 100,
      p_spot: 76_000,
      p_sigma: 0.4,
      ...over,
    });

  beforeAll(async () => {
    sql = new pg.Client({ connectionString: local!.DB_URL });
    await sql.connect();
    admin = createClient(local!.API_URL, local!.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    anon = createClient(local!.API_URL, local!.ANON_KEY, { auth: { persistSession: false } });
    await q("delete from auth.users where email like 'expiry-test-%'");
    for (let i = 0; i < 12; i++) {
      const { data, error } = await admin.auth.admin.createUser({
        email: `expiry-test-${i}@example.test`,
        email_confirm: true,
        user_metadata: { user_name: `tester${i}`, avatar_url: `https://example.test/${i}.png` },
      });
      if (error) throw error;
      users.push(data.user.id);
    }
  });

  afterAll(async () => {
    await q("delete from auth.users where email like 'expiry-test-%'");
    await q("truncate public.positions, public.settlements");
    await q("update public.pool set balance = 250000, premiums_in = 0, paid_out = 0");
    await sql?.end();
  });

  beforeEach(async () => {
    await q("truncate public.positions, public.settlements");
    await q("update public.pool set balance = 250000, premiums_in = 0, paid_out = 0");
    await q("update public.profiles set balance = 10000, points = 0, last_buy_at = null where id = any($1)", [users]);
    await q("update public.settings set max_premium_per_trade = 1000, max_premium_per_round = 5000, payout_cap = 100");
  });

  it("creates a profile with the X handle and avatar on sign-up", async () => {
    const [p] = await q("select x_handle, avatar_url, balance from public.profiles where id = $1", [users[0]]);
    expect(p).toEqual({ x_handle: "tester0", avatar_url: "https://example.test/0.png", balance: "10000.00" });
  });

  describe("access rules", () => {
    it("lets anyone read positions, the pool and public profile fields", async () => {
      expect((await anon.from("positions").select("id, premium").limit(1)).error).toBeNull();
      expect((await anon.from("pool").select("balance").single()).data?.balance).toBe(250000);
      expect((await anon.from("profiles").select("x_handle, avatar_url, points").limit(1)).error).toBeNull();
    });
    it("hides other people's balances", async () => {
      expect((await anon.from("profiles").select("balance").limit(1)).error?.code).toBe("42501");
    });
    it("blocks all client writes and server-only functions", async () => {
      expect((await anon.from("positions").insert({ user_id: users[0] })).error).not.toBeNull();
      expect((await anon.from("pool").update({ balance: 1 }).eq("id", true)).error).not.toBeNull();
      expect((await anon.from("profiles").update({ points: 1e6 }).eq("id", users[0])).error).not.toBeNull();
      expect((await anon.rpc("buy_position", { p_user: users[0] })).error).not.toBeNull();
      expect((await anon.rpc("topup", { p_user: users[0] })).error).not.toBeNull();
      expect((await anon.rpc("settle_round", { p_asset: "BTC" })).error).not.toBeNull();
      expect((await anon.rpc("due_rounds")).error).not.toBeNull();
      const [pool] = await q<{ balance: string }>("select balance from public.pool");
      expect(pool.balance).toBe("250000.00");
    });
    it("serves the leaderboard and stats to anyone", async () => {
      expect((await anon.rpc("leaderboard")).error).toBeNull();
      expect((await anon.rpc("asset_stats", { p_asset: "BTC" })).error).toBeNull();
    });
  });

  describe("buying", () => {
    it("debits the buyer, credits the pool and awards points once per expiry", async () => {
      const exp = futureExpiry();
      const a = await buy(users[0], { p_expiry: exp, p_premium: 25 });
      expect(a.data).toMatchObject({ ok: true, balance: 9975, points_awarded: 10 });
      await q("update public.profiles set last_buy_at = null where id = $1", [users[0]]);
      const b = await buy(users[0], { p_expiry: exp, p_premium: 25 });
      expect(b.data).toMatchObject({ ok: true, balance: 9950, points_awarded: 0 });
      const [pool] = await q("select balance, premiums_in from public.pool");
      expect(pool).toEqual({ balance: "250050.00", premiums_in: "50.00" });
    });

    it("limits a user to one buy per second, even when 10 arrive at once", async () => {
      const res = await Promise.all(Array.from({ length: 10 }, () => buy(users[1])));
      expect(res.filter((r) => r.data?.ok).length).toBe(1);
      expect(res.filter((r) => r.data?.error === "rate_limited").length).toBe(9);
      const [p] = await q("select balance from public.profiles where id = $1", [users[1]]);
      expect(p.balance).toBe("9990.00");
    });

    it("can't overdraw a balance", async () => {
      await q("update public.profiles set balance = 300 where id = $1", [users[2]]);
      expect((await buy(users[2], { p_premium: 250 })).data?.ok).toBe(true);
      await q("update public.profiles set last_buy_at = null where id = $1", [users[2]]);
      expect((await buy(users[2], { p_premium: 250 })).data?.error).toBe("balance");
      const [p] = await q("select balance from public.profiles where id = $1", [users[2]]);
      expect(p.balance).toBe("50.00");
    });

    it("caps premium at the settings limit per user per round ($5,000)", async () => {
      const exp = futureExpiry();
      for (let i = 0; i < 5; i++) {
        await q("update public.profiles set last_buy_at = null where id = $1", [users[3]]);
        expect((await buy(users[3], { p_expiry: exp, p_premium: 1000, p_max_payout: 1 })).data?.ok).toBe(true);
      }
      await q("update public.profiles set last_buy_at = null where id = $1", [users[3]]);
      expect((await buy(users[3], { p_expiry: exp, p_premium: 1 })).data).toMatchObject({ error: "max_per_expiry", limit: 5000 });
    });

    it("enforces the per-trade limit from settings, whatever the caller sends", async () => {
      expect((await buy(users[4], { p_premium: 1000.01 })).data).toMatchObject({ error: "max_per_trade", limit: 1000 });
      await q("update public.settings set max_premium_per_trade = 50");
      expect((await buy(users[4], { p_premium: 60 })).data).toMatchObject({ error: "max_per_trade", limit: 50 });
      expect((await buy(users[4], { p_premium: 50 })).data?.ok).toBe(true);
    });

    it("stores the payout cap from settings on each position and caps max payout with it", async () => {
      const r = await buy(users[5], { p_premium: 10, p_max_payout: 5000 });
      expect(r.data?.position).toMatchObject({ payout_cap: 100, max_payout: 1000 });
      await q("update public.settings set payout_cap = 30");
      await q("update public.profiles set last_buy_at = null where id = $1", [users[5]]);
      expect((await buy(users[5], { p_premium: 10, p_max_payout: 5000 })).data?.position).toMatchObject({ payout_cap: 30, max_payout: 300 });
    });

    it("holds the 30% per-side pool limit under 10 concurrent buyers", async () => {
      await q("update public.pool set balance = 1000");
      const exp = futureExpiry();
      const res = await Promise.all(users.slice(0, 10).map((u) => buy(u, { p_expiry: exp, p_premium: 10, p_max_payout: 100 })));
      const ok = res.filter((r) => r.data?.ok).length;
      expect(ok).toBe(3); // liability 100, 200, 300 fit under 30% of 1010 / 1020; a 4th (400 > 306) doesn't
      expect(res.filter((r) => r.data?.error === "pool_limit").length).toBe(7);
      const [{ liab, balance }] = await q<{ liab: string; balance: string }>(
        "select (select sum(max_payout) from public.positions where status = 'open') liab, (select balance from public.pool) balance",
      );
      expect(Number(liab)).toBeLessThanOrEqual(0.3 * Number(balance));
    });

    it("holds the 60% total pool limit across sides and assets under concurrency", async () => {
      await q("update public.pool set balance = 1000");
      const exp = futureExpiry();
      const combos = [
        ["BTC", "call"],
        ["BTC", "put"],
        ["ETH", "call"],
        ["ETH", "put"],
      ];
      const res = await Promise.all(
        users.slice(0, 12).map((u, i) => buy(u, { p_expiry: exp, p_asset: combos[i % 4][0], p_side: combos[i % 4][1], p_premium: 10, p_max_payout: 150 })),
      );
      const [{ liab, balance }] = await q<{ liab: string; balance: string }>(
        "select (select sum(max_payout) from public.positions where status = 'open') liab, (select balance from public.pool) balance",
      );
      expect(Number(liab)).toBeLessThanOrEqual(0.6 * Number(balance));
      expect(res.filter((r) => r.data?.ok).length).toBe(4);
    });
  });

  describe("settlement", () => {
    const pastExpiry = new Date(Math.floor((Date.now() - 120_000) / 60_000) * 60_000).toISOString();
    async function seedRound() {
      // 3 positions in one expired round: a winning call, a losing call, a capped winner. Bought directly by SQL
      // because buy_position (correctly) won't sell a round that has already expired.
      await q(
        `insert into public.positions (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma)
         values ($1,'BTC','call',75900,'1m',$4,5000,10,0.5,100,76000,0.4),
                ($2,'BTC','call',76200,'1m',$4,5000,10,0.5,100,76000,0.4),
                ($3,'BTC','put',77000,'1m',$4,5000,1,1,20,76000,0.4)`,
        [users[4], users[5], users[6], pastExpiry],
      );
    }
    const settle = (price: number) =>
      admin.rpc("settle_round", { p_asset: "BTC", p_tenor: "1m", p_expiry: pastExpiry, p_price: price, p_window_ms: 5000, p_source: "test" });

    it("pays each round once, even when settled twice at the same time and again later", async () => {
      await seedRound();
      const [first, second] = await Promise.all([settle(76_000), settle(80_000)]);
      const third = await settle(70_000);
      const paidRuns = [first, second, third].map((r) => r.data?.settled);
      expect(paidRuns.filter((n) => n === 3).length).toBe(1);
      expect(paidRuns.filter((n) => n === 0).length).toBe(2);

      const settlements = await q("select price from public.settlements");
      expect(settlements.length).toBe(1);
      const price = Number(settlements[0].price);
      expect([76_000, 80_000]).toContain(price);

      const rows = await q<{ user_id: string; payout: string; settle_price: number; side: "call" | "put"; strike: number; units: number; premium: string }>(
        "select user_id, payout, settle_price, side, strike, units, premium from public.positions",
      );
      let total = 0;
      for (const r of rows) {
        expect(r.settle_price).toBe(price);
        const expected = Math.round(payoutTs(r.side, price, r.strike, r.units, Number(r.premium)) * 100) / 100;
        expect(Number(r.payout)).toBeCloseTo(expected, 2);
        total += expected;
        const [p] = await q("select balance from public.profiles where id = $1", [r.user_id]);
        expect(Number(p.balance)).toBeCloseTo(10_000 + expected, 2);
      }
      const [pool] = await q("select balance, paid_out from public.pool");
      expect(Number(pool.paid_out)).toBeCloseTo(total, 2);
      expect(Number(pool.balance)).toBeCloseTo(250_000 - total, 2);
    });

    it("lists due rounds and stops listing them once settled", async () => {
      await seedRound();
      const before = await admin.rpc("due_rounds");
      expect(before.data?.length).toBe(1);
      await settle(76_000);
      expect((await admin.rpc("due_rounds")).data?.length).toBe(0);
    });

    it("refuses to settle a round before its expiry", async () => {
      const r = await admin.rpc("settle_round", {
        p_asset: "BTC",
        p_tenor: "1m",
        p_expiry: futureExpiry(),
        p_price: 1,
        p_window_ms: 5000,
        p_source: "test",
      });
      expect(r.data?.error).toBe("not_expired");
    });

    it("computes payouts in SQL exactly like pricing.ts", async () => {
      const cases: [string, number, number, number, number, number][] = [
        ["call", 76_100, 76_000, 0.37, 12.5, 100],
        ["call", 75_000, 76_000, 2, 50, 100],
        ["put", 75_500, 76_000, 0.2, 3, 100],
        ["put", 70_000, 76_000, 1, 10, 100],
        ["put", 70_000, 76_000, 1, 10, 20],
        ["call", 3_500.5, 3_400, 0.123456, 7.77, 100],
        ["call", 90_000, 76_000, 2, 10, 100],
      ];
      for (const [side, settleP, strike, units, premium, cap] of cases) {
        const [r] = await q<{ v: string }>("select public.position_payout($1, $2, $3, $4, $5, $6) v", [side, settleP, strike, units, premium, cap]);
        expect(Number(r.v)).toBeCloseTo(Math.round(payoutTs(side as "call" | "put", settleP, strike, units, premium, cap) * 100) / 100, 2);
      }
    });

    it("settles a 100x position in the money at no more than 100x premium, and old positions at their own cap", async () => {
      const exp = new Date(Math.floor((Date.now() - 120_000) / 60_000) * 60_000).toISOString();
      // Deep in the money: intrinsic x units would pay far more than either cap.
      await q(
        `insert into public.positions (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, payout_cap)
         values ($1,'BTC','call',76000,'1m',$3,5000,10,1,1000,76000,0.4,100),
                ($2,'BTC','call',76000,'1m',$3,5000,10,1,200,76000,0.4,20)`,
        [users[6], users[7], exp],
      );
      await admin.rpc("settle_round", { p_asset: "BTC", p_tenor: "1m", p_expiry: exp, p_price: 90_000, p_window_ms: 5000, p_source: "test" });
      const rows = await q<{ user_id: string; payout: string }>("select user_id, payout from public.positions order by payout_cap desc");
      expect(rows.map((r) => Number(r.payout))).toEqual([1000, 200]);
      const [me] = await q<{ balance: string }>("select balance from public.profiles where id = $1", [users[6]]);
      expect(Number(me.balance)).toBe(11000);
    });
  });

  describe("closing early", () => {
    it("closes once, credits the seller from the pool, and never also settles", async () => {
      const r = await buy(users[8], { p_premium: 20, p_expiry: futureExpiry(), p_window_ms: 5000 });
      const id = r.data.position.id;
      const close = () => admin.rpc("close_position", { p_user: users[8], p_position: id, p_price: 76_000, p_proceeds: 15.5 });
      const [a, b] = await Promise.all([close(), close()]); // concurrent double close
      expect([a.data?.ok, b.data?.ok].filter(Boolean).length).toBe(1);
      expect([a.data?.error, b.data?.error]).toContain("not_open");
      const [p] = await q<{ balance: string }>("select balance from public.profiles where id = $1", [users[8]]);
      expect(Number(p.balance)).toBeCloseTo(10_000 - 20 + 15.5, 2);
      const [pool] = await q<{ balance: string; paid_out: string }>("select balance, paid_out from public.pool");
      expect(Number(pool.balance)).toBeCloseTo(250_000 + 20 - 15.5, 2);
      expect(Number(pool.paid_out)).toBeCloseTo(15.5, 2);
      // Force it past expiry and settle the round: the closed position is skipped.
      await q("update public.positions set expiry = now() - interval '2 minutes' where id = $1", [id]);
      const [row] = await q<{ expiry: Date; tenor: string }>("select expiry, tenor from public.positions where id = $1", [id]);
      const st = await admin.rpc("settle_round", { p_asset: "BTC", p_tenor: row.tenor, p_expiry: row.expiry.toISOString(), p_price: 90_000, p_window_ms: 5000, p_source: "test" });
      expect(st.data?.settled).toBe(0);
      const [after] = await q<{ status: string; payout: string | null }>("select status, payout from public.positions where id = $1", [id]);
      expect(after).toEqual({ status: "closed", payout: null });
    });

    it("refuses someone else's position, a settled one, and closes inside the settlement window", async () => {
      const r = await buy(users[9], { p_premium: 10, p_expiry: futureExpiry(), p_window_ms: 5000 });
      const id = r.data.position.id;
      expect((await admin.rpc("close_position", { p_user: users[8], p_position: id, p_price: 1, p_proceeds: 1 })).data?.error).toBe("not_found");
      await q("update public.positions set expiry = now() + interval '3 seconds' where id = $1", [id]);
      expect((await admin.rpc("close_position", { p_user: users[9], p_position: id, p_price: 1, p_proceeds: 1 })).data?.error).toBe("settling");
      await q("update public.positions set status = 'settled', payout = 0 where id = $1", [id]);
      expect((await admin.rpc("close_position", { p_user: users[9], p_position: id, p_price: 1, p_proceeds: 1 })).data?.error).toBe("not_open");
      expect((await anon.rpc("close_position", { p_user: users[9], p_position: id, p_price: 1, p_proceeds: 1 })).error).not.toBeNull();
    });
  });

  describe("leaderboard and top-up", () => {
    it("ranks this week's realized P/L", async () => {
      await q(
        `insert into public.positions (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, status, settle_price, payout, settled_at, points_awarded)
         values ($1,'BTC','call',76000,'1m',now(),5000,10,1,200,76000,0.4,'settled',76100,100,now(),10),
                ($2,'BTC','put',76000,'1m',now(),5000,10,1,200,76000,0.4,'settled',76100,0,now(),10),
                ($2,'BTC','put',76000,'1m',now(),5000,20,1,200,76000,0.4,'settled',75990,25,now(),0)`,
        [users[7], users[8]],
      );
      const { data } = await anon.rpc("leaderboard");
      expect(data?.map((r: { x_handle: string }) => r.x_handle)).toEqual(["tester7", "tester8"]);
      expect(data?.[0]).toMatchObject({ rank: 1, pnl: 90, trades: 1, wins: 1, best_multiple: 10, points: 10 });
      expect(data?.[1]).toMatchObject({ rank: 2, pnl: -5, trades: 2, wins: 1, win_rate: 0.5 });
    });

    it("breaks P/L ties by trade count and flags prize eligibility", async () => {
      // tester7: +20 over 1 trade. tester8: +20 over 3 trades (ranks first on the tie). tester9: +5 over 2 trades.
      const ins = (u: string, premium: number, payout: number) =>
        q(
          `insert into public.positions (user_id, asset, side, strike, tenor, expiry, window_ms, premium, units, max_payout, spot_at_buy, sigma, status, settle_price, payout, settled_at)
           values ($1,'BTC','call',76000,'1m',now(),5000,$2,1,200,76000,0.4,'settled',76100,$3,now())`,
          [u, premium, payout],
        );
      await ins(users[7], 10, 30);
      await ins(users[8], 10, 20);
      await ins(users[8], 10, 20);
      await ins(users[8], 10, 10);
      await ins(users[9], 10, 15);
      await ins(users[9], 10, 10);
      await q("update public.settings set prizes_enabled = false, prize_min_trades = 2, prize_amounts = '{100,50,25}'");
      let { data } = await anon.rpc("leaderboard");
      expect(data.map((r: { x_handle: string; rank: number }) => `${r.rank}:${r.x_handle}`)).toEqual(["1:tester8", "2:tester7", "3:tester9"]);
      expect(data.map((r: { eligible: boolean }) => r.eligible)).toEqual([true, false, true]);
      expect(data.every((r: { prize: number | null }) => r.prize === null)).toBe(true); // prizes off

      await q("update public.settings set prizes_enabled = true");
      ({ data } = await anon.rpc("leaderboard"));
      // Places go to eligible traders in rank order: tester8 1st, tester9 2nd; tester7 is ranked but not eligible.
      expect(data.map((r: { x_handle: string; prize_place: number | null; prize: number | null }) => [r.x_handle, r.prize_place, r.prize])).toEqual([
        ["tester8", 1, 100],
        ["tester7", null, null],
        ["tester9", 2, 50],
      ]);
      await q("update public.settings set prizes_enabled = false, prize_min_trades = 20");
    });

    it("lets anyone read settings but nobody write them from the client", async () => {
      expect((await anon.from("settings").select("prizes_enabled").single()).data?.prizes_enabled).toBe(false);
      expect((await anon.from("settings").update({ prizes_enabled: true }).eq("id", true)).error).not.toBeNull();
      const [row] = await q<{ prizes_enabled: boolean }>("select prizes_enabled from public.settings");
      expect(row.prizes_enabled).toBe(false);
    });

    it("tops up only below $1,000 and once a week", async () => {
      await q("update public.profiles set balance = 500, last_top_up = now() - interval '8 days' where id = $1", [users[9]]);
      expect((await admin.rpc("topup", { p_user: users[9] })).data).toMatchObject({ ok: true, balance: 10500 });
      await q("update public.profiles set balance = 500 where id = $1", [users[9]]);
      expect((await admin.rpc("topup", { p_user: users[9] })).data?.error).toBe("too_soon");
      await q("update public.profiles set balance = 5000, last_top_up = now() - interval '8 days' where id = $1", [users[9]]);
      expect((await admin.rpc("topup", { p_user: users[9] })).data?.error).toBe("balance_too_high");
    });
  });
});
