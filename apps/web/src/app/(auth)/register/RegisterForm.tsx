"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { register, resendVerification, verifyAndSignIn, type AuthState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/client";
import { Field, Notice } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import s from "../auth.module.css";

type T = { auth: Messages["auth"]; common: Messages["common"] };

export function RegisterForm({ t }: { t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(register, {});
  // Kept only in this page's memory, to sign in right after the email is confirmed.
  const password = useRef("");
  if (state.step === "verify") return <VerifyForm email={state.email ?? ""} password={password.current} t={t} />;
  return (
    <form
      action={action}
      className={s.form}
      onSubmit={(e) => {
        password.current = new FormData(e.currentTarget).get("password")?.toString() ?? "";
      }}
    >
      <div className={s.heading}>
        <h1>{t.auth.register.title}</h1>
        <p>{t.auth.register.subtitle}</p>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <Field label={t.common.email} name="email" type="email" autoComplete="email" required defaultValue={state.email} autoFocus />
      <Field label={t.common.password} name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required hint={t.auth.register.passwordHint} />
      <SubmitButton working={t.common.working} block>
        {t.auth.register.submit}
      </SubmitButton>
      <p className={s.fine}>{t.auth.register.terms}</p>
      <div className={s.after}>
        <span>
          {t.auth.register.haveAccount} <Link href="/login">{t.auth.register.signIn}</Link>
        </span>
      </div>
    </form>
  );
}

function VerifyForm({ email, password, t }: { email: string; password: string; t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(verifyAndSignIn, { step: "verify", email });
  const [resent, resend] = useActionState<AuthState, FormData>(resendVerification, { email });
  const message = state.error ?? resent.error;
  return (
    <div className={s.form}>
      <form action={action} className={s.form}>
        <div className={s.heading}>
          <h1>{t.auth.verify.title}</h1>
          <p>{fmt(t.auth.verify.body, { email })}</p>
        </div>
        {message ? <Notice tone="error">{message}</Notice> : resent.notice ? <Notice tone="success">{resent.notice}</Notice> : null}
        <input type="hidden" name="password" value={password} />
        <Field label={t.auth.verify.code} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus code />
        <SubmitButton working={t.common.working} block>
          {t.auth.verify.submit}
        </SubmitButton>
      </form>
      <form action={resend} className={s.after}>
        <SubmitButton working={t.common.working} variant="ghost" small>
          {t.auth.verify.resend}
        </SubmitButton>
      </form>
    </div>
  );
}
