"use client";

import { useActionState, useState } from "react";
import { changePassword, deleteAccount, signOutOthers, signOutSession, type AccountState } from "@/app/actions/account";
import { Dialog, SubmitButton } from "@/components/client";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import type { Messages } from "@/i18n/messages/en";
import type { SessionInfo } from "@/lib/types";
import s from "./account.module.css";

type T = { account: Messages["account"]; common: Messages["common"] };

export function ChangePassword({ t }: { t: T }) {
  const [state, action] = useActionState<AccountState, FormData>(changePassword, {});
  return (
    <form action={action} className={s.form}>
      {state.error ? <Notice tone="error">{state.error}</Notice> : state.notice ? <Notice tone="success">{state.notice}</Notice> : null}
      <Field label={t.account.currentPassword} name="current" type="password" autoComplete="current-password" required />
      <Field label={t.account.newPassword} name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required />
      <div>
        <SubmitButton working={t.common.working}>{t.account.changePassword}</SubmitButton>
      </div>
    </form>
  );
}

export function SessionList({ sessions, t }: { sessions: (SessionInfo & { lastUsedLabel: string })[]; t: T }) {
  const [one, signOutOne] = useActionState<AccountState, FormData>(signOutSession, {});
  const [others, signOutRest] = useActionState<AccountState>(signOutOthers, {});
  const error = one.error ?? others.error;
  return (
    <div className={s.form}>
      {error ? <Notice tone="error">{error}</Notice> : others.notice ? <Notice tone="success">{others.notice}</Notice> : null}
      <ul className={s.sessions}>
        {sessions.map((x) => (
          <li key={x.id}>
            <div className={s.sessionMain}>
              <span className={ui.row}>
                <strong>{x.deviceName}</strong>
                {x.current && <Badge tone="accent">{t.account.thisSession}</Badge>}
              </span>
              <span className={ui.subtle}>{x.lastUsedLabel}</span>
            </div>
            {!x.current && (
              <form action={signOutOne}>
                <input type="hidden" name="id" value={x.id} />
                <SubmitButton working={t.common.working} variant="ghost" small>
                  {t.account.signOutSession}
                </SubmitButton>
              </form>
            )}
          </li>
        ))}
      </ul>
      {sessions.some((x) => !x.current) && (
        <form action={signOutRest}>
          <SubmitButton working={t.common.working} variant="secondary" small>
            {t.account.signOutOthers}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

export function DeleteAccount({ t }: { t: T }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<AccountState, FormData>(deleteAccount, {});
  return (
    <>
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          {t.account.delete}
        </Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={t.account.danger}>
        <form action={action} className={s.form}>
          <p className={ui.muted}>{t.account.dangerBody}</p>
          {state.error && <Notice tone="error">{state.error}</Notice>}
          <Field label={t.account.deleteConfirm} name="password" type="password" autoComplete="current-password" required autoFocus />
          <div className={s.buttons}>
            <Button onClick={() => setOpen(false)}>{t.common.cancel}</Button>
            <SubmitButton working={t.common.working} variant="danger">
              {t.account.delete}
            </SubmitButton>
          </div>
        </form>
      </Dialog>
    </>
  );
}
