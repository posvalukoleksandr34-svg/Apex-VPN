/**
 * Outgoing email. Templates are keyed; content is rendered here so no
 * route builds email text ad hoc.
 */
export type MailTemplate =
  | { kind: "verify_email"; code: string }
  | { kind: "reset_password"; code: string }
  | { kind: "registration_attempt" }
  | { kind: "new_login"; deviceName: string; platform: string }
  | { kind: "password_changed" }
  | { kind: "mfa_changed"; enabled: boolean };

export interface Mailer {
  send(to: string, template: MailTemplate): Promise<void>;
}

export function render(t: MailTemplate): { subject: string; text: string } {
  switch (t.kind) {
    case "verify_email":
      return { subject: "Your Apexy VPN verification code", text: `Your verification code is ${t.code}. It expires in 15 minutes.` };
    case "reset_password":
      return {
        subject: "Reset your Apexy VPN password",
        text: `Your password reset code is ${t.code}. It expires in 15 minutes. If you didn't ask for this, ignore this email.`,
      };
    case "registration_attempt":
      return {
        subject: "Someone tried to create an Apexy VPN account with your email",
        text: "You already have an account. If this was you, sign in or reset your password.",
      };
    case "new_login":
      return { subject: "New sign-in to your Apexy VPN account", text: `New sign-in from ${t.deviceName} (${t.platform}).` };
    case "password_changed":
      return { subject: "Your Apexy VPN password was changed", text: "All other sessions were signed out." };
    case "mfa_changed":
      return {
        subject: `Two-factor authentication ${t.enabled ? "enabled" : "disabled"}`,
        text: `Two-factor authentication was ${t.enabled ? "enabled" : "disabled"} on your account.`,
      };
  }
}

/** Development only: prints mail to the console (the config refuses it in production). */
export class ConsoleMailer implements Mailer {
  readonly sent: { to: string; template: MailTemplate }[] = [];

  async send(to: string, template: MailTemplate): Promise<void> {
    this.sent.push({ to, template });
    if (process.env.NODE_ENV !== "test") {
      const { subject, text } = render(template);
      console.log(`[mail] to=${to} subject="${subject}"\n       ${text}`);
    }
  }
}

/**
 * Integration point: an SMTP / transactional-email provider. Not bundled in
 * this build, so selecting it fails at startup instead of silently dropping mail.
 */
export function smtpMailer(): Mailer {
  throw new Error("MAIL_TRANSPORT=smtp is an integration point: add a provider adapter in src/lib/mailer.ts");
}
