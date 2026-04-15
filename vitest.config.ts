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
          include: ["test/unit/**/*.test.ts"],
          // `groupOrder: 0` runs before the integration group; unset/equal
          // groupOrder values run in parallel per Vitest project-scheduling
          // docs, which would reintroduce the worker_thread/CPU contention
          // with integration tests. The two groups are disjoint file sets
          // so running them serially costs nothing meaningful.
          groupOrder: 0
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Integration tests spawn real node:worker_threads Workers and
          // child processes. Running them concurrently with each other (or
          // with the unit project) causes CPU/event-loop contention that
          // makes their timing-based predicates time out under CI load.
          // Force a single fork so all integration files share one process
          // and run one after the other, and give each test more headroom
          // than the unit default of 5s.
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true }
          },
          testTimeout: 30_000,
          hookTimeout: 30_000,
          groupOrder: 1
        }
      }
    ]
  }
});
