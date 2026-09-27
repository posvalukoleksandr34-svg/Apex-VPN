import { Laptop, LogIn, MonitorSmartphone, ReceiptText } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ensureEnrolled, refreshSubscription, signOut, subscriptionAllowsConnecting } from "@/app/actions";
import { transport } from "@/app/transportRef";
import { Badge, Banner, Button, Card, Dialog, EmptyState, KeyValue, Page, PageHeader, PasswordField, SettingRow, TabPanel, Tabs, TextField, useConfirm, useToast } from "@/design";
import { apiErrorMessage } from "@/lib/errors";
import { date, money } from "@/lib/format";
import { useApp } from "@/state/store";
import s from "./Account.module.css";

const TABS = ["profile", "security", "devices", "subscription"] as const;

export default function Account() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab = "profile" } = useParams<{ tab: (typeof TABS)[number] }>();
  const account = useApp((st) => st.account);
  if (account.status !== "signed_in" || !account.user) {
    return (
      <Page>
        <PageHeader title={t("account.title")} />
        <Card>
          <EmptyState
            icon={<LogIn size={22} />}
            title={t("account.signedOut.title")}
            body={t("account.signedOut.body")}
            action={<Button variant="primary" onClick={() => navigate("/auth/signin")}>{t("actions.sign_in")}</Button>}
          />
        </Card>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader title={t("account.title")} actions={<Button variant="ghost" onClick={() => void signOut()}>{t("actions.signOut")}</Button>} />
      {account.offline ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="warning">{t("account.offline")}</Banner>
        </div>
      ) : null}
      <Tabs label={t("account.title")} value={tab} onValueChange={(v) => navigate(`/account/${v}`)} items={TABS.map((k) => ({ value: k, label: t(`account.tabs.${k}`) }))}>
        <TabPanel value="profile">
          <ProfileTab />
        </TabPanel>
        <TabPanel value="security">
          <SecurityTab />
        </TabPanel>
        <TabPanel value="devices">
          <DevicesTab />
        </TabPanel>
        <TabPanel value="subscription">
          <SubscriptionTab />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

function ProfileTab() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const user = useApp((st) => st.account.user)!;
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <KeyValue
        items={[
          {
            label: t("account.profile.email"),
            value: (
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                {user.email}
                <Badge tone={user.emailVerified ? "success" : "warning"}>{t(user.emailVerified ? "account.profile.verified" : "account.profile.unverified")}</Badge>
              </span>
            ),
          },
          { label: t("account.profile.memberSince"), value: date(user.createdAt, i18n.language) },
        ]}
      />
      {!user.emailVerified ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Button
            onClick={async () => {
              await transport().account.resendVerification(user.email).catch(() => {});
              navigate("/auth/verify");
            }}
          >
            {t("account.profile.verifyNow")}
          </Button>
        </div>
      ) : null}
      <div style={{ marginTop: "var(--space-8)" }}>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          {t("account.profile.delete")}
        </Button>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("account.profile.deleteTitle")}
        description={t("account.profile.deleteBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={!password}
              onClick={async () => {
                try {
                  await transport().account.request("DELETE", "/v1/users/me", { password });
                  await signOut();
                  navigate("/");
                } catch (e) {
                  setError(apiErrorMessage(t, e));
                  toast({ tone: "error", title: apiErrorMessage(t, e) });
                }
              }}
            >
              {t("actions.delete")}
            </Button>
          </>
        }
      >
        {error ? <Banner tone="error">{error}</Banner> : null}
        <PasswordField label={t("account.profile.deletePassword")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Dialog>
    </Card>
  );
}

interface Session {
  id: string;
  deviceName: string;
  platform: string;
  createdAt: string;
  lastUsedOn: string;
  current: boolean;
}

