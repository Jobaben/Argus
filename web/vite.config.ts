import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { InlineConfig } from "vitest/node";

const SERVER_PORT = process.env.ARGUS_PORT ?? "7777";

const testConfig: InlineConfig = {
  environment: "jsdom",
  globals: true,
  setupFiles: ["./src/test/setup.ts"],
  css: true,
  coverage: {
    provider: "v8",
    include: ["src/**/*.{ts,tsx}"],
    exclude: ["src/**/*.test.*", "src/test/**", "src/main.tsx", "src/vite-env.d.ts"],
    thresholds: { lines: 50, functions: 50, branches: 75, statements: 50 },
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5757,
    proxy: {
      "/api": { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  // @ts-expect-error vitest 3.x + vite 8 type mismatch; config is correct at runtime
  test: testConfig,
});
