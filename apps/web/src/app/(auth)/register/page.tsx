import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getI18n } from "@/i18n/server";
import { currentSession } from "@/lib/dal";
import { RegisterForm } from "./RegisterForm";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.auth.register.title };
}

export default async function RegisterPage() {
  if (await currentSession()) redirect("/dashboard");
  const { m } = await getI18n();
  return <RegisterForm t={{ auth: m.auth, common: m.common }} />;
}
