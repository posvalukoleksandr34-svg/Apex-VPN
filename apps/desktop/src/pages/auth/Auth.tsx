import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ensureEnrolled, refreshSubscription } from "@/app/actions";
import { transport } from "@/app/transportRef";
import { Banner, Button, PasswordField, TextField } from "@/design";
import { apiErrorMessage } from "@/lib/errors";
import { Logo } from "@/shell/Logo";
import { useApp } from "@/state/store";
import s from "./Auth.module.css";

type Mode = "signin" | "register" | "verify" | "forgot" | "reset" | "mfa";

export default function Auth() {
  const { mode = "signin" } = useParams<{ mode: Mode }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (m: Mode) => {
    setError(null);
    setInfo(null);
    setCode("");
    navigate(`/auth/${m}`, { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(apiErrorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const finishSignIn = async () => {
    setInfo(t("auth.registering"));
    await refreshSubscription();
    await ensureEnrolled().catch(() => {});
    useApp.getState().setPrefs({ onboardingDone: true });
    navigate("/", { replace: true });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const account = transport().account;
    switch (mode) {
      case "signin":
        return run(async () => {
          const r = await account.login(email.trim(), password);
          if (r.kind === "mfa_required") return go("mfa");
          if (!r.user.emailVerified) {
            await account.resendVerification(email.trim());
            return go("verify");
          }
          await finishSignIn();
        });
      case "mfa":
        return run(async () => {
          await account.loginMfa(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
          await finishSignIn();
        });
      case "register":
        return run(async () => {
          await account.register(email.trim(), password, i18n.language.slice(0, 2));
          go("verify");
        });
      case "verify":
        return run(async () => {
          await account.verifyEmail(email.trim(), code.trim());
          // Sign in with the password from registration, if we still have it.
          if (password) {
            const r = await account.login(email.trim(), password);
            if (r.kind === "mfa_required") return go("mfa");
            await finishSignIn();
          } else {
            go("signin");
          }
        });
      case "forgot":
        return run(async () => {
          await account.forgotPassword(email.trim());
          go("reset");
        });
      case "reset":
        return run(async () => {
          await account.resetPassword(email.trim(), code.trim(), password);
          setPassword("");
          go("signin");
          setInfo(t("auth.resetDone"));
        });
    }
  };

  const titles: Record<Mode, [string, string]> = {
    signin: [t("auth.signInTitle"), t("auth.signInSubtitle")],
    register: [t("auth.registerTitle"), t("auth.registerSubtitle")],
    verify: [t("auth.verifyTitle"), t("auth.verifyBody", { email })],
    forgot: [t("auth.forgotTitle"), t("auth.forgotBody")],
    reset: [t("auth.resetTitle"), t("auth.resetBody")],
    mfa: [t("auth.mfaTitle"), t("auth.mfaBody")],
  };
  const [title, subtitle] = titles[mode];
  const needsEmail = mode !== "mfa";
  const needsPassword = mode === "signin" || mode === "register" || mode === "reset";
  const needsCode = mode === "verify" || mode === "reset" || mode === "mfa";
  const submitLabel = {
    signin: t("auth.signIn"),
    register: t("auth.register"),
    verify: t("auth.verify"),
    forgot: t("auth.sendCode"),
    reset: t("actions.save"),
    mfa: t("auth.signIn"),
  }[mode];

  return (
    <div className={s.screen}>
      <main className={s.panel}>
        <div className={s.brand}>
          <Logo size={28} />
          {t("app.name")}
        </div>
        <h1 className={s.title}>{title}</h1>
        <p className={s.subtitle}>{subtitle}</p>
        <form className={s.form} onSubmit={submit} noValidate>
          {info ? <Banner tone="accent">{info}</Banner> : null}
          {error ? <Banner tone="error">{error}</Banner> : null}
          {needsEmail && mode !== "verify" ? (
            <TextField label={t("auth.email")} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          ) : null}
          {needsCode ? (
            <TextField
              label={mode === "mfa" && useRecovery ? t("auth.recoveryCode") : t("auth.code")}
              className={s.codeInput}
              inputMode={mode === "mfa" && useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              maxLength={mode === "mfa" && useRecovery ? 12 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus={mode !== "reset"}
              required
            />
          ) : null}
          {needsPassword ? (
            <PasswordField
              label={mode === "reset" ? t("auth.newPassword") : t("auth.password")}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              hint={mode === "signin" ? undefined : t("auth.passwordHint")}
              labelAction={
                mode === "signin" ? (
                  <button type="button" className={s.forgotLink} onClick={() => go("forgot")}>
                    {t("auth.forgot")}
                  </button>
                ) : undefined
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          ) : null}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {submitLabel}
          </Button>
        </form>

        {/* Secondary actions: one centred stack under the primary button.
            Line 1 is this screen's alternative; line 2, the quiet way out. */}
        <div className={s.footer}>
          {mode === "signin" ? (
            <p className={s.prompt}>
              {t("auth.noAccount")}{" "}
              <button type="button" className={s.linkButton} onClick={() => go("register")}>
                {t("auth.register")}
              </button>
            </p>
          ) : null}
          {mode === "register" || mode === "forgot" || mode === "reset" ? (
            <p className={s.prompt}>
              {t("auth.haveAccount")}{" "}
              <button type="button" className={s.linkButton} onClick={() => go("signin")}>
                {t("auth.signIn")}
              </button>
            </p>
          ) : null}
          {mode === "verify" ? (
            <button
              type="button"
              className={s.linkButton}
              onClick={() => run(async () => {
                await transport().account.resendVerification(email.trim());
                setInfo(t("auth.resent"));
              })}
            >
              {t("auth.resend")}
            </button>
          ) : null}
          {mode === "mfa" ? (
            <button type="button" className={s.linkButton} onClick={() => setUseRecovery((v) => !v)}>
              {useRecovery ? t("auth.useCode") : t("auth.useRecovery")}
            </button>
          ) : null}
          <button type="button" className={s.guestButton} onClick={() => navigate("/servers")}>
            {t("auth.continueOffline")}
          </button>
        </div>
      </main>
    </div>
  );
}
