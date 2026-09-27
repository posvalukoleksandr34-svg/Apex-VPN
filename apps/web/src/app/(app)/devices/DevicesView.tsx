"use client";

import { AlertTriangle, Download, KeyRound, Laptop, Monitor, Pencil, Plus, Router, Smartphone, Trash2 } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createDevice, removeDevice, renameDevice, replaceDeviceKey, type DeviceResult } from "@/app/actions/devices";
import { CopyButton, Dialog } from "@/components/client";
import { Badge, Button, Card, Field, Meter, Notice, SelectField, ui } from "@/components/ui";
import { fmt, formatDate } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import type { ServerWithFlag } from "@/lib/relays";
import { DEVICE_PLATFORMS, type Device, type DevicePlatform } from "@/lib/types";
import { buildConfig, configFileName, generateKeyPair } from "@/lib/wireguard";
import { ServerPicker } from "./ServerPicker";
import s from "./devices.module.css";

type T = { devices: Messages["devices"]; common: Messages["common"]; servers: Messages["servers"] };

interface Props {
  devices: Device[];
  servers: ServerWithFlag[];
  places: Record<string, string>;
  used: number;
  limit: number;
  blocked: string | null;
  openAdd: boolean;
  preferServer: string | null;
  locale: string;
  t: T;
}

type Modal = { kind: "add" } | { kind: "rename" | "remove" | "newConfig"; device: Device } | null;
interface Result {
  name: string;
  config: string;
  fileName: string;
}

const icons: Record<string, typeof Smartphone> = { ios: Smartphone, android: Smartphone, windows: Laptop, macos: Laptop, linux: Laptop, router: Router };

