import nodemailer from "nodemailer";

/**
 * Outgoing email. Templates are keyed and rendered here in the account's
 * language, so no route builds email text ad hoc.
 */
export type MailTemplate =
  | { kind: "verify_email"; code: string }
  | { kind: "reset_password"; code: string }
  | { kind: "registration_attempt" }
  | { kind: "new_login"; deviceName: string; platform: string }
  | { kind: "password_changed" }
  | { kind: "mfa_changed"; enabled: boolean };

export interface Mailer {
  /** `locale`: the account's language (en, ru, de, it); anything else gets English. */
  send(to: string, template: MailTemplate, locale?: string): Promise<void>;
}

type Locale = "en" | "ru" | "de" | "it";
const pick = (locale: string | undefined): Locale => (locale === "ru" || locale === "de" || locale === "it" ? locale : "en");

type Text = { subject: string; text: string };
const copy: Record<Locale, { [K in MailTemplate["kind"]]: (t: Extract<MailTemplate, { kind: K }>) => Text }> = {
  en: {
    verify_email: (t) => ({ subject: "Your Apexy VPN verification code", text: `Your verification code is ${t.code}. It expires in 15 minutes.` }),
    reset_password: (t) => ({
      subject: "Reset your Apexy VPN password",
      text: `Your password reset code is ${t.code}. It expires in 15 minutes. If you didn't ask for this, ignore this email.`,
    }),
    registration_attempt: () => ({
      subject: "Someone tried to create an Apexy VPN account with your email",
      text: "You already have an account. If this was you, sign in or reset your password.",
    }),
    new_login: (t) => ({ subject: "New sign-in to your Apexy VPN account", text: `New sign-in from ${t.deviceName} (${t.platform}). If this wasn't you, change your password.` }),
    password_changed: () => ({ subject: "Your Apexy VPN password was changed", text: "All other sessions were signed out. If you didn't do this, reset your password." }),
    mfa_changed: (t) => ({
      subject: t.enabled ? "Two-step verification is on" : "Two-step verification is off",
      text: t.enabled ? "Sign-ins to your Apexy VPN account now need a code from your authenticator app." : "Sign-ins to your Apexy VPN account no longer need an authenticator code. If you didn't do this, change your password.",
    }),
  },
  ru: {
    verify_email: (t) => ({ subject: "Код подтверждения Apexy VPN", text: `Ваш код подтверждения: ${t.code}. Он действует 15 минут.` }),
    reset_password: (t) => ({
      subject: "Сброс пароля Apexy VPN",
      text: `Код для сброса пароля: ${t.code}. Он действует 15 минут. Если вы не запрашивали сброс, просто проигнорируйте это письмо.`,
    }),
    registration_attempt: () => ({
      subject: "Кто-то пытался создать аккаунт Apexy VPN на ваш email",
      text: "У вас уже есть аккаунт. Если это были вы, войдите или сбросьте пароль.",
    }),
    new_login: (t) => ({ subject: "Новый вход в аккаунт Apexy VPN", text: `Выполнен вход с устройства ${t.deviceName} (${t.platform}). Если это были не вы, смените пароль.` }),
    password_changed: () => ({ subject: "Пароль Apexy VPN изменён", text: "Все остальные сеансы завершены. Если это сделали не вы, сбросьте пароль." }),
    mfa_changed: (t) => ({
      subject: t.enabled ? "Двухэтапная проверка включена" : "Двухэтапная проверка выключена",
      text: t.enabled ? "Для входа в аккаунт Apexy VPN теперь нужен код из приложения-аутентификатора." : "Для входа в аккаунт Apexy VPN код из приложения больше не нужен. Если это сделали не вы, смените пароль.",
    }),
  },
  de: {
    verify_email: (t) => ({ subject: "Dein Bestätigungscode für Apexy VPN", text: `Dein Bestätigungscode lautet ${t.code}. Er ist 15 Minuten gültig.` }),
    reset_password: (t) => ({
      subject: "Passwort für Apexy VPN zurücksetzen",
      text: `Dein Code zum Zurücksetzen lautet ${t.code}. Er ist 15 Minuten gültig. Wenn du das nicht angefordert hast, ignoriere diese E-Mail.`,
    }),
    registration_attempt: () => ({
      subject: "Jemand wollte mit deiner E-Mail-Adresse ein Apexy-VPN-Konto erstellen",
      text: "Du hast bereits ein Konto. Wenn du das warst, melde dich an oder setze dein Passwort zurück.",
    }),
    new_login: (t) => ({ subject: "Neue Anmeldung bei deinem Apexy-VPN-Konto", text: `Neue Anmeldung von ${t.deviceName} (${t.platform}). Wenn du das nicht warst, ändere dein Passwort.` }),
    password_changed: () => ({ subject: "Dein Apexy-VPN-Passwort wurde geändert", text: "Alle anderen Sitzungen wurden abgemeldet. Wenn du das nicht warst, setze dein Passwort zurück." }),
    mfa_changed: (t) => ({
      subject: t.enabled ? "Bestätigung in zwei Schritten ist an" : "Bestätigung in zwei Schritten ist aus",
      text: t.enabled ? "Für Anmeldungen bei deinem Apexy-VPN-Konto brauchst du jetzt einen Code aus deiner Authenticator-App." : "Für Anmeldungen bei deinem Apexy-VPN-Konto brauchst du keinen Code mehr. Wenn du das nicht warst, ändere dein Passwort.",
    }),
  },
  it: {
    verify_email: (t) => ({ subject: "Il tuo codice di verifica Apexy VPN", text: `Il tuo codice di verifica è ${t.code}. Scade tra 15 minuti.` }),
    reset_password: (t) => ({
      subject: "Reimposta la password di Apexy VPN",
      text: `Il codice per reimpostare la password è ${t.code}. Scade tra 15 minuti. Se non l'hai richiesto, ignora questa email.`,
    }),
    registration_attempt: () => ({
      subject: "Qualcuno ha provato a creare un account Apexy VPN con la tua email",
      text: "Hai già un account. Se eri tu, accedi o reimposta la password.",
    }),
    new_login: (t) => ({ subject: "Nuovo accesso al tuo account Apexy VPN", text: `Nuovo accesso da ${t.deviceName} (${t.platform}). Se non eri tu, cambia la password.` }),
    password_changed: () => ({ subject: "La password di Apexy VPN è cambiata", text: "Tutte le altre sessioni sono state chiuse. Se non sei stato tu, reimposta la password." }),
    mfa_changed: (t) => ({
      subject: t.enabled ? "Verifica in due passaggi attivata" : "Verifica in due passaggi disattivata",
      text: t.enabled ? "Per accedere al tuo account Apexy VPN ora serve un codice dell'app di autenticazione." : "Per accedere al tuo account Apexy VPN non serve più un codice dell'app. Se non sei stato tu, cambia la password.",
    }),
  },
};

