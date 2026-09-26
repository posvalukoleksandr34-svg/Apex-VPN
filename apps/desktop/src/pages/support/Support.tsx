import * as RAccordion from "@radix-ui/react-accordion";
import { ChevronDown, Gauge, Globe, Paperclip, PlugZap, Send, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { transport } from "@/app/transportRef";
import { Banner, Button, Card, Dialog, IconButton, Page, PageHeader, SearchField, Select, Switch, TabPanel, Tabs, TextArea, TextField, useToast } from "@/design";
import { authenticationCheck } from "@/features/diagnostics/report";
import { apiErrorMessage } from "@/lib/errors";
import type { PickedFile } from "@/platform/transport";
import { useApp } from "@/state/store";
import { HELP_ARTICLES } from "./articles";
import s from "./Support.module.css";

const TABS = ["help", "faq", "troubleshooting", "contact"] as const;

export default function Support() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab = "help" } = useParams<{ tab: (typeof TABS)[number] }>();
  return (
    <Page>
      <PageHeader title={t("support.title")} />
      <Tabs label={t("support.title")} value={tab} onValueChange={(v) => navigate(`/support/${v}`)} items={TABS.map((k) => ({ value: k, label: t(`support.tabs.${k}`) }))}>
        <TabPanel value="help">
          <Help />
        </TabPanel>
        <TabPanel value="faq">
          <Faq />
        </TabPanel>
        <TabPanel value="troubleshooting">
          <Troubleshooting />
        </TabPanel>
        <TabPanel value="contact">
          <Contact />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

function Help() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const articles = HELP_ARTICLES.filter((a) => !q || `${t(`support.articles.${a}.title`)} ${t(`support.articles.${a}.body`)}`.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    const id = window.location.hash.split("#")[2];
    if (id) document.getElementById(`article-${id}`)?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <>
      <div style={{ maxWidth: 420, marginBottom: "var(--space-5)" }}>
        <SearchField label={t("support.searchHelp")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className={s.articles}>
        {articles.map((a) => (
          <article key={a} id={`article-${a}`} className={s.article}>
            <h2 className={s.articleTitle}>{t(`support.articles.${a}.title`)}</h2>
            <p className={s.articleBody}>{t(`support.articles.${a}.body`)}</p>
          </article>
        ))}
      </div>
    </>
  );
}

function Faq() {
  const { t } = useTranslation();
  return (
    <RAccordion.Root type="multiple" className={s.faq}>
      {[1, 2, 3, 4, 5].map((n) => (
        <RAccordion.Item key={n} value={`q${n}`} className={s.faqItem}>
          <RAccordion.Header asChild>
            <h3 style={{ margin: 0 }}>
              <RAccordion.Trigger className={s.faqTrigger}>
                {t(`support.faq.q${n}`)}
                <ChevronDown size={16} className={s.faqChevron} aria-hidden />
              </RAccordion.Trigger>
            </h3>
          </RAccordion.Header>
          <RAccordion.Content className={s.faqContent}>{t(`support.faq.a${n}`)}</RAccordion.Content>
        </RAccordion.Item>
      ))}
    </RAccordion.Root>
  );
}

function Troubleshooting() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const guides = [
    { key: "cantConnect", icon: <PlugZap size={20} /> },
    { key: "slow", icon: <Gauge size={20} /> },
    { key: "noInternet", icon: <Globe size={20} /> },
    { key: "sitesBlock", icon: <ShieldAlert size={20} /> },
  ];
  return (
    <>
      <p className={s.intro}>{t("support.troubleshooting.intro")}</p>
      <div className={s.guides}>
        {guides.map((g) => (
          <Card key={g.key}>
            <div className={s.guideHead}>
              <span className={s.guideIcon} aria-hidden>
                {g.icon}
              </span>
              <h2 className={s.articleTitle}>{t(`support.troubleshooting.${g.key}.title`)}</h2>
            </div>
            <p className={s.articleBody}>{t(`support.troubleshooting.${g.key}.body`)}</p>
            <Button size="sm" onClick={() => navigate(g.key === "slow" ? "/servers" : "/diagnostics")} style={{ marginTop: "var(--space-3)" }}>
              {g.key === "slow" ? t("actions.browse") : t("support.troubleshooting.runChecks")}
            </Button>
          </Card>
        ))}
      </div>
    </>
  );
}

