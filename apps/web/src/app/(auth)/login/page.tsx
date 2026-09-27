import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getI18n } from "@/i18n/server";
import { currentSession } from "@/lib/dal";
import { safeNext } from "@/lib/paths";
import { LoginForm } from "./LoginForm";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.auth.login.title };
}

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const next = safeNext(one("next")) ?? "/dashboard";
  if (await currentSession()) redirect(next);
  const { m } = await getI18n();
  const notice = one("expired")
    ? { tone: "warning" as const, text: m.auth.login.expired }
    : one("reset")
      ? { tone: "success" as const, text: m.auth.login.resetDone }
      : one("deleted")
        ? { tone: "neutral" as const, text: m.auth.login.deleted }
        : one("signedOut")
          ? { tone: "neutral" as const, text: m.auth.login.signedOut }
          : one("verified")
            ? { tone: "success" as const, text: m.auth.login.verified }
            : null;
  return <LoginForm next={next} email={one("email") ?? ""} notice={notice} t={{ auth: m.auth, common: m.common }} />;
}
