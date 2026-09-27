"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, ButtonLink, type Tone } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import type { ServerWithFlag } from "@/lib/relays";
import { searchServers } from "@/lib/servers";
import s from "./servers.module.css";

const tones: Record<ServerWithFlag["status"], Tone> = { online: "success", busy: "warning", maintenance: "neutral", offline: "error" };

export function ServerTable({ servers, t }: { servers: ServerWithFlag[]; t: { servers: Messages["servers"] } }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchServers(servers, query, t.servers.feature), [servers, query, t.servers.feature]);
  return (
    <div className={s.wrap}>
      <label className={s.search}>
        <Search size={16} aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.servers.search} aria-label={t.servers.search} autoFocus />
      </label>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{t.servers.location}</th>
              <th>{t.servers.server}</th>
              <th>{t.servers.state}</th>
              <th>{t.servers.load}</th>
              <th>{t.servers.features}</th>
              <th>
                <span className="visually-hidden">{t.servers.getConfig}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((srv) => (
              <tr key={srv.id}>
                <td>
                  <span className={s.place}>
                    {srv.flag ? <img src={srv.flag} width={21} height={14} alt="" className={s.flag} /> : <span className={s.flag} />}
                    <span>
                      <strong>{srv.country}</strong>
                      <span className={s.city}>{srv.city}</span>
                    </span>
                  </span>
                </td>
                <td className={s.mono}>{srv.hostname}</td>
                <td>
                  <Badge tone={tones[srv.status]}>{t.servers.status[srv.status]}</Badge>
                </td>
                <td>
                  {srv.load === null ? (
                    <span className={s.muted}>{t.servers.unmeasured}</span>
                  ) : (
                    <span className={s.load}>
                      <span className={s.loadBar}>
                        <span style={{ width: `${Math.min(100, srv.load)}%` }} />
                      </span>
                      {srv.load}%
                    </span>
                  )}
                </td>
                <td>
                  <span className={s.features}>
                    {srv.features.map((f) => (
                      <span key={f} className={s.feature}>
                        {(t.servers.feature as Record<string, string>)[f] ?? f}
                      </span>
                    ))}
                  </span>
                </td>
                <td className={s.action}>
                  {srv.wireguard && (srv.status === "online" || srv.status === "busy") && (
                    <ButtonLink href={`/devices?add=1&server=${encodeURIComponent(srv.id)}`} small>
                      {t.servers.getConfig}
                    </ButtonLink>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className={s.empty}>{fmt(t.servers.noMatch, { query })}</p>}
      </div>
    </div>
  );
}
