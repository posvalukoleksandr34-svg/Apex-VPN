import { describe, expect, it } from "vitest";
import { de } from "./messages/de";
import { en } from "./messages/en";
import { it as italian } from "./messages/it";
import { ru } from "./messages/ru";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const source = new Map(leaves(en));

describe.each([
  ["ru", ru],
  ["de", de],
  ["it", italian],
])("%s", (_name, messages) => {
  const entries = leaves(messages as Tree);

  it("has every key, and only those", () => {
    expect(entries.map(([k]) => k).sort()).toEqual([...source.keys()].sort());
  });

  it("keeps every placeholder", () => {
    for (const [key, value] of entries) {
      expect(placeholders(value), key).toEqual(placeholders(source.get(key)!));
    }
  });

  it("is translated, not copied", () => {
    // Longer sentences identical to English were missed; short terms (Email, P2P, Online…) may match.
    const copied = entries.filter(([key, value]) => value.length > 24 && value === source.get(key)).map(([key]) => key);
    expect(copied).toEqual([]);
  });
});
