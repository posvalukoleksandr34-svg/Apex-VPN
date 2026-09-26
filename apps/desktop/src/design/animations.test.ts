/**
 * CSS Modules renames every animation name in a module to a scoped one. A
 * module that uses a keyframe from global.css without `global(...)` ends up
 * pointing at a keyframe that doesn't exist, so the animation never runs.
 * For exit animations that is worse than no motion: Radix keeps a closing
 * menu, popover or dialog mounted until its animation ends, so it never
 * closes. This test keeps every reference resolvable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const KEYWORDS = new Set([
  "none", "normal", "reverse", "alternate", "alternate-reverse", "infinite", "forwards", "backwards", "both",
  "running", "paused", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "initial", "inherit", "unset",
]);

const keyframesIn = (css: string) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!));
const globalKeyframes = keyframesIn(readFileSync(join(root, "design", "global.css"), "utf8"));
const modules = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".module.css"))
  .map((f) => ({ name: relative(root, join(root, f)), css: readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));

describe("animation names in CSS modules", () => {
  it("finds the shared keyframes and the modules", () => {
    expect(globalKeyframes.has("spring-in")).toBe(true);
    expect(modules.length).toBeGreaterThan(10);
  });

  it("every animation resolves to a keyframe that exists", () => {
    const problems: string[] = [];
    let references = 0;
    for (const { name, css } of modules) {
      const local = keyframesIn(css);
      for (const [, value] of css.matchAll(/animation(?:-name)?\s*:([^;]+);/g)) {
        for (const [, g] of value!.matchAll(/global\(([\w-]+)\)/g)) {
          references++;
          if (!globalKeyframes.has(g!)) problems.push(`${name}: global(${g}) is not defined in global.css`);
        }
        const rest = value!.replace(/global\([\w-]+\)/g, " ").replace(/[\w-]+\([^()]*(\([^()]*\)[^()]*)*\)/g, " ");
        for (const token of rest.split(/[\s,]+/)) {
          if (!/^[a-z][\w-]*$/i.test(token) || KEYWORDS.has(token)) continue;
          references++;
          if (!local.has(token)) {
            problems.push(globalKeyframes.has(token) ? `${name}: "${token}" is a shared keyframe; write global(${token})` : `${name}: no keyframes named "${token}"`);
          }
        }
      }
    }
    expect(references).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });
});
