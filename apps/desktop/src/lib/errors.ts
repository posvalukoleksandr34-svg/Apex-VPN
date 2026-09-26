import type { TFunction } from "i18next";
import { ServiceError } from "@/protocol";
import { ApiFailure } from "@/platform/transport";

/** A user-facing message for anything thrown by the transport. */
export function apiErrorMessage(t: TFunction, e: unknown): string {
  if (e instanceof ApiFailure) {
    const key = `apiErrors.${e.code}`;
    return t(key, { defaultValue: t("apiErrors.generic") });
  }
  if (e instanceof ServiceError) {
    return e.errorKind ? t(`errors.${e.errorKind}.title`) : e.message;
  }
  return t("apiErrors.generic");
}
