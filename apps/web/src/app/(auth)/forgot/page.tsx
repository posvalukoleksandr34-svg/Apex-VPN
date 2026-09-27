import type { Metadata } from "next";
import { getI18n } from "@/i18n/server";
import { ForgotForm } from "./ForgotForm";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.auth.forgot.title };
}

export default async function ForgotPage() {
  const { m } = await getI18n();
  return <ForgotForm t={{ auth: m.auth, common: m.common }} />;
}
