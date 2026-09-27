"use client";

import { useActionState } from "react";
import { resendVerification, verifyAndSignIn, type AuthState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/client";
import { Field, Notice, ui } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";

export function VerifyEmail({ email, t }: { email: string; t: { auth: Messages["auth"]; common: Messages["common"] } }) {
  // Already signed in: the action confirms the address and returns to the overview.
  const [state, action] = useActionState<AuthState, FormData>(verifyAndSignIn, { step: "verify", email });
  const [resent, resend] = useActionState<AuthState, FormData>(resendVerification, { email });
  const message = state.error ?? resent.error;
  return (
    <div className={ui.stack}>
      <form action={action} className={ui.stack}>
        <h1>{t.auth.verify.title}</h1>
        <p className={ui.muted}>{fmt(t.auth.verify.body, { email })}</p>
        {message ? <Notice tone="error">{message}</Notice> : resent.notice ? <Notice tone="success">{resent.notice}</Notice> : null}
        <Field label={t.auth.verify.code} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus code />
        <div>
          <SubmitButton working={t.common.working}>{t.auth.verify.submit}</SubmitButton>
        </div>
      </form>
      <form action={resend}>
        <SubmitButton working={t.common.working} variant="ghost" small>
          {t.auth.verify.resend}
        </SubmitButton>
      </form>
    </div>
  );
}
