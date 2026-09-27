import clsx from "clsx";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Badge, buttonClass, Notice, PageHeader } from "@/components/ui";
import { fmt, formatDate } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { ApiFailure } from "@/lib/api";
import { requireAdmin, userApi } from "@/lib/dal";
import { statusTone } from "@/lib/plan";
import { ADMIN_FILTERS, type AdminFilter, type AdminUserPage } from "@/lib/types";
import s from "./admin.module.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.admin.title };
}

type Search = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZE = 25;

export default async function AdminAccounts({ searchParams }: { searchParams: Search }) {
  await requireAdmin();
  const [{ m, locale }, q] = await Promise.all([getI18n(), searchParams]);
  const query = typeof q.q === "string" ? q.q.trim().slice(0, 254) : "";
  const filter: AdminFilter = (ADMIN_FILTERS as readonly string[]).includes(String(q.filter)) ? (q.filter as AdminFilter) : "all";
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const params = new URLSearchParams({ filter, page: String(page), pageSize: String(PAGE_SIZE), ...(query ? { q: query } : {}) });

  let data: AdminUserPage;
  try {
    data = await userApi<AdminUserPage>(`/v1/admin/users?${params}`);
  } catch (e) {
    if (e instanceof ApiFailure && e.code === "admin_mfa_required") return <Notice tone="warning">{m.admin.mfaRequired}</Notice>;
    throw e;
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const link = (p: number) => `/admin?${new URLSearchParams({ ...(query ? { q: query } : {}), filter, page: String(p) })}`;

  return (
    <>
      <PageHeader title={m.admin.title} subtitle={fmt(m.admin.count, { count: data.total })} />
      <Form action="/admin" className={s.filters}>
        <input className={s.search} type="search" name="q" defaultValue={query} placeholder={m.admin.search} aria-label={m.admin.search} maxLength={254} />
        <label className={s.show}>
          <span>{m.admin.show}</span>
          <select name="filter" defaultValue={filter}>
            {ADMIN_FILTERS.map((f) => (
              <option key={f} value={f}>
                {m.admin.filters[f]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass("primary")}>
          {m.admin.apply}
        </button>
      </Form>

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{m.admin.email}</th>
              <th>{m.admin.subscription}</th>
              <th>{m.admin.devices}</th>
              <th>{m.admin.joined}</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/admin/users/${u.id}`} className={s.email}>
                    {u.email}
                  </Link>
                  <span className={s.tags}>
                    {u.role === "admin" && <Badge tone="accent">{m.admin.staff}</Badge>}
                    {u.isBanned && <Badge tone="error">{m.admin.banned}</Badge>}
                    {!u.emailVerified && <Badge tone="neutral">{m.admin.unverified}</Badge>}
                  </span>
                </td>
                <td>
                  {u.subscription ? (
                    <span className={s.stack}>
                      <Badge tone={statusTone(u.subscription.status)}>{m.status[u.subscription.status]}</Badge>
                      <span className={s.sub}>
                        {(m.billing.planNames as Record<string, string>)[u.subscription.planId] ?? u.subscription.planName} · {u.subscription.provider}
                      </span>
                    </span>
                  ) : (
                    <Badge tone="neutral">{m.status.none}</Badge>
                  )}
                </td>
                <td className={s.num}>
                  {u.devices}
                  {u.deviceLimit !== null && <span className={s.sub}> / {u.deviceLimit}</span>}
                </td>
                <td className={s.sub}>{formatDate(locale, u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.users.length === 0 && <p className={s.empty}>{m.admin.noResults}</p>}
      </div>

      {pages > 1 && (
        <nav className={s.pager} aria-label={fmt(m.admin.page, { page, pages })}>
          <Link href={link(page - 1)} className={clsx(buttonClass("secondary", { small: true }), page <= 1 && s.off)} aria-disabled={page <= 1 || undefined}>
            {m.admin.previous}
          </Link>
          <span className={s.sub}>{fmt(m.admin.page, { page, pages })}</span>
          <Link href={link(page + 1)} className={clsx(buttonClass("secondary", { small: true }), page >= pages && s.off)} aria-disabled={page >= pages || undefined}>
            {m.admin.next}
          </Link>
        </nav>
      )}
    </>
  );
}
