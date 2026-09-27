import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_ENV_KEYS } from "./env";

const named = (path: string) =>
  [...readFileSync(fileURLToPath(new URL(`../../../../env/${path}`, import.meta.url)), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

describe("settings templates", () => {
  it("name every variable the dashboard reads, and nothing else", () => {
    expect([...new Set(named("production/web.env.example"))].sort()).toEqual([...WEB_ENV_KEYS].sort());
    expect(named("development/web.env.example").filter((k) => !WEB_ENV_KEYS.includes(k))).toEqual([]);
  });
});
