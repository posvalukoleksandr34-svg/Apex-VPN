// Rebuilds src/protocol/generated/index.ts from the files ts-rs wrote.
// Run via `npm run protocol` (which regenerates the types first).
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "protocol", "generated");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => f.slice(0, -3))
  .sort();
const lines = [
  "// Barrel for the ts-rs output in this folder. Regenerate with: npm run protocol:index",
  ...names.map((n) => `export type { ${n} } from "./${n}";`),
];
writeFileSync(join(dir, "index.ts"), lines.join("\n") + "\n");
console.log(`protocol index: ${names.length} types`);
