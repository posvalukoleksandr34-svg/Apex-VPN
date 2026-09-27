import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { currentUser } from "@/lib/dal";
import { VerifyEmail } from "./VerifyEmail";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.auth.verify.title };
}

/** Confirming the email address of an account that's already signed in. */
export default async function VerifyPage() {
  const [user, { m }] = await Promise.all([currentUser(), getI18n()]);
  if (user.emailVerified) redirect("/dashboard");
  return (
    <Card>
      <VerifyEmail email={user.email} t={{ auth: m.auth, common: m.common }} />
    </Card>
  );
}
