import * as RDialog from "@radix-ui/react-dialog";
import * as RMenu from "@radix-ui/react-dropdown-menu";
import * as RPopover from "@radix-ui/react-popover";
import * as RToast from "@radix-ui/react-toast";
import * as RTooltip from "@radix-ui/react-tooltip";
import { clsx } from "clsx";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import s from "./Overlay.module.css";

// ── Tooltip ──────────────────────────────────────────────────────────────

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <RTooltip.Root delayDuration={350}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className={s.tooltip}>
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;

// ── Dialog ───────────────────────────────────────────────────────────────

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: DialogProps) {
  const { t } = useTranslation();
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className={s.overlay} />
        <RDialog.Content className={clsx(s.dialog, wide && s.wide)} aria-describedby={description ? undefined : undefined}>
          <div className={s.dialogHeader}>
            <div>
              <RDialog.Title className={s.dialogTitle}>{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className={s.dialogDescription}>{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{typeof title === "string" ? title : ""}</RDialog.Description>
              )}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label={t("actions.close")} icon={<X size={16} />} />
            </RDialog.Close>
          </div>
          {children ? <div className={s.dialogBody}>{children}</div> : null}
          {footer ? <div className={s.dialogFooter}>{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) …` */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<(ConfirmOptions & { resolve(v: boolean): void }) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog
        open={!!state}
        onOpenChange={(o) => !o && close(false)}
        title={state?.title ?? ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t("actions.cancel")}
            </Button>
            <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? t("actions.confirm")}
            </Button>
          </>
        }
      >
        <div style={{ color: "var(--text-muted)" }}>{state?.body}</div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

// ── Dropdown menu ────────────────────────────────────────────────────────

export function Menu({ trigger, children, align = "end" }: { trigger: ReactElement; children: ReactNode; align?: "start" | "end" }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className={s.menu} align={align} sideOffset={6}>
          {children}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export function MenuItem({ children, onSelect, icon, danger, disabled }: { children: ReactNode; onSelect(): void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <RMenu.Item className={s.menuItem} onSelect={onSelect} data-danger={danger || undefined} disabled={disabled}>
      {icon}
      {children}
    </RMenu.Item>
  );
}

export const MenuSeparator = () => <RMenu.Separator className={s.menuSeparator} />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <RMenu.Label className={s.menuLabel}>{children}</RMenu.Label>;

// ── Popover ──────────────────────────────────────────────────────────────

export function Popover({ trigger, children, open, onOpenChange }: { trigger: ReactElement; children: ReactNode; open?: boolean; onOpenChange?(o: boolean): void }) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content className={s.popover} align="end" sideOffset={8}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────

type Tone = "success" | "error" | "warning" | "neutral" | "pending";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const TONE_ICON: Record<Tone, ReactNode> = {
  success: <CircleCheck size={18} />,
  error: <CircleAlert size={18} />,
  warning: <TriangleAlert size={18} />,
  neutral: <Info size={18} />,
  pending: <Info size={18} />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    setItems((xs) => [...xs.slice(-3), { ...t, id: Date.now() + Math.random() }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      <RToast.Provider swipeDirection="right" duration={4500}>
        {children}
        {items.map((it) => (
          <RToast.Root
            key={it.id}
            className={s.toast}
            data-tone={it.tone}
            type={it.tone === "error" ? "foreground" : "background"}
            onOpenChange={(open) => !open && setItems((xs) => xs.filter((x) => x.id !== it.id))}
          >
            <span className={s.toastIcon} aria-hidden>
              {TONE_ICON[it.tone]}
            </span>
            <div>
              <RToast.Title className={s.toastTitle}>{it.title}</RToast.Title>
              {it.body ? <RToast.Description className={s.toastBody}>{it.body}</RToast.Description> : null}
            </div>
          </RToast.Root>
        ))}
        <RToast.Viewport className={s.toastViewport} />
      </RToast.Provider>
    </ToastContext.Provider>
  );
}