export function DevicesView(p: Props) {
  const { t } = p;
  const [modal, setModal] = useState<Modal>(p.openAdd ? { kind: "add" } : null);
  const [result, setResult] = useState<Result | null>(null);
  const close = () => {
    setModal(null);
    setResult(null); // the private key goes with it
    // Opened from a link (?add=1): don't reopen on reload.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  };

  return (
    <>
      <Card
        title={fmt(t.devices.counter, { used: p.used, limit: p.limit })}
        actions={
          <Button variant="primary" disabled={!!p.blocked} onClick={() => setModal({ kind: "add" })}>
            <Plus size={16} aria-hidden />
            {t.devices.add}
          </Button>
        }
      >
        <Meter value={p.used} max={p.limit} label={t.devices.title} />
        {p.blocked && <Notice tone="neutral">{p.blocked}</Notice>}
      </Card>

      {p.devices.length === 0 ? (
        <Card>
          <p className={ui.muted}>{t.devices.empty}</p>
        </Card>
      ) : (
        <ul className={s.list}>
          {p.devices.map((d) => {
            const Icon = icons[d.platform] ?? Monitor;
            const byApp = d.appVersion !== null;
            return (
              <li key={d.id} className={s.device}>
                <span className={s.deviceIcon}>
                  <Icon size={20} aria-hidden />
                </span>
                <div className={s.deviceMain}>
                  <div className={ui.row}>
                    <strong>{d.name}</strong>
                    {d.connected ? (
                      <Badge tone="success">{d.connectedServerId && p.places[d.connectedServerId] ? fmt(t.devices.connectedTo, { server: p.places[d.connectedServerId]! }) : t.devices.connected}</Badge>
                    ) : (
                      <Badge tone="neutral">{t.devices.notConnected}</Badge>
                    )}
                  </div>
                  <span className={ui.subtle}>
                    {(t.devices.platforms as Record<string, string>)[d.platform] ?? d.platform} · {fmt(t.devices.added, { date: formatDate(p.locale, d.createdAt) })} ·{" "}
                    {fmt(t.devices.lastSeen, { date: formatDate(p.locale, d.lastSeenOn) })}
                  </span>
                  <span className={ui.subtle}>
                    {t.devices.address}: <code>{d.ipv4Address}</code>
                    {byApp && <> · {t.devices.appManaged}</>}
                  </span>
                </div>
                <div className={s.deviceActions}>
                  {!byApp && (
                    <Button small onClick={() => setModal({ kind: "newConfig", device: d })} disabled={p.servers.length === 0}>
                      <KeyRound size={14} aria-hidden />
                      {t.devices.newConfig}
                    </Button>
                  )}
                  <Button small variant="ghost" onClick={() => setModal({ kind: "rename", device: d })} aria-label={`${t.common.rename}: ${d.name}`}>
                    <Pencil size={14} aria-hidden />
                  </Button>
                  <Button small variant="ghost" onClick={() => setModal({ kind: "remove", device: d })} aria-label={`${t.common.remove}: ${d.name}`}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={modal?.kind === "add"} onClose={close} title={result ? result.name : t.devices.dialog.title} wide>
        {result ? (
          <ConfigResult result={result} onDone={close} t={t} />
        ) : (
          <AddDevice servers={p.servers} prefer={p.preferServer} onCreated={setResult} onCancel={close} t={t} />
        )}
      </Dialog>

      <Dialog open={modal?.kind === "newConfig"} onClose={close} title={modal && "device" in modal ? fmt(t.devices.newConfigTitle, { name: modal.device.name }) : ""} wide>
        {modal?.kind === "newConfig" &&
          (result ? (
            <ConfigResult result={result} onDone={close} t={t} />
          ) : (
            <NewConfig device={modal.device} servers={p.servers} onCreated={setResult} onCancel={close} t={t} />
          ))}
      </Dialog>

      <Dialog open={modal?.kind === "rename"} onClose={close} title={t.devices.renameTitle}>
        {modal?.kind === "rename" && <Rename device={modal.device} onDone={close} t={t} />}
      </Dialog>

      <Dialog open={modal?.kind === "remove"} onClose={close} title={modal && "device" in modal ? fmt(t.devices.removeTitle, { name: modal.device.name }) : ""}>
        {modal?.kind === "remove" && <Remove device={modal.device} onDone={close} t={t} />}
      </Dialog>
    </>
  );
}

/** Makes a key pair here, registers only the public key, then builds the config. */
async function makeConfig(
  name: string,
  server: ServerWithFlag,
  register: (publicKey: string) => Promise<DeviceResult>,
): Promise<{ ok: true; result: Result } | { ok: false; error: string }> {
  const keys = generateKeyPair();
  const res = await register(keys.publicKey);
  if (!res.ok) return res;
  const config = buildConfig({
    privateKey: keys.privateKey,
    ipv4Address: res.registration.ipv4Address,
    ipv6Address: res.registration.ipv6Address,
    server: server.wireguard!,
  });
  return { ok: true, result: { name, config, fileName: configFileName(server.id) } };
}

function AddDevice({ servers, prefer, onCreated, onCancel, t }: { servers: ServerWithFlag[]; prefer: string | null; onCreated: (r: Result) => void; onCancel: () => void; t: T }) {
  const [serverId, setServerId] = useState(() => servers.find((x) => x.id === prefer)?.id ?? servers[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const platform = String(form.get("platform") ?? "other") as DevicePlatform;
        const server = servers.find((x) => x.id === serverId);
        if (!server) return setError(t.devices.errors.no_server);
        setError(null);
        start(async () => {
          const r = await makeConfig(name, server, (publicKey) => createDevice({ name, platform, publicKey }));
          if (r.ok) onCreated(r.result);
          else setError(r.error);
        });
      }}
    >
      <p className={ui.muted}>{t.devices.dialog.intro}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className={s.twoCols}>
        <Field label={t.devices.dialog.name} name="name" placeholder={t.devices.dialog.namePlaceholder} maxLength={64} required autoFocus />
        <SelectField label={t.devices.dialog.type} name="platform" defaultValue="ios">
          {DEVICE_PLATFORMS.map((pl) => (
            <option key={pl} value={pl}>
              {t.devices.platforms[pl]}
            </option>
          ))}
        </SelectField>
      </div>
      <ServerPicker servers={servers} value={serverId} onChange={setServerId} t={t} />
      <div className={s.buttons}>
        <Button onClick={onCancel}>{t.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={pending || !serverId}>
          {pending ? t.devices.dialog.creating : t.devices.dialog.create}
        </Button>
      </div>
    </form>
  );
}

function NewConfig({ device, servers, onCreated, onCancel, t }: { device: Device; servers: ServerWithFlag[]; onCreated: (r: Result) => void; onCancel: () => void; t: T }) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className={s.form}>
      <Notice tone="warning">{t.devices.newConfigBody}</Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <ServerPicker servers={servers} value={serverId} onChange={setServerId} t={t} />
      <div className={s.buttons}>
        <Button onClick={onCancel}>{t.common.cancel}</Button>
        <Button
          variant="primary"
          disabled={pending || !serverId}
          onClick={() => {
            const server = servers.find((x) => x.id === serverId);
            if (!server) return setError(t.devices.errors.no_server);
            start(async () => {
              const r = await makeConfig(device.name, server, (publicKey) => replaceDeviceKey(device.id, publicKey));
              if (r.ok) onCreated(r.result);
              else setError(r.error);
            });
          }}
        >
          {pending ? t.devices.dialog.creating : t.devices.dialog.create}
        </Button>
      </div>
    </div>
  );
}

function ConfigResult({ result, onDone, t }: { result: Result; onDone: () => void; t: T }) {
  const [qr, setQr] = useState<string | null>(null);
  const href = useMemo(() => URL.createObjectURL(new Blob([result.config], { type: "text/plain" })), [result.config]);
  useEffect(() => () => URL.revokeObjectURL(href), [href]);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(result.config, { errorCorrectionLevel: "M", margin: 2, width: 280, color: { dark: "#000000", light: "#ffffff" } }).then((url) => {
      if (live) setQr(url);
    });
    return () => {
      live = false;
    };
  }, [result.config]);
  return (
    <div className={s.form}>
      <Notice tone="warning">{t.devices.dialog.keyWarning}</Notice>
      <div className={s.result}>
        <figure className={s.qr}>
          {qr ? <img src={qr} width={280} height={280} alt={t.devices.dialog.scan} /> : <div className={s.qrPlaceholder} />}
          <figcaption className={ui.subtle}>{t.devices.dialog.scan}</figcaption>
        </figure>
        <div className={s.configBox}>
          <span className={ui.subtle}>{t.devices.dialog.configFile}</span>
          <pre className={s.config}>{result.config}</pre>
          <div className={ui.row}>
            <a className={`${ui.button} ${ui.secondary} ${ui.small}`} href={href} download={result.fileName}>
              <Download size={14} aria-hidden />
              {t.devices.dialog.download}
            </a>
            <CopyButton text={result.config} label={t.common.copy} copiedLabel={t.common.copied} />
          </div>
        </div>
      </div>
      <div className={s.buttons}>
        <Button variant="primary" onClick={onDone}>
          {t.devices.dialog.done}
        </Button>
      </div>
    </div>
  );
}

function Rename({ device, onDone, t }: { device: Device; onDone: () => void; t: T }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        const name = String(new FormData(e.currentTarget).get("name") ?? "");
        start(async () => {
          const r = await renameDevice(device.id, name);
          if (r.ok) onDone();
          else setError(r.error);
        });
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <Field label={t.devices.name} name="name" defaultValue={device.name} maxLength={64} required autoFocus />
      <div className={s.buttons}>
        <Button onClick={onDone}>{t.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? t.common.working : t.common.save}
        </Button>
      </div>
    </form>
  );
}

function Remove({ device, onDone, t }: { device: Device; onDone: () => void; t: T }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className={s.form}>
      <p className={s.warnLine}>
        <AlertTriangle size={16} aria-hidden />
        {t.devices.removeBody}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className={s.buttons}>
        <Button onClick={onDone}>{t.common.cancel}</Button>
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await removeDevice(device.id);
              if (r.ok) onDone();
              else setError(r.error);
            })
          }
        >
          {pending ? t.common.working : t.common.remove}
        </Button>
      </div>
    </div>
  );
}