function Contact() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const signedIn = useApp((st) => st.account.status === "signed_in");
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("connection");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [includeReport, setIncludeReport] = useState(!!params.get("report"));
  const [report, setReport] = useState<unknown | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = subject.trim().length >= 3 && description.trim().length >= 10;

  const buildReport = async () => {
    const state = useApp.getState();
    const checks = state.service === "ready" ? await transport().call("run_diagnostics", { checks: null }).catch(() => []) : [];
    const auth = await authenticationCheck(state);
    const r = {
      appVersion: transport().app.version,
      serviceVersion: state.capabilities?.serviceVersion ?? null,
      os: state.capabilities?.os ?? null,
      tunnelState: state.tunnel?.state ?? null,
      checks: [...checks, auth],
    };
    setReport(r);
    return r;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const diagnosticReport = includeReport ? (report ?? (await buildReport())) : null;
      const ticket = await transport().account.createTicket({
        subject: subject.trim(),
        category,
        description: description.trim(),
        attachmentPaths: files.map((f) => f.path),
        diagnosticReport,
      });
      toast({ tone: "success", title: t("support.contact.sent", { number: ticket.number }) });
      setSubject("");
      setDescription("");
      setFiles([]);
    } catch (e) {
      setError(apiErrorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const previewText = useMemo(() => (report ? JSON.stringify(report, null, 2) : ""), [report]);

  if (!signedIn) {
    return (
      <Card>
        <Banner
          tone="accent"
          action={
            <Button size="sm" variant="primary" onClick={() => navigate("/auth/signin")}>
              {t("actions.sign_in")}
            </Button>
          }
        >
          {t("support.contact.signInRequired")}
        </Banner>
      </Card>
    );
  }

  return (
    <Card>
      <p className={s.intro}>{t("support.contact.intro")}</p>
      <div className={s.form}>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <TextField label={t("support.contact.subject")} value={subject} maxLength={140} onChange={(e) => setSubject(e.target.value)} />
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{t("support.contact.category")}</span>
          <Select
            label={t("support.contact.category")}
            value={category}
            onValueChange={setCategory}
            options={(["connection", "billing", "account", "privacy", "other"] as const).map((c) => ({ value: c, label: t(`support.categories.${c}`) }))}
          />
        </div>
        <TextArea label={t("support.contact.description")} hint={t("support.contact.descriptionHint")} value={description} maxLength={10_000} onChange={(e) => setDescription(e.target.value)} />
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button
              size="sm"
              icon={<Paperclip size={14} />}
              disabled={files.length >= 5}
              onClick={async () => {
                const picked = await transport().app.pickFiles();
                setFiles((prev) => [...prev, ...picked.filter((p) => p.size <= 10 * 1024 * 1024)].slice(0, 5));
              }}
            >
              {t("support.contact.attach")}
            </Button>
            <span className={s.hint}>{t("support.contact.attachHint")}</span>
          </div>
          {files.length ? (
            <ul className={s.files}>
              {files.map((f) => (
                <li key={f.path}>
                  <Paperclip size={12} aria-hidden /> {f.name}
                  <IconButton size="sm" label={t("actions.remove")} icon={<X size={12} />} onClick={() => setFiles(files.filter((x) => x.path !== f.path))} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className={s.reportRow}>
          <Switch label={t("support.contact.includeReport")} checked={includeReport} onCheckedChange={setIncludeReport} />
          <div style={{ flex: 1 }}>
            <div>{t("support.contact.includeReport")}</div>
            <div className={s.hint}>{t("support.contact.includeReportHint")}</div>
          </div>
          {includeReport ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!report) await buildReport();
                setPreview(true);
              }}
            >
              {t("support.contact.preview")}
            </Button>
          ) : null}
        </div>
        <div>
          <Button variant="primary" icon={<Send size={16} />} loading={busy} disabled={!valid} onClick={submit}>
            {t("support.contact.submit")}
          </Button>
        </div>
      </div>
      <Dialog open={preview} onOpenChange={setPreview} title={t("support.contact.preview")} wide>
        <pre className={s.preview}>{previewText}</pre>
      </Dialog>
    </Card>
  );
}
