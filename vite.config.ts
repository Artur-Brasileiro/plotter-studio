/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// base relativa: o mesmo build funciona no GitHub Pages (/plotter-studio/) e em localhost.
export default defineConfig({
  base: "./",
  test: {
    include: ["src/**/*.test.ts"],
  },
});
