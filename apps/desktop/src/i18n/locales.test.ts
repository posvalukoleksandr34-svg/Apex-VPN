/**
 * Every language has every string, with the same placeholders, and every key
 * the code asks for exists. A missing key would show the raw key to users; a
 * missing placeholder would drop a value (a city, a countdown) silently.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./locales/de.json";
import en from "./locales/en.json";
import it_ from "./locales/it.json";
import ru from "./locales/ru.json";

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const EN = flatten(en as Tree);
const OTHERS = { ru, de, it: it_ } as Record<string, Tree>;

describe.each(Object.entries(OTHERS))("%s", (lang, tree) => {
  const strings = flatten(tree);

  it("has exactly the English keys", () => {
    expect([...strings.keys()].filter((k) => !EN.has(k)), "keys not in en.json").toEqual([]);
    expect([...EN.keys()].filter((k) => !strings.has(k)), `keys missing from ${lang}.json`).toEqual([]);
  });

  it("keeps every placeholder", () => {
    const wrong = [...EN].filter(([k, v]) => strings.has(k) && placeholders(v).join() !== placeholders(strings.get(k)!).join());
    expect(wrong.map(([k]) => k)).toEqual([]);
  });

  it("has no empty strings", () => {
    expect([...strings].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it("is actually translated", () => {
    // Brand names, units and protocol names legitimately stay the same;
    // a file that is mostly English was copied, not translated.
    const same = [...EN].filter(([k, v]) => strings.get(k) === v && /[a-z]{4,}/.test(v)).length;
    expect(same / EN.size).toBeLessThan(0.1);
  });
});

describe("keys used in code", () => {
  const root = join(__dirname, "..");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("generated"))
    .map((f) => ({ name: relative(root, join(root, f)), text: readFileSync(join(root, f), "utf8") }));
  const namespaces = Object.keys(en).join("|");
  // Any string literal shaped like a key in one of our namespaces, whether
  // passed straight to t() or stored in a table and translated later.
  const literal = new RegExp(`["'\`]((?:${namespaces})\\.[A-Za-z0-9_\\-]+(?:\\.[A-Za-z0-9_\\-]+|\\.\\$\\{[^}]+\\})*(?:\\.\\$\\{[^}]+\\})?)["'\`]`, "g");
  const dynamic = new RegExp(`\`((?:${namespaces})\\.[^\`]*\\$\\{[^\`]*)\``, "g");

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every literal key exists", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const { name, text } of files) {
      for (const [, key] of text.matchAll(literal)) {
        if (key!.includes("${")) continue;
        checked++;
        if (!EN.has(key!) && ![...EN.keys()].some((k) => k.startsWith(`${key}.`))) missing.push(`${name}: ${key}`);
      }
    }
    // A pattern that matches nothing would pass vacuously.
    expect(checked).toBeGreaterThan(500);
    expect(missing).toEqual([]);
  });

  it("every template key can resolve to something", () => {
    const dead: string[] = [];
    let checked = 0;
    for (const { name, text } of files) {
      for (const [, tpl] of text.matchAll(dynamic)) {
        checked++;
        const pattern = new RegExp(`^${tpl!.split(/\$\{[^}]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]+")}(\\..+)?$`);
        if (![...EN.keys()].some((k) => pattern.test(k))) dead.push(`${name}: ${tpl}`);
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(dead).toEqual([]);
  });
});
