import * as RRadio from "@radix-ui/react-radio-group";
import * as RSelect from "@radix-ui/react-select";
import * as RSwitch from "@radix-ui/react-switch";
import { Check, ChevronDown, Eye, EyeOff, Search } from "lucide-react";
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import s from "./Form.module.css";
import { useSlidingIndicator } from "./useSlidingIndicator";

export function Field({
  label,
  labelAction,
  hint,
  error,
  children,
  id,
}: {
  label: ReactNode;
  /** A small action on the label's line, right-aligned (e.g. "Forgot password?"). Kept outside <label>, so using it doesn't focus the input. */
  labelAction?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  const labelEl = (
    <label htmlFor={id} className={s.label}>
      {label}
    </label>
  );
  return (
    <div className={s.field}>
      {labelAction ? (
        <div className={s.labelRow}>
          {labelEl}
          {labelAction}
        </div>
      ) : (
        labelEl
      )}
      {children}
      {error ? (
        <span className={s.error} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className={s.hint} id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  labelAction?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ label, labelAction, hint, error, id, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} labelAction={labelAction} hint={hint} error={error} id={fid}>
      <input ref={ref} id={fid} className={s.input} aria-invalid={error ? true : undefined} aria-describedby={hint ? `${fid}-hint` : undefined} {...rest} />
    </Field>
  );
});

export function PasswordField(props: Omit<TextFieldProps, "type">) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const auto = useId();
  const id = props.id ?? auto;
  const { label, labelAction, hint, error, ...rest } = props;
  return (
    <Field label={label} labelAction={labelAction} hint={hint} error={error} id={id}>
      <div className={s.withIcon}>
        <input id={id} type={visible ? "text" : "password"} className={s.input} style={{ paddingRight: 40 }} aria-invalid={error ? true : undefined} {...rest} />
        <button
          type="button"
          className={s.suffix}
          onClick={() => setVisible((v) => !v)}
          aria-label={t(visible ? "common.hidePassword" : "common.showPassword")}
          title={t(visible ? "common.hidePassword" : "common.showPassword")}
          style={{ all: "unset", position: "absolute", right: 10, cursor: "pointer", color: "var(--text-subtle)", display: "flex" }}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </Field>
  );
}

export function TextArea({ label, hint, error, id, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} id={fid}>
      <textarea id={fid} className={s.input} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string }>(function SearchField({ label, ...rest }, ref) {
  return (
    <div className={s.withIcon}>
      <Search size={16} aria-hidden />
      <input ref={ref} type="search" className={s.input} aria-label={label} placeholder={label} {...rest} />
    </div>
  );
});

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange(v: boolean): void; disabled?: boolean; label: string }) {
  return (
    <RSwitch.Root className={s.switch} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label}>
      <RSwitch.Thumb className={s.thumb} />
    </RSwitch.Root>
  );
}

/** A labelled setting with an explanation and a control on the right. */
export function SettingRow({ label, description, children }: { label: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.settingRow}>
      <div className={s.settingText}>
        <div className={s.settingLabel}>{label}</div>
        {description ? <div className={s.settingDesc}>{description}</div> : null}
      </div>
      <div className={s.settingControl}>{children}</div>
    </div>
  );
}

/** Switch + label + description in one accessible row. */
export function SwitchRow({ label, description, checked, onCheckedChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onCheckedChange(v: boolean): void; disabled?: boolean }) {
  return (
    <SettingRow label={label} description={description}>
      <Switch label={label} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </SettingRow>
  );
}

export function Segmented<T extends string>({ value, onValueChange, options, label }: { value: T; onValueChange(v: T): void; options: { value: T; label: ReactNode }[]; label: string }) {
  const indicator = useSlidingIndicator<HTMLDivElement>('[role="radio"][data-state="checked"]', `${value}|${options.map((o) => o.value).join(",")}`);
  return (
    <RRadio.Root
      {...indicator}
      className={s.segmented}
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={label}
      orientation="horizontal"
    >
      <span className={s.segmentPill} aria-hidden />
      {options.map((o) => (
        <RRadio.Item key={o.value} value={o.value} className={s.segment}>
          {o.label}
        </RRadio.Item>
      ))}
    </RRadio.Root>
  );
}

export interface RadioCardOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export function RadioCards<T extends string>({ value, onValueChange, options, label }: { value: T; onValueChange(v: T): void; options: RadioCardOption<T>[]; label: string }) {
  return (
    <RRadio.Root className={s.radioCards} value={value} onValueChange={(v) => onValueChange(v as T)} aria-label={label}>
      {options.map((o) => (
        <RRadio.Item key={o.value} value={o.value} className={s.radioCard} disabled={o.disabled}>
          <span className={s.radioDot} aria-hidden />
          <span>
            <span className={s.radioTitle}>
              {o.title}
              {o.badge}
            </span>
            {o.description ? <span className={s.radioDesc}>{o.description}</span> : null}
          </span>
        </RRadio.Item>
      ))}
    </RRadio.Root>
  );
}

export function Select<T extends string>({ value, onValueChange, options, label, disabled }: { value: T; onValueChange(v: T): void; options: { value: T; label: ReactNode }[]; label: string; disabled?: boolean }) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <RSelect.Trigger className={s.selectTrigger} aria-label={label}>
        <RSelect.Value />
        <RSelect.Icon>
          <ChevronDown size={14} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className={s.selectContent} position="popper" sideOffset={4}>
          <RSelect.Viewport className={s.selectViewport}>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className={s.selectItem}>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator>
                  <Check size={14} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
