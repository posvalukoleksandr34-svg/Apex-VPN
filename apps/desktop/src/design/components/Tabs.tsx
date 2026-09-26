import * as RTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import s from "./Tabs.module.css";
import { useSlidingIndicator } from "./useSlidingIndicator";

/** Underlined tabs. `items` render the triggers; children are `<TabPanel>`s. */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  children,
}: {
  value: T;
  onValueChange(v: T): void;
  items: { value: T; label: ReactNode }[];
  label: string;
  children: ReactNode;
}) {
  const indicator = useSlidingIndicator<HTMLDivElement>('[role="tab"][data-state="active"]', `${value}|${items.map((i) => i.value).join(",")}`);
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as T)}>
      <RTabs.List {...indicator} className={s.list} aria-label={label}>
        {items.map((it) => (
          <RTabs.Trigger key={it.value} value={it.value} className={s.tab}>
            {it.label}
          </RTabs.Trigger>
        ))}
        <span className={s.underline} aria-hidden />
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RTabs.Content value={value} className={s.panel}>
      {children}
    </RTabs.Content>
  );
}
