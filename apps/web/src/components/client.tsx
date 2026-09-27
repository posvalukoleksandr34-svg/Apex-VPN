"use client";

import clsx from "clsx";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "./ui";
import s from "./client.module.css";

/** A form's submit button: disabled, with a spinner, while the action runs. */
export function SubmitButton({
  children,
  working,
  variant = "primary",
  block,
  small,
  disabled,
  ...props
}: ComponentProps<"button"> & { working: string; variant?: "primary" | "secondary" | "danger" | "ghost"; block?: boolean; small?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button {...props} type="submit" className={buttonClass(variant, { block, small })} disabled={pending || disabled} aria-busy={pending || undefined}>
      {pending ? (
        <>
          <LoaderCircle size={16} className={s.spin} aria-hidden />
          {working}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** A modal on the native <dialog>: focus trap, Escape and backdrop come with it. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={clsx(s.dialog, wide && s.wide)}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className={s.dialogBody}>
          <h2>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={buttonClass("secondary", { small: true })}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? copiedLabel : label}
    </button>
  );
}
