import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { render, SmtpMailer, type MailTemplate, type MailTransport } from "../src/lib/mailer.js";
import { testApp, type TestApp } from "./helpers.js";

const templates: MailTemplate[] = [
  { kind: "verify_email", code: "123456" },
  { kind: "reset_password", code: "654321" },
  { kind: "registration_attempt" },
  { kind: "new_login", deviceName: "Firefox on Linux", platform: "web" },
  { kind: "password_changed" },
  { kind: "mfa_changed", enabled: true },
  { kind: "mfa_changed", enabled: false },
];

describe("templates", () => {
  it("exist in every language, carry their details, and fall back to English", () => {
    for (const locale of ["en", "ru", "de", "it"]) {
      for (const t of templates) {
        const { subject, text } = render(t, locale);
        expect(subject.length, `${locale} ${t.kind}`).toBeGreaterThan(5);
        if ("code" in t) expect(text).toContain(t.code);
        if (t.kind === "new_login") expect(text).toContain("Firefox on Linux");
      }
    }
    expect(render({ kind: "verify_email", code: "1" }, "ru").subject).not.toBe(render({ kind: "verify_email", code: "1" }, "en").subject);
    expect(render({ kind: "verify_email", code: "1" }, "fr")).toEqual(render({ kind: "verify_email", code: "1" }, "en"));
  });
});

describe("SMTP", () => {
  const transport = (fail = false) => {
    const sent: Parameters<MailTransport["sendMail"]>[0][] = [];
    const t: MailTransport = {
      sendMail: async (m) => {
        if (fail) throw new Error("connection refused");
        sent.push(m);
      },
    };
    return { t, sent };
  };

  it("sends plain text from the configured sender, in the account's language", async () => {
    const { t, sent } = transport();
    await new SmtpMailer(t, "Apexy VPN <no-reply@apexy.test>").send("a@example.com", { kind: "verify_email", code: "112233" }, "de");
    expect(sent).toEqual([{ from: "Apexy VPN <no-reply@apexy.test>", to: "a@example.com", ...render({ kind: "verify_email", code: "112233" }, "de") }]);
  });

  it("fails loudly for codes, and only logs notices (an outage must not stop sign-ins)", async () => {
    const { t } = transport(true);
    const logged: string[] = [];
    const mailer = new SmtpMailer(t, "x@apexy.test", (m) => logged.push(m));
    await expect(mailer.send("a@example.com", { kind: "reset_password", code: "1" })).rejects.toThrow(/connection refused/);
    await expect(mailer.send("a@example.com", { kind: "new_login", deviceName: "PC", platform: "windows" })).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("a@example.com");
  });

  it("needs its settings", () => {
    const env = { NODE_ENV: "test", ACCESS_TOKEN_SEED: "a".repeat(43) + "=", RELAY_SIGNING_SEED: "a".repeat(43) + "=", DATA_ENCRYPTION_KEY: "a".repeat(43) + "=", MAIL_TRANSPORT: "smtp" };
    expect(() => loadConfig(env)).toThrow(/SMTP_URL and MAIL_FROM/);
    expect(() => loadConfig({ ...env, SMTP_URL: "http://x", MAIL_FROM: "a@b" })).toThrow(/smtp:\/\/ or smtps:\/\//);
    expect(loadConfig({ ...env, SMTP_URL: "smtps://u:p@smtp.example.com:465", MAIL_FROM: "Apexy VPN <no-reply@example.com>" }).MAIL_TRANSPORT).toBe("smtp");
  });
});

describe("in the account's language", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("sends the verification code in the language chosen at sign-up", async () => {
    t = await testApp();
    await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "ru@example.com", password: "correct horse battery staple", locale: "ru" } });
    expect(t.mailer.sent.at(-1)).toMatchObject({ to: "ru@example.com", template: { kind: "verify_email" }, locale: "ru" });
  });
});
