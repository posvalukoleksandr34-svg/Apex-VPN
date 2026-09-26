import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfirmProvider, ToastProvider } from "@/design";
import i18n from "@/i18n";
import type { ServiceStatus } from "@/platform/transport";
import type { TunnelState } from "@/protocol";
import { useApp } from "@/state/store";
import { allStates } from "@/test/fixtures";
import { StatusHero } from "./StatusHero";

const initial = useApp.getState();

function show(service: ServiceStatus, tunnel: TunnelState | null) {
  act(() => useApp.setState({ service, tunnel }));
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <StatusHero />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => useApp.setState(initial, true));
});

describe("StatusHero", () => {
  it.each(allStates(Date.now()).map((s) => [s.name, s.state] as const))("renders %s without raw keys", (_, state) => {
    const { container, unmount } = show("ready", state);
    const headline = screen.getByRole("heading", { level: 1 });
    expect(headline.textContent).not.toMatch(/^[a-z]+\.[a-zA-Z_.]+$/);
    expect(container.textContent).not.toMatch(/\b(status|errors|phase|cause|actions)\.[a-z_]+/);
    // "Protected" is reserved for a verified tunnel.
    expect(headline.textContent === "Protected").toBe(state.state === "connected");
    unmount();
  });

  it("shows the connected location and a disconnect button", () => {
    const state = allStates().find((s) => s.name === "connected")!.state;
    show("ready", state);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Protected");
    expect(screen.getByText("Connected through Frankfurt, Germany")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("flags blocked traffic and offers to unblock after a failure", () => {
    show("ready", { state: "error", error: { kind: "handshake_timeout", detail: "no reply in 10s", at: Date.now() }, blocking: true });
    expect(screen.getByText("Traffic blocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect and unblock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("never claims protection when the service is down", () => {
    const state = allStates().find((s) => s.name === "connected")!.state;
    show("unavailable", state);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("VPN service isn't running");
    expect(screen.queryByText("Protected")).toBeNull();
  });

  it("renders in Russian", async () => {
    await act(() => i18n.changeLanguage("ru"));
    show("ready", { state: "disconnected", lockedDown: false });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Не защищено");
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
  });
});
