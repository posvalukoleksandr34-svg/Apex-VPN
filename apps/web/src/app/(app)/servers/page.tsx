import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { fmt } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { getServers } from "@/lib/relays";
import { ServerTable } from "./ServerTable";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.servers.title };
}

export default async function ServersPage() {
  const [servers, { m }] = await Promise.all([getServers(), getI18n()]);
  const countries = new Set(servers.map((s) => s.countryCode)).size;
  return (
    <>
      <PageHeader title={m.servers.title} subtitle={fmt(m.servers.subtitle, { count: servers.length, countries })} />
      <ServerTable servers={servers} t={{ servers: m.servers }} />
    </>
  );
}
