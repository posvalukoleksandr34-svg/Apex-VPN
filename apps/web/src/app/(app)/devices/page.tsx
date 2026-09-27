import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { fmt } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { currentUser, userApi } from "@/lib/dal";
import { hasAccess } from "@/lib/plan";
import { getServers } from "@/lib/relays";
import { configurable } from "@/lib/servers";
import type { Device, Subscription } from "@/lib/types";
import { DevicesView } from "./DevicesView";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.devices.title };
}

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function DevicesPage({ searchParams }: { searchParams: Search }) {
  const [user, devices, sub, servers, { m, locale }, q] = await Promise.all([
    currentUser(),
    userApi<Device[]>("/v1/devices"),
    userApi<Subscription>("/v1/subscription"),
    getServers(),
    getI18n(),
    searchParams,
  ]);
  const limit = sub.deviceLimit ?? sub.plan?.deviceLimit ?? 0;
  const blocked = !user.emailVerified
    ? m.devices.needVerified
    : !hasAccess(sub)
      ? m.devices.needPlan
      : devices.length >= limit
        ? fmt(m.devices.limitReached, { limit })
        : null;
  const places = Object.fromEntries(servers.map((s) => [s.id, [s.city, s.country].filter(Boolean).join(", ")]));
  return (
    <>
      <PageHeader title={m.devices.title} subtitle={m.devices.subtitle} />
      <DevicesView
        devices={devices}
        servers={configurable(servers)}
        places={places}
        used={devices.length}
        limit={limit}
        blocked={blocked}
        openAdd={q.add === "1" && !blocked}
        preferServer={typeof q.server === "string" ? q.server : null}
        locale={locale}
        t={{ devices: m.devices, common: m.common, servers: m.servers }}
      />
    </>
  );
}
