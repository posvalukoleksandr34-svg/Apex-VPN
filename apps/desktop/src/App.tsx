import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router";
import { ConfirmProvider, ToastProvider, TooltipProvider } from "@/design";
import { AppShell } from "@/shell/AppShell";
import { useApp } from "@/state/store";
import { Dashboard } from "@/pages/dashboard/Dashboard";

// Everything but the dashboard loads on first visit.
const Servers = lazy(() => import("@/pages/servers/Servers"));
const Profiles = lazy(() => import("@/pages/profiles/Profiles"));
const Security = lazy(() => import("@/pages/security/Security"));
const Diagnostics = lazy(() => import("@/pages/diagnostics/Diagnostics"));
const SettingsPage = lazy(() => import("@/pages/settings/Settings"));
const Support = lazy(() => import("@/pages/support/Support"));
const Account = lazy(() => import("@/pages/account/Account"));
const Auth = lazy(() => import("@/pages/auth/Auth"));
const Onboarding = lazy(() => import("@/pages/onboarding/Onboarding"));

export function App({ transportKind }: { transportKind: "tauri" | "simulator" }) {
  const onboardingDone = useApp((s) => s.prefs.onboardingDone);
  return (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <HashRouter>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/welcome" element={<Onboarding />} />
                <Route path="/auth/:mode" element={<Auth />} />
                <Route element={<AppShell simulator={transportKind === "simulator"} />}>
                  <Route index element={onboardingDone ? <Dashboard /> : <Navigate to="/welcome" replace />} />
                  <Route path="servers" element={<Servers />} />
                  <Route path="profiles" element={<Profiles />} />
                  <Route path="security/:tab?" element={<Security />} />
                  <Route path="diagnostics/:tab?" element={<Diagnostics />} />
                  <Route path="settings/:section?" element={<SettingsPage />} />
                  <Route path="support/:tab?" element={<Support />} />
                  <Route path="account/:tab?" element={<Account />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </HashRouter>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