export function render(t: MailTemplate, locale?: string): Text {
  const table = copy[pick(locale)];
  return (table[t.kind] as (t: MailTemplate) => Text)(t);
}

/**
 * Codes someone is waiting for must arrive, so a failure to send them is an
 * error. The rest are notices: a mail outage must not stop anyone signing in.
 */
const NOTICES: ReadonlySet<MailTemplate["kind"]> = new Set(["registration_attempt", "new_login", "password_changed", "mfa_changed"]);

/** Development only: prints mail to the console (the config refuses it in production). */
export class ConsoleMailer implements Mailer {
  readonly sent: { to: string; template: MailTemplate; locale: string }[] = [];

  async send(to: string, template: MailTemplate, locale?: string): Promise<void> {
    this.sent.push({ to, template, locale: pick(locale) });
    if (process.env.NODE_ENV !== "test") {
      const { subject, text } = render(template, locale);
      console.log(`[mail] to=${to} subject="${subject}"\n       ${text}`);
    }
  }
}

/** Anything that sends a message (nodemailer's transports, a fake in tests). */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Plain-text mail through any SMTP provider (Postmark, SES, Mailgun, Brevo, Resend…). */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {}

  async send(to: string, template: MailTemplate, locale?: string): Promise<void> {
    const { subject, text } = render(template, locale);
    try {
      await this.transport.sendMail({ from: this.from, to, subject, text });
    } catch (e) {
      if (!NOTICES.has(template.kind)) throw e;
      // The address isn't logged (no-logs); the failure is.
      this.log(`mail: a ${template.kind} notice couldn't be sent: ${(e as Error).message}`);
    }
  }
}

/** `SMTP_URL`: smtps://user:password@smtp.example.com:465 (or smtp://…:587 with STARTTLS). */
export function smtpMailer(url: string, from: string): Mailer {
  return new SmtpMailer(nodemailer.createTransport(url), from);
}