function SecurityTab() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const user = useApp((st) => st.account.user)!;
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwError, setPwError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ step: "setup" | "codes" | "disable"; secret?: string; url?: string; codes?: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);

  const loadSessions = useCallback(() => transport().account.request<Session[]>("GET", "/v1/users/me/sessions").then(setSessions, () => setSessions([])), []);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const refreshUser = async () => {
    const u = await transport().account.session();
    useApp.setState((st) => ({ account: { ...st.account, user: u } }));
  };

  return (
    <>
      <Card title={t("account.security.password")}>
        <form
          className={s.passwordForm}
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pw.current || !pw.next) return;
            setPwError(null);
            try {
              await transport().account.request("POST", "/v1/users/me/password", { currentPassword: pw.current, newPassword: pw.next });
              setPw({ current: "", next: "" });
              toast({ tone: "success", title: t("account.security.passwordChanged") });
              void loadSessions();
            } catch (err) {
              setPwError(apiErrorMessage(t, err));
            }
          }}
        >
          {pwError ? <Banner tone="error">{pwError}</Banner> : null}
          <PasswordField label={t("account.security.currentPassword")} autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <PasswordField label={t("account.security.newPassword")} autoComplete="new-password" hint={t("auth.passwordHint")} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button type="submit" variant="primary" className={s.passwordSubmit} disabled={!pw.current || !pw.next}>
            {t("account.security.changePassword")}
          </Button>
        </form>
      </Card>

      <Card title={t("account.security.twoFactor")} className={s.spaced}>
        <SettingRow label={t("account.security.twoFactor")} description={user.mfaEnabled ? t("account.security.twoFactorOn") : t("account.security.twoFactorOff")}>
          {user.mfaEnabled ? (
            <Button variant="danger" size="sm" onClick={() => setMfa({ step: "disable" })}>
              {t("actions.disable")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  const r = await transport().account.request<{ secret: string; otpauthUrl: string }>("POST", "/v1/users/me/mfa/totp/setup");
                  setMfa({ step: "setup", secret: r.secret, url: r.otpauthUrl });
                } catch (e) {
                  toast({ tone: "error", title: apiErrorMessage(t, e) });
                }
              }}
            >
              {t("account.security.setup")}
            </Button>
          )}
        </SettingRow>
      </Card>

      <Card
        title={t("account.security.sessions")}
        className={s.spaced}
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={!sessions || sessions.length < 2}
            onClick={async () => {
              await transport().account.request("POST", "/v1/users/me/sessions/revoke-others").catch(() => {});
              void loadSessions();
            }}
          >
            {t("account.security.signOutOthers")}
          </Button>
        }
      >
        <ul className={s.list}>
          {(sessions ?? []).map((se) => (
            <li key={se.id} className={s.listRow}>
              <Laptop size={18} aria-hidden />
              <div className={s.grow}>
                <div>
                  {se.deviceName} {se.current ? <Badge tone="accent">{t("account.security.thisDevice")}</Badge> : null}
                </div>
                <div className={s.note}>{t("account.security.lastActive", { date: date(se.lastUsedOn, i18n.language) })}</div>
              </div>
              {!se.current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: t("actions.revoke"), body: se.deviceName, confirmLabel: t("actions.revoke"), danger: true }))) return;
                    await transport().account.request("DELETE", `/v1/users/me/sessions/${se.id}`).catch(() => {});
                    void loadSessions();
                  }}
                >
                  {t("actions.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
          {sessions && sessions.length < 2 ? <li className={s.note}>{t("account.security.noSessions")}</li> : null}
        </ul>
      </Card>

      <Dialog
        open={!!mfa}
        onOpenChange={(o) => {
          if (!o) {
            setMfa(null);
            setCode("");
            setPassword("");
            setMfaError(null);
          }
        }}
        title={mfa?.step === "codes" ? t("account.security.recoveryTitle") : mfa?.step === "disable" ? t("account.security.disableTitle") : t("account.security.setupTitle")}
        footer={
          mfa?.step === "codes" ? (
            <Button variant="primary" onClick={() => setMfa(null)}>
              {t("actions.done")}
            </Button>
          ) : (
            <Button
              variant={mfa?.step === "disable" ? "danger" : "primary"}
              disabled={code.length !== 6 || (mfa?.step === "disable" && !password)}
              onClick={async () => {
                setMfaError(null);
                try {
                  if (mfa?.step === "disable") {
                    await transport().account.request("POST", "/v1/users/me/mfa/totp/disable", { password, code });
                    setMfa(null);
                  } else {
                    const r = await transport().account.request<{ recoveryCodes: string[] }>("POST", "/v1/users/me/mfa/totp/enable", { code });
                    setMfa({ step: "codes", codes: r.recoveryCodes });
                  }
                  setCode("");
                  setPassword("");
                  await refreshUser();
                } catch (e) {
                  setMfaError(apiErrorMessage(t, e));
                }
              }}
            >
              {mfa?.step === "disable" ? t("actions.disable") : t("actions.enable")}
            </Button>
          )
        }
      >
        {mfaError ? <Banner tone="error">{mfaError}</Banner> : null}
        {mfa?.step === "setup" ? (
          <div className={s.stack}>
            <p>{t("account.security.setupStep1")}</p>
            {mfa.url ? <TotpQr url={mfa.url} label={t("account.security.qr")} /> : null}
            <div>
              <div className={s.note}>{t("account.security.secretKey")}</div>
              <code className={s.secret}>{mfa.secret?.match(/.{1,4}/g)?.join(" ")}</code>
            </div>
            <p>{t("account.security.setupStep2")}</p>
            <TextField label={t("account.security.code")} inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </div>
        ) : null}
        {mfa?.step === "codes" ? (
          <div className={s.stack}>
            <p>{t("account.security.recoveryBody")}</p>
            <ul className={s.codes}>
              {mfa.codes?.map((c) => (
                <li key={c} className="mono">
                  {c}
                </li>
              ))}
            </ul>
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(mfa.codes?.join("\n") ?? "")}>
              {t("actions.copy")}
            </Button>
          </div>
        ) : null}
        {mfa?.step === "disable" ? (
          <div className={s.stack}>
            <PasswordField label={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <TextField label={t("account.security.code")} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** The otpauth:// URL as a QR code, rendered locally (the secret never leaves the app). */
function TotpQr({ url, label }: { url: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(url, { margin: 1, width: 192, color: { dark: "#0a0c11", light: "#ffffff" } }).then(setSrc, () => setSrc(null));
  }, [url]);
  return src ? <img src={src} alt={label} width={192} height={192} style={{ borderRadius: 12, justifySelf: "start" }} /> : null;
}

interface Device {
  id: string;
  name: string;
  platform: string;
  publicKey: string;
  createdAt: string;
  lastSeenOn: string;
  connected: boolean;
}

function DevicesTab() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const localKey = useApp((st) => st.device?.publicKey);
  const registered = useApp((st) => !!st.device?.registration);
  const sub = useApp((st) => st.account.subscription);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const load = useCallback(() => transport().account.request<Device[]>("GET", "/v1/devices").then(setDevices, () => setDevices([])), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <p className={s.intro}>{t("account.devices.intro")}</p>
      {sub?.plan ? <p className={s.note}>{t("account.devices.limit", { used: devices?.length ?? sub.devicesUsed, limit: sub.plan.deviceLimit })}</p> : null}
      {!registered ? (
        <div className={s.spacedBanner}>
          <Banner
            tone="warning"
            action={
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await ensureEnrolled();
                    void load();
                  } catch (e) {
                    toast({ tone: "error", title: apiErrorMessage(t, e) });
                  }
                }}
              >
                {t("account.devices.register")}
              </Button>
            }
          >
            {t("account.devices.notRegistered")}
          </Banner>
        </div>
      ) : null}
      <Card flush>
        {devices && devices.length === 0 ? (
          <EmptyState icon={<MonitorSmartphone size={22} />} title={t("account.devices.empty.title")} body={t("account.devices.empty.body")} />
        ) : (
          <ul className={s.list} style={{ padding: "0 var(--space-5)" }}>
            {(devices ?? []).map((d) => {
              const self = d.publicKey === localKey;
              return (
                <li key={d.id} className={s.listRow}>
                  <Laptop size={18} aria-hidden />
                  <div className={s.grow}>
                    <div>
                      {d.name} {self ? <Badge tone="accent">{t("account.devices.thisDevice")}</Badge> : null} {d.connected ? <Badge tone="success" dot>{t("account.devices.connectedNow")}</Badge> : null}
                    </div>
                    <div className={s.note}>
                      {d.platform} · {t("account.devices.lastSeen", { date: date(d.lastSeenOn, i18n.language) })} · {t("account.devices.added", { date: date(d.createdAt, i18n.language) })}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!(await confirm({ title: t("account.devices.revokeTitle", { name: d.name }), body: t("account.devices.revokeBody"), danger: true, confirmLabel: t("actions.revoke") }))) return;
                      await transport().account.request("DELETE", `/v1/devices/${d.id}`).catch(() => {});
                      void load();
                    }}
                  >
                    {t("actions.revoke")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

interface Plan {
  id: string;
  name: string;
  period: "trial" | "month" | "year";
  priceCents: number;
  currency: string;
  deviceLimit: number;
}

interface Invoice {
  id: string;
  number: string;
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  issuedAt: string;
}

function SubscriptionTab() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const sub = useApp((st) => st.account.subscription);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    void transport().account.request<Plan[]>("GET", "/v1/subscription/plans").then(setPlans, () => {});
    void transport().account.request<Invoice[]>("GET", "/v1/subscription/invoices").then(setInvoices, () => setInvoices([]));
  }, []);
  if (!sub) return <Card>{t("common.loading")}</Card>;
  const end = sub.currentPeriodEnd ? date(sub.currentPeriodEnd, i18n.language) : "—";
  const statusTone = sub.status === "active" || sub.status === "trialing" ? "success" : sub.status === "past_due" ? "warning" : "error";
  const checkout = async (planId: string) => {
    try {
      const r = await transport().account.request<{ kind: "redirect" | "activated"; url?: string }>("POST", "/v1/subscription/checkout", { planId });
      if (r.kind === "redirect" && r.url) {
        await transport().app.openExternal(r.url);
        toast({ tone: "neutral", title: t("account.subscription.checkoutOpened") });
      } else {
        toast({ tone: "success", title: t("account.subscription.activated") });
      }
      setChoosing(false);
      await refreshSubscription();
    } catch (e) {
      toast({ tone: "error", title: apiErrorMessage(t, e) });
    }
  };
  const manageBilling = async () => {
    try {
      const r = await transport().account.request<{ url: string }>("POST", "/v1/subscription/portal");
      await transport().app.openExternal(r.url);
      toast({ tone: "neutral", title: t("account.subscription.checkoutOpened") });
    } catch (e) {
      toast({ tone: "error", title: apiErrorMessage(t, e) });
    }
  };
  const canConnect = subscriptionAllowsConnecting(sub);
  return (
    <>
      {/* Why Connect is refused, and the way out. */}
      {!canConnect ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner
            tone={sub.status === "incomplete" ? "warning" : "error"}
            action={
              <Button size="sm" variant="primary" onClick={() => setChoosing(true)}>
                {t("account.subscription.choosePlan")}
              </Button>
            }
          >
            {sub.status === "incomplete" ? t("account.subscription.incompleteBody") : t("account.subscription.renewBody")}
          </Banner>
        </div>
      ) : sub.status === "past_due" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner
            tone="warning"
            action={
              sub.provider === "stripe" ? (
                <Button size="sm" onClick={() => void manageBilling()}>
                  {t("account.subscription.manageBilling")}
                </Button>
              ) : undefined
            }
          >
            {t("account.subscription.pastDueBody")}
          </Banner>
        </div>
      ) : null}
      <Card title={t("account.subscription.plan")}>
        <KeyValue
          items={[
            { label: t("account.subscription.plan"), value: sub.plan?.name ?? t("account.subscription.statuses.none") },
            { label: t("account.subscription.status"), value: <Badge tone={statusTone}>{t(`account.subscription.statuses.${sub.status}`)}</Badge> },
            {
              label: t("account.subscription.renewal"),
              value: sub.status === "trialing" ? t("account.subscription.trialEnds", { date: end }) : sub.cancelAtPeriodEnd ? t("account.subscription.ends", { date: end }) : t("account.subscription.renews", { date: end }),
            },
            { label: t("account.subscription.period"), value: sub.plan ? t(`account.subscription.periods.${sub.plan.period}`) : "—" },
            {
              label: t("account.subscription.paymentMethod"),
              value: sub.paymentMethod ? t("account.subscription.card", { brand: sub.paymentMethod.brand, last4: sub.paymentMethod.last4 }) : t("account.subscription.noPaymentMethod"),
            },
          ]}
        />
        {sub.provider === "manual" && sub.status !== "trialing" ? <p className={s.note} style={{ marginTop: "var(--space-3)" }}>{t("account.subscription.manualNote")}</p> : null}
        <div className={s.actions}>
          <Button variant="primary" onClick={() => setChoosing(true)}>
            {canConnect && sub.status !== "trialing" ? t("account.subscription.changePlan") : t("account.subscription.choosePlan")}
          </Button>
          {sub.provider === "stripe" ? (
            <Button onClick={() => void manageBilling()}>{t("account.subscription.manageBilling")}</Button>
          ) : null}
          {sub.status === "active" && !sub.cancelAtPeriodEnd ? (
            <Button
              variant="ghost"
              onClick={async () => {
                if (!(await confirm({ title: t("account.subscription.cancelTitle"), body: t("account.subscription.cancelBody", { date: end }), danger: true, confirmLabel: t("account.subscription.cancel") }))) return;
                await transport().account.request("POST", "/v1/subscription/cancel").catch(() => {});
                await refreshSubscription();
              }}
            >
              {t("account.subscription.cancel")}
            </Button>
          ) : null}
          {sub.cancelAtPeriodEnd ? (
            <Button
              onClick={async () => {
                await transport().account.request("POST", "/v1/subscription/resume").catch(() => {});
                await refreshSubscription();
              }}
            >
              {t("account.subscription.resume")}
            </Button>
          ) : null}
        </div>
      </Card>

      <Card title={t("account.subscription.invoices")} className={s.spaced}>
        {invoices && invoices.length === 0 ? (
          <EmptyState icon={<ReceiptText size={22} />} title={t("account.subscription.noInvoices")} />
        ) : (
          <ul className={s.list}>
            {(invoices ?? []).map((i) => (
              <li key={i.id} className={s.listRow}>
                <div className={s.grow}>
                  <div>{i.description}</div>
                  <div className={s.note}>
                    {i.number} · {date(i.issuedAt, i18n.language)}
                  </div>
                </div>
                <span className="tabular">{money(i.amountCents, i.currency, i18n.language)}</span>
                <Badge tone={i.status === "paid" ? "success" : "neutral"}>{i.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={choosing} onOpenChange={setChoosing} title={t("account.subscription.choosePlan")} wide>
        <div className={s.plans}>
          {plans.map((p) => (
            <div key={p.id} className={s.plan} data-current={sub.plan?.id === p.id}>
              <div className={s.planName}>{p.name}</div>
              <div className={s.planPrice}>
                {t(p.period === "year" ? "account.subscription.perYear" : "account.subscription.perMonth", { price: money(p.priceCents, p.currency, i18n.language) })}
              </div>
              <div className={s.note}>{t("account.subscription.devicesIncluded", { count: p.deviceLimit })}</div>
              <Button variant={sub.plan?.id === p.id ? "secondary" : "primary"} disabled={sub.plan?.id === p.id && sub.status === "active"} onClick={() => void checkout(p.id)}>
                {t("account.subscription.choosePlan")}
              </Button>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}
