import { defineConfig } from "vitest/config";
import path from "path";
import { moduleDir } from "./shared/moduleDir";

const templateRoot = moduleDir(import.meta.url);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "shared/**/*.test.ts",
      "shared/**/*.spec.ts",
      // Client-side units only; files needing a DOM opt in via a
      // `@vitest-environment jsdom` pragma rather than slowing the whole suite.
      "client/src/lib/**/*.test.ts",
      "client/src/components/**/*.test.ts",
    ],
  },
});
