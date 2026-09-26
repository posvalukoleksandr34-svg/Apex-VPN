import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings } from "@/app/actions";
import { useToast } from "@/design";
import type { Settings, SettingsPatch } from "@/protocol";
import { useApp } from "@/state/store";

/** Service settings plus a save that reports success or the service's validation error. */
export function useServiceSettings(): { settings: Settings | null; save(patch: Partial<SettingsPatch>): Promise<boolean> } {
  const { t } = useTranslation();
  const toast = useToast();
  const settings = useApp((s) => s.settings);
  const save = useCallback(
    async (patch: Partial<SettingsPatch>) => {
      try {
        await updateSettings(patch);
        toast({ tone: "success", title: t("settings.saved") });
        return true;
      } catch (e) {
        toast({ tone: "error", title: t("settings.saveFailed", { error: (e as Error).message }) });
        return false;
      }
    },
    [t, toast],
  );
  return { settings, save };
}
