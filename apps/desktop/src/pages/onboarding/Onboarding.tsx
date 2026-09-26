import { ArrowRight, Check, EyeOff, KeyRound, Lock, Network, Rocket, Wifi } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { updateSettings } from "@/app/actions";
import { Badge, Button, SwitchRow } from "@/design";
import { Logo } from "@/shell/Logo";
import { useApp } from "@/state/store";
import s from "./Onboarding.module.css";

const STEPS = ["welcome", "privacy", "how", "protection", "autoConnect", "account"] as const;

export default function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const service = useApp((st) => st.service);
  const settings = useApp((st) => st.settings);
  const signedIn = useApp((st) => st.account.status === "signed_in");
  const setPrefs = useApp((st) => st.setPrefs);

  const finish = () => {
    setPrefs({ onboardingDone: true });
    navigate("/", { replace: true });
  };
  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : finish());

  const body: Record<(typeof STEPS)[number], ReactNode> = {
    welcome: (
      <Hero icon={<Logo size={56} />} title={t("onboarding.welcome.title")} text={t("onboarding.welcome.body")} />
    ),
    privacy: (
      <Hero icon={<EyeOff size={40} />} title={t("onboarding.privacy.title")} text={t("onboarding.privacy.body")}>
        <ul className={s.points}>
          {(["traffic", "analytics", "diagnostics"] as const).map((k) => (
            <li key={k}>
              <Check size={16} aria-hidden /> {t(`privacy.items.${k}.name`)}: {t(`privacy.state.${k === "diagnostics" ? "off" : "never"}`)}
            </li>
          ))}
        </ul>
      </Hero>
    ),
    how: (
      <Hero icon={<Network size={40} />} title={t("onboarding.how.title")} text={t("onboarding.how.body")}>
        <div className={s.serviceRow}>
          {t("onboarding.how.service")}
          <Badge tone={service === "ready" ? "success" : service === "connecting" ? "pending" : "error"} dot>
            {service === "ready" ? t("onboarding.how.serviceReady") : service === "connecting" ? t("common.loading") : t("onboarding.how.serviceMissing")}
          </Badge>
        </div>
      </Hero>
    ),
    protection: (
      <Hero icon={<Lock size={40} />} title={t("onboarding.protection.title")} text={t("onboarding.protection.body")}>
        {settings ? (
          <div className={s.card}>
            <SwitchRow
              label={t("settings.sections.killSwitch")}
              description={t("settings.killSwitch.modes.while_connected.desc")}
              checked={settings.killSwitch !== "off"}
              onCheckedChange={(on) => void updateSettings({ killSwitch: on ? "while_connected" : "off" })}
            />
            <SwitchRow
              label={t("settings.dns.blockLeaks")}
              description={t("settings.dns.blockLeaksDesc")}
              checked={settings.dns.blockLeaks}
              onCheckedChange={(blockLeaks) => void updateSettings({ dns: { ...settings.dns, blockLeaks } })}
            />
            <SwitchRow
              label={t("settings.network.blockIpv6")}
              description={t("settings.network.blockIpv6Desc")}
              checked={settings.network.blockIpv6Leaks}
              onCheckedChange={(blockIpv6Leaks) => void updateSettings({ network: { ...settings.network, blockIpv6Leaks } })}
            />
          </div>
        ) : null}
      </Hero>
    ),
    autoConnect: (
      <Hero icon={<Wifi size={40} />} title={t("onboarding.autoConnect.title")} text={t("onboarding.autoConnect.body")}>
        {settings ? (
          <div className={s.card}>
            <SwitchRow
              label={t("settings.autoConnect.onUntrusted")}
              checked={settings.autoConnect.onUntrustedNetwork}
              onCheckedChange={(on) => void updateSettings({ autoConnect: { ...settings.autoConnect, onUntrustedNetwork: on } })}
            />
            <SwitchRow
              label={t("settings.autoConnect.onOpenWifi")}
              checked={settings.autoConnect.onOpenWifi}
              onCheckedChange={(on) => void updateSettings({ autoConnect: { ...settings.autoConnect, onOpenWifi: on } })}
            />
          </div>
        ) : null}
      </Hero>
    ),
    account: signedIn ? (
      <Hero icon={<Rocket size={40} />} title={t("onboarding.connect.title")} text={t("onboarding.connect.body")} />
    ) : (
      <Hero icon={<KeyRound size={40} />} title={t("onboarding.account.title")} text={t("onboarding.account.body")}>
        <div className={s.row}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              setPrefs({ onboardingDone: true });
              navigate("/auth/register");
            }}
          >
            {t("auth.register")}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setPrefs({ onboardingDone: true });
              navigate("/auth/signin");
            }}
          >
            {t("auth.signIn")}
          </Button>
        </div>
      </Hero>
    ),
  };

  return (
    <div className={s.screen}>
      <main className={s.panel} aria-labelledby="onboarding-title">
        <div className={s.progress} aria-label={t("onboarding.step", { current: i + 1, total: STEPS.length })}>
          {STEPS.map((k, n) => (
            <span key={k} className={s.dot} data-done={n <= i} />
          ))}
        </div>
        <div key={step} className={s.content}>
          {body[step]}
        </div>
        <div className={s.footer}>
          {i > 0 ? (
            <Button variant="ghost" onClick={() => setI(i - 1)}>
              {t("actions.back")}
            </Button>
          ) : (
            <span />
          )}
          <span className={s.stepText}>{t("onboarding.step", { current: i + 1, total: STEPS.length })}</span>
          <div className={s.row}>
            {i < STEPS.length - 1 ? (
              <Button variant="ghost" onClick={finish}>
                {t("actions.skip")}
              </Button>
            ) : null}
            <Button variant="primary" onClick={next}>
              {i === STEPS.length - 1 ? (signedIn ? t("onboarding.finish") : t("auth.continueOffline")) : t("actions.next")}
              {i === STEPS.length - 1 ? null : <ArrowRight size={16} aria-hidden />}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Hero({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <>
      <div className={s.heroIcon} aria-hidden>
        {icon}
      </div>
      <h1 id="onboarding-title" className={s.title}>
        {title}
      </h1>
      <p className={s.text}>{text}</p>
      {children}
    </>
  );
}
