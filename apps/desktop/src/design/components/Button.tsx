import { clsx } from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import s from "./Button.module.css";
import { Tooltip } from "./Overlay";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", block, loading, icon, children, className, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(s.button, s[variant], size !== "md" && s[size], block && s.block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={s.spinner} aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  /** Accessible name, also shown as a tooltip. */
  label: string;
  icon: ReactNode;
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", tooltip = true, className, ...rest },
  ref,
) {
  const button = (
    <Button ref={ref} variant={variant} size={size} className={clsx(s.icon, size === "sm" && s.sm, className)} aria-label={label} {...rest}>
      {icon}
    </Button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
});
