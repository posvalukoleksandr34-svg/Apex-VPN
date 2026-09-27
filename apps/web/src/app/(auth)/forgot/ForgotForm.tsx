"use client";

import Link from "next/link";
import { useActionState } from "react";
import { forgot, resetPassword, type AuthState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/client";
import { Field, Notice } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import s from "../auth.module.css";

type T = { auth: Messages["auth"]; common: Messages["common"] };

export function ForgotForm({ t }: { t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(forgot, {});
  if (state.step === "reset") return <ResetForm initial={state} t={t} />;
  return (
    <form action={action} className={s.form}>
      <div className={s.heading}>
        <h1>{t.auth.forgot.title}</h1>
        <p>{t.auth.forgot.subtitle}</p>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <Field label={t.common.email} name="email" type="email" autoComplete="email" required defaultValue={state.email} autoFocus />
      <SubmitButton working={t.common.working} block>
        {t.auth.forgot.submit}
      </SubmitButton>
      <div className={s.after}>
        <span>
          {t.auth.forgot.remembered} <Link href="/login">{t.auth.login.submit}</Link>
        </span>
      </div>
    </form>
  );
}

function ResetForm({ initial, t }: { initial: AuthState; t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(resetPassword, initial);
  return (
    <form action={action} className={s.form}>
      <div className={s.heading}>
        <h1>{t.auth.forgot.codeTitle}</h1>
        <p>{fmt(t.auth.forgot.codeBody, { email: initial.email ?? "" })}</p>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <Field label={t.auth.forgot.code} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus code />
      <Field label={t.auth.forgot.newPassword} name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required hint={t.auth.register.passwordHint} />
      <SubmitButton working={t.common.working} block>
        {t.auth.forgot.reset}
      </SubmitButton>
    </form>
  );
}
