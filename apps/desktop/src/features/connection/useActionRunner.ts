import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { connect, disconnect, reconnect, subscriptionAllowsConnecting } from "@/app/actions";
import { transport } from "@/app/transportRef";
import { useConfirm, useToast } from "@/design";
import { ServiceError } from "@/protocol";
import { useApp } from "@/state/store";
import type { ActionId } from "./status";

/** Performs a status action (the dashboard button, tray, palette). */
export function useActionRunner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  return useCallback(
    async (action: ActionId) => {
      try {
        switch (action) {
          case "connect": {
            // Not linked to an account yet: connecting can only fail (and
            // would engage the kill switch), so go straight to sign-in.
            const { device, account } = useApp.getState();
            if (!device?.registration) {
              navigate(account.status === "signed_in" ? "/account/devices" : "/auth/signin");
              return;
            }
            // A plan we know has ended: say so and offer plans, instead of
            // an attempt the service would refuse anyway.
            if (account.subscription && !account.offline && !subscriptionAllowsConnecting(account.subscription)) {
              toast({ tone: "warning", title: t("account.subscription.renewTitle"), body: t("account.subscription.renewBody") });
              navigate("/account/subscription");
              return;
            }
            await connect();
            break;
          }
          case "retry":
            await reconnect();
            break;
          case "disconnect": {
            if (useApp.getState().prefs.confirmDisconnect) {
              const ok = await confirm({ title: t("actions.disconnect"), body: t("status.disconnected.detail"), confirmLabel: t("actions.disconnect") });
              if (!ok) return;
            }
            await disconnect();
            break;
          }
          case "cancel":
          case "unblock":
            await disconnect();
            break;
          case "reconnect_service":
            await transport().reconnectService();
            break;
          case "open_diagnostics":
            navigate("/diagnostics");
            break;
          case "kill_switch_settings":
            navigate("/settings/killSwitch");
            break;
          case "sign_in":
            navigate("/auth/signin");
            break;
          case "view_plans":
            navigate("/account/subscription");
            break;
        }
      } catch (e) {
        const message = e instanceof ServiceError && e.errorKind ? t(`errors.${e.errorKind}.title`) : (e as Error).message;
        toast({ tone: "error", title: t("common.somethingWrong"), body: message });
      }
    },
    [t, navigate, toast, confirm],
  );
}
