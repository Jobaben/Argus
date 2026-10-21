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
    // Ratcheted to just under the current numbers, so coverage can only go
    // up: a change that drops it fails CI rather than quietly eroding.
    thresholds: { lines: 80, functions: 76, branches: 85, statements: 80 },
  },
};

/**
 * Whether a module loads with the first paint: the entry imports it, or a
 * module that does. Walked up the static importers only; a module reached
 * solely through `import()` belongs to a lazy chunk.
 */
function eagerTest(getModuleInfo: (id: string) => { importers: string[] } | null) {
  const known = new Map<string, boolean>();
  const eager = (id: string, path: Set<string>): boolean => {
    const hit = known.get(id);
    if (hit !== undefined) return hit;
    if (/[\\/]src[\\/]main\.tsx$/.test(id)) return true;
    if (path.has(id)) return false;
    path.add(id);
    const result = (getModuleInfo(id)?.importers ?? []).some((by) => eager(by, path));
    path.delete(id);
    // Only a settled answer is kept: inside a cycle a "no" may be provisional.
    if (result || path.size === 0) known.set(id, result);
    return result;
  };
  return (id: string) => eager(id, new Set());
}

// One walk per build: a watch rebuild hands over a new graph, and a new ctx.
let eager: { ctx: unknown; is: (id: string) => boolean } | undefined;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Everything the first paint needs, in one file. Left to the
              // automatic splitter, each small module a lazy view shares with
              // the board (a formatter, a status table, a hook) became its own
              // chunk: the first paint fetched 21 files, the browser queued
              // them six at a time, and the app started ~30 ms later than with
              // 12. The bytes are the same; only the round trips go.
              name: (id, ctx) => {
                if (eager?.ctx !== ctx) eager = { ctx, is: eagerTest((m) => ctx.getModuleInfo(m)) };
                return eager.is(id) ? "shell" : null;
              },
            },
          ],
        },
      },
    },
  },
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
