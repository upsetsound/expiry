import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { TAGLINE, siteUrl } from "@/lib/site";

const description = `${TAGLINE}. Pick your multiple, pay a premium, settle in a minute. Paper money.`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: "Expiry",
  description,
  icons: { icon: "/favicon.svg" },
  openGraph: { title: "Expiry", description, siteName: "Expiry", type: "website" },
  twitter: { card: "summary_large_image", title: "Expiry", description, ...(process.env.NEXT_PUBLIC_X_HANDLE ? { site: `@${process.env.NEXT_PUBLIC_X_HANDLE}` } : {}) },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Apply the saved theme before the first paint (no flash of the other theme).
          dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('expiry.theme')==='black')document.documentElement.dataset.theme='black'}catch(e){}" }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
