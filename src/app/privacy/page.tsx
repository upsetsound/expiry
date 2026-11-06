// Privacy policy. Keep it in step with what the app actually stores (profiles, positions, card photos, auth).
import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_X, POLICY_DATE } from "@/lib/site";

export const metadata: Metadata = { title: "Privacy policy · Expiry" };

export default function Privacy() {
  const contact = (
    <a href={`https://x.com/${CONTACT_X}`} target="_blank" rel="noopener noreferrer">
      @{CONTACT_X} on X
    </a>
  );
  return (
    <main className="page rules legal">
      <p>
        <Link href="/" className="muted">
          ← Back to trading
        </Link>
      </p>
      <h1>Privacy policy</h1>
      <p className="lead">Last updated {POLICY_DATE}. Expiry is a free paper-trading game: no real money, no payments, no ads.</p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>From sign-in.</strong> What X sends when you sign in, kept with your login: your username, display name, profile picture link,
          account ID and email if X shares it.
        </li>
        <li>
          <strong>Your game activity.</strong> Your paper balance, points, trades (what you bought, when, and the result) and the username you picked.
        </li>
        <li>
          <strong>Photos you upload</strong> for share cards. They&apos;re re-encoded in your browser before upload, which removes location and camera
          data. We keep your 5 most recent.
        </li>
        <li>
          <strong>Basic usage stats</strong> through Vercel Analytics (pages visited, country, device type), without advertising cookies or
          cross-site tracking.
        </li>
      </ul>

      <h2>What&apos;s public</h2>
      <p>
        Your X username and profile picture, and your trades and results appear on the leaderboard, the live trades feed and
        share cards. Your email address and balance are never shown to other players.
      </p>

      <h2>How we use it</h2>
      <p>
        Only to run the game: sign you in, keep your account and trades, show the leaderboard and share cards, and fix problems. We don&apos;t sell
        your data, share it with advertisers or send marketing email.
      </p>

      <h2>Who processes it</h2>
      <p>
        Supabase (database, sign-in and photo storage) and Vercel (hosting and analytics) store data for us. X handles sign-in under its own privacy
        policy.
      </p>

      <h2>Cookies and storage</h2>
      <p>
        We use a sign-in cookie to keep you logged in, and your browser&apos;s local storage for settings like theme and sound. No advertising
        cookies.
      </p>

      <h2>Keeping and deleting your data</h2>
      <p>
        We keep your account until you ask us to delete it. To see or delete your data, message {contact}; we&apos;ll delete your account, trades
        and photos within 30 days.
      </p>

      <h2>Children</h2>
      <p>Expiry isn&apos;t meant for children under 13, and we don&apos;t knowingly collect data from them. If you think we have, contact us and we&apos;ll delete it.</p>

      <h2>Changes</h2>
      <p>If we change this policy, we&apos;ll update this page and the date at the top.</p>

      <p className="muted small">
        Questions: {contact}. See also the <Link href="/terms">terms of service</Link>.
      </p>
    </main>
  );
}
