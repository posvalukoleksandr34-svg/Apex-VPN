"use client";

import clsx from "clsx";
import { CreditCard, Globe, LayoutDashboard, MonitorSmartphone, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Messages } from "@/i18n/messages/en";
import s from "./shell.module.css";

const items = [
  { href: "/dashboard", key: "overview", Icon: LayoutDashboard },
  { href: "/devices", key: "devices", Icon: MonitorSmartphone },
  { href: "/servers", key: "servers", Icon: Globe },
  { href: "/billing", key: "billing", Icon: CreditCard },
  { href: "/account", key: "account", Icon: UserRound },
] as const;

/** `admin`: the label of the staff link, for admins only (the pages check again). */
export function NavLinks({ labels, admin }: { labels: Messages["nav"]; admin?: string }) {
  const path = usePathname();
  const links = [
    ...items.map(({ href, key, Icon }) => ({ href, label: labels[key], Icon })),
    ...(admin ? [{ href: "/admin", label: admin, Icon: ShieldCheck }] : []),
  ];
  return (
    <nav className={s.nav} aria-label={labels.menu}>
      {links.map(({ href, label, Icon }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className={clsx(s.navItem, active && s.active)} aria-current={active ? "page" : undefined}>
            <Icon size={17} aria-hidden />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
