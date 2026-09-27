import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getI18n } from "@/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { m } = await getI18n();
  return {
    title: { default: m.meta.title, template: `%s · ${m.meta.title}` },
    description: m.meta.description,
    // The dashboard is behind sign-in: nothing here is for search engines.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0c11" },
    { media: "(prefers-color-scheme: light)", color: "#f5f6f9" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale } = await getI18n();
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
