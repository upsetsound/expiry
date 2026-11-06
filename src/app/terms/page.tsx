// Terms of service.
import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_X, POLICY_DATE } from "@/lib/site";

export const metadata: Metadata = { title: "Terms of service · Expiry" };

export default function Terms() {
  return (
    <main className="page rules legal">
      <p>
        <Link href="/" className="muted">
          ← Back to trading
        </Link>
      </p>
      <h1>Terms of service</h1>
      <p className="lead">Last updated {POLICY_DATE}. By using Expiry you agree to these terms.</p>

      <h2>A game, not a financial service</h2>
      <p>
        Expiry is a free game that simulates options on Bitcoin and Ether with paper money. Balances, points and winnings have no cash value and
        can&apos;t be deposited, withdrawn or exchanged. Nothing on Expiry is financial advice or an offer to buy or sell anything. Prices come from
        public market data and may be delayed or wrong.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be at least 13 years old to use Expiry.</li>
        <li>One account per person. Keep your sign-in secure; you&apos;re responsible for activity on your account.</li>
        <li>Pick a username that isn&apos;t offensive and doesn&apos;t pretend to be someone else. We may change or remove usernames that break this.</li>
      </ul>

      <h2>Fair play</h2>
      <p>
        Don&apos;t use bots or automation, multiple accounts, or bugs to get an advantage, and don&apos;t try to break or overload the service. We may
        reset balances, remove trades or suspend accounts that do, and reset the game for everyone when needed.
      </p>

      <h2>What you share</h2>
      <p>
        You&apos;re responsible for photos you upload and posts you share. Only upload images you have the right to use, and nothing illegal,
        hateful or explicit. You let us store and show them on your share cards; we may remove anything that breaks these terms.
      </p>

      <h2>Prizes</h2>
      <p>
        If weekly prizes are running, they follow the <Link href="/rules">prize rules</Link>, which take priority over these terms for prizes.
      </p>

      <h2>No guarantees</h2>
      <p>
        Expiry is provided &quot;as is&quot;. It may have bugs, go down, or change or end at any time, and game data may be lost or reset. To the
        extent the law allows, we aren&apos;t liable for any loss from using Expiry, including decisions you make with real money based on it.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms; the date at the top shows the latest version. Using Expiry after a change means you accept it.</p>

      <p className="muted small">
        Questions: <a href={`https://x.com/${CONTACT_X}`} target="_blank" rel="noopener noreferrer">@{CONTACT_X} on X</a>. See also the{" "}
        <Link href="/privacy">privacy policy</Link>.
      </p>
    </main>
  );
}
