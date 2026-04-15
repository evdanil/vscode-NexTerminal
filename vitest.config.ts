import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/extension.ts"]
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Integration tests spawn real node:worker_threads Workers and child
          // processes; running them concurrently with each other (and with the
          // 70+ unit test files) causes CPU/event-loop contention that makes
          // their timing-based predicates time out under CI load. Force a
          // single fork so they run one file at a time, and give each test
          // more headroom than the unit default of 5s.
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true }
          },
          testTimeout: 30_000,
          hookTimeout: 30_000
        }
      }
    ]
  }
});
