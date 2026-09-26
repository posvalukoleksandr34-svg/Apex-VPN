import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file gets its own in-memory PostgreSQL; argon2 hashing is
    // deliberately slow, so give the suite room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
