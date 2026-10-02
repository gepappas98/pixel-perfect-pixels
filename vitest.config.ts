import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules", "dist", ".output"],
    // TanStack Start / SSR modules: single-fork pool ώστε τα lazy `import()`
    // (π.χ. `admin()`) να μπορούν να φορτώσουν τα server modules χωρίς
    // worker isolation issues.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
