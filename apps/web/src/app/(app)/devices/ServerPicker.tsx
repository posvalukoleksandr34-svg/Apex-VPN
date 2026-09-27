"use client";

import clsx from "clsx";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import type { Messages } from "@/i18n/messages/en";
import type { ServerWithFlag } from "@/lib/relays";
import { searchServers } from "@/lib/servers";
import s from "./devices.module.css";

type T = { devices: Messages["devices"]; servers: Messages["servers"] };

/** Servers that take configs, best first; searchable by country, city, name or feature. */
export function ServerPicker({ servers, value, onChange, t }: { servers: ServerWithFlag[]; value: string; onChange: (id: string) => void; t: T }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchServers(servers, query, t.servers.feature), [servers, query, t.servers.feature]);
  const best = servers[0]?.id;
  return (
    <fieldset className={s.picker}>
      <legend className={s.pickerLegend}>{t.devices.dialog.server}</legend>
      <label className={s.search}>
        <Search size={15} aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.devices.dialog.searchServers} aria-label={t.devices.dialog.searchServers} />
      </label>
      <div className={s.options} role="radiogroup" aria-label={t.devices.dialog.server}>
        {shown.length === 0 && <p className={s.none}>{t.devices.dialog.noServers}</p>}
        {shown.map((srv) => (
          <label key={srv.id} className={clsx(s.option, srv.id === value && s.selected)}>
            <input type="radio" name="server" value={srv.id} checked={srv.id === value} onChange={() => onChange(srv.id)} />
            {srv.flag ? <img src={srv.flag} width={21} height={14} alt="" className={s.flag} /> : <span className={s.flag} />}
            <span className={s.optionMain}>
              <span>{[srv.city, srv.country].filter(Boolean).join(", ")}</span>
              <span className={s.optionSub}>{srv.hostname}</span>
            </span>
            {srv.id === best && <Badge tone="accent">{t.devices.dialog.recommended}</Badge>}
            <span className={s.optionLoad}>{srv.load === null ? t.servers.unmeasured : `${srv.load}%`}</span>
          </label>
        ))}
      </div>
      <span className={s.pickerHint}>{t.devices.dialog.serverHint}</span>
    </fieldset>
  );
}
