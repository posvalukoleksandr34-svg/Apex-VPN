"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { login, loginMfa, type AuthState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/client";
import { Field, Notice, type Tone } from "@/components/ui";
import type { Messages } from "@/i18n/messages/en";
import s from "../auth.module.css";

type T = { auth: Messages["auth"]; common: Messages["common"] };

export function LoginForm({ next, email, notice, t }: { next: string; email: string; notice: { tone: Tone; text: string } | null; t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(login, { email });
  if (state.step === "mfa") return <MfaForm initial={state} next={next} t={t} />;
  return (
    <form action={action} className={s.form}>
      <div className={s.heading}>
        <h1>{t.auth.login.title}</h1>
        <p>{t.auth.login.subtitle}</p>
      </div>
      {state.error ? <Notice tone="error">{state.error}</Notice> : notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <input type="hidden" name="next" value={next} />
      <Field label={t.common.email} name="email" type="email" autoComplete="email" required defaultValue={state.email} autoFocus={!state.email} />
      <Field
        label={t.common.password}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        autoFocus={!!state.email}
        labelAction={<Link href="/forgot">{t.auth.login.forgot}</Link>}
      />
      <SubmitButton working={t.common.working} block>
        {t.auth.login.submit}
      </SubmitButton>
      <div className={s.after}>
        <span>
          {t.auth.login.noAccount} <Link href="/register">{t.auth.login.create}</Link>
        </span>
      </div>
    </form>
  );
}

function MfaForm({ initial, next, t }: { initial: AuthState; next: string; t: T }) {
  const [state, action] = useActionState<AuthState, FormData>(loginMfa, initial);
  const [recovery, setRecovery] = useState(false);
  if (state.step !== "mfa") {
    // The challenge expired: start over from the password.
    return (
      <div className={s.form}>
        <Notice tone="warning">{state.error}</Notice>
        <Link href={`/login?next=${encodeURIComponent(next)}`}>{t.common.back}</Link>
      </div>
    );
  }
  return (
    <form action={action} className={s.form}>
      <div className={s.heading}>
        <h1>{t.auth.mfa.title}</h1>
        <p>{t.auth.mfa.subtitle}</p>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <input type="hidden" name="next" value={next} />
      {recovery ? (
        <Field key="recovery" label={t.auth.mfa.recovery} name="recovery" autoComplete="off" required autoFocus />
      ) : (
        <Field key="code" label={t.auth.mfa.code} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus code />
      )}
      <SubmitButton working={t.common.working} block>
        {t.auth.mfa.submit}
      </SubmitButton>
      <div className={s.after}>
        <button type="button" className={s.linkButton} onClick={() => setRecovery(!recovery)}>
          {recovery ? t.auth.mfa.useCode : t.auth.mfa.useRecovery}
        </button>
      </div>
    </form>
  );
}
