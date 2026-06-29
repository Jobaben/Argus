# Argus Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Argus's ad-hoc Tailwind styling with a formal design system — one token layer, one status model, a typed component library in `web/src/ds/`, all views restyled, plus a new Command Center kanban board.

**Architecture:** Tokens are registered in Tailwind v4's `@theme` block so the app keeps using utility classes (`bg-surface`, `text-run`). A single `ds/status.ts` module owns every status→color decision, killing the duplicated maps. Components are ported faithfully from the `design-system/` HTML gallery into typed React components. Work ships in phases (Foundation → Primitives → Views → Command Center → Gallery retirement), each independently shippable with the app working throughout.

**Tech Stack:** React 19, Tailwind CSS v4 (`@tailwindcss/vite`), Vite 8, TypeScript ~6, Vitest + @testing-library/react + jsdom (added in Task 1).

## Global Constraints

- **No backend changes.** Argus stays a pure reader of `~/.claude`. No server/, no new data sources.
- **Dark-only.** Keep `color-scheme: dark` in `index.css`. No light theme.
- **The eye is brand-only.** `--color-eye` (`#36e3e8`) is used for the brand mark and the "live" indicator only. Status meaning always uses run/ok/fail/queue/idle/await.
- **Mono is the telemetry voice.** `font-mono` for IDs, timestamps, counts, ETAs, status labels, section labels. `font-sans` (Hellix) for names, headings, body.
- **No status color outside `ds/status.ts`.** No component hardcodes a status color; no `STATUS_STYLE` maps; no `amber/emerald/rose/slate/sky` status utilities; no `bg-white/[0.0x]` glass surfaces.
- **Every animation has a `prefers-reduced-motion: reduce` off-switch.** Mandatory, enforced in review.
- **Tabular numerals** (`tabular-nums`) on any live-updating number.
- Spec reference: `docs/superpowers/specs/2026-06-26-argus-design-system-design.md`.
- Run all commands from repo root. Web workspace commands use `npm -w @argus/web run <script>`.

---

## File Structure

**New — design system library (`web/src/ds/`):**
- `status.ts` — `DsStatus`, `STATUS` record, `toDsStatus()`. The single status source of truth.
- `format.ts` — `formatDuration()` (ETA), `sparklinePoints()` (SVG math).
- `IrisMark.tsx` — animated canvas brand mark + reduced-motion static fallback.
- `StatusPill.tsx`, `ConnectionPill.tsx`, `HealthCounter.tsx`, `Sparkline.tsx`,
  `AgentTile.tsx`, `SchedulerRow.tsx`, `AlertStrip.tsx`, `ActivityEvent.tsx` — components.
- `Card.tsx`, `Section.tsx`, `EmptyState.tsx`, `TimeAgo.tsx` — surface/layout primitives (migrated from `components/ui.tsx`).
- `pipeline.ts` — `PipelineState`/`PipelinePhase`/`PipelineTile` types.
- `usePipeline.ts` — stub hook returning mock `PipelineState`.
- `index.ts` — barrel re-export for the library.

**New — Command Center view:**
- `web/src/views/CommandCenter.tsx`.

**Modified:**
- `web/src/index.css` — `@theme` tokens, `@font-face`, keyframes, reduced-motion base.
- `web/vite.config.ts` — Vitest config.
- `web/package.json` — test deps + `test` script.
- `web/src/App.tsx` — nav shell (wordmark + `IrisMark` + `ConnectionPill`), remove `STATUS_STYLE`, `AgentTile` for Agents, add Command Center tab.
- `web/src/components/ui.tsx` — emptied; re-exports from `ds/` during transition, then deleted.
- `web/src/views/*` — migrated onto `ds/` components and tokens.

**New — fonts:**
- `web/public/fonts/Hellix-Regular-ma.woff2`, `Hellix-SemiBold-ma.woff2`, `Hellix-Bold-webfont.woff2` (moved from `design-system/fonts/`).

**Removed (Phase 4):**
- `design-system/`.

---

# Phase 0 — Foundation

## Task 1: Test infrastructure (Vitest + Testing Library)

**Files:**
- Modify: `web/package.json` (devDependencies + `test` script)
- Modify: `web/vite.config.ts`
- Create: `web/src/test/setup.ts`
- Create: `web/src/ds/smoke.test.ts` (throwaway proof; deleted in Step 6)

**Interfaces:**
- Produces: `npm -w @argus/web run test` runs Vitest in jsdom with `@testing-library/jest-dom` matchers.

- [ ] **Step 1: Install test dependencies**

Run:
```bash
npm -w @argus/web install -D vitest@^3 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

- [ ] **Step 2: Add the `test` script to `web/package.json`**

In the `"scripts"` block add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Configure Vitest in `web/vite.config.ts`**

Add a `test` key to the `defineConfig` object (after `server`):
```ts
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
```
Also add this reference comment at the top of the file so TS picks up Vitest globals:
```ts
/// <reference types="vitest/config" />
```

- [ ] **Step 4: Create the setup file `web/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Write a smoke test `web/src/ds/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("test infra", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run it, confirm green, then delete the smoke test**

Run: `npm -w @argus/web run test`
Expected: 1 passing test.
Then: `rm web/src/ds/smoke.test.ts`

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json package-lock.json web/vite.config.ts web/src/test/setup.ts
git commit -m "test(web): add Vitest + Testing Library infrastructure"
```

---

## Task 2: Token layer + keyframes + reduced-motion base

**Files:**
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: Tailwind utilities `bg-ground|ground-2|surface|surface-2`, `border-line`, `text-ink|ink-dim|ink-faint`, `text-eye`, `text-run|ok|fail|queue|idle|await`, `font-sans|mono`, `rounded-tile|panel`. CSS keyframes `pulse`, `sweep`, `ping-ring`.

- [ ] **Step 1: Replace `web/src/index.css` with the token layer**

```css
@import "tailwindcss";

@theme {
  /* Ground & surfaces */
  --color-ground: #0a0f16;
  --color-ground-2: #0c121b;
  --color-surface: #121b26;
  --color-surface-2: #16212e;
  --color-line: rgb(146 180 217 / 0.14);

  /* Ink ramp */
  --color-ink: #eaf2fb;
  --color-ink-dim: #9db0c6;
  --color-ink-faint: #62748b;

  /* Brand accent — eye (brand + "live" only) */
  --color-eye: #36e3e8;

  /* Semantic status */
  --color-run: #ffb224;
  --color-ok: #2fe6a4;
  --color-fail: #ff5765;
  --color-queue: #4db5ff;
  --color-idle: #7c8aa0;
  --color-await: #b585ff;

  /* Type */
  --font-sans: "Hellix", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;

  /* Radius */
  --radius-tile: 12px;
  --radius-panel: 14px;
}

:root {
  color-scheme: dark;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background: var(--color-ground);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes sweep {
  0% { left: -42%; }
  100% { left: 100%; }
}
@keyframes ping-ring {
  0% { transform: scale(0.6); opacity: 0.5; }
  80%, 100% { transform: scale(2.4); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

- [ ] **Step 2: Verify the build picks up the tokens**

Run: `npm -w @argus/web run build`
Expected: build succeeds (tsc + vite). The app still renders (existing views use old utility classes that still resolve; status colors look unchanged until Phase 1).

- [ ] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "feat(ds): add design-system token layer and motion keyframes"
```

---

## Task 3: Hellix fonts

**Files:**
- Create: `web/public/fonts/Hellix-Regular-ma.woff2`, `Hellix-SemiBold-ma.woff2`, `Hellix-Bold-webfont.woff2` (copied from `design-system/fonts/`)
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: `font-family: "Hellix"` resolves to the bundled faces (400/600/700).

> **License gate:** Hellix is a commercial typeface. Confirm a web/embedding license covers shipping these woff2 files before this task ships. If unconfirmed, skip this task — the `--font-sans` fallback stack (`"Segoe UI", system-ui, …`) keeps the app fully functional, and later tasks are unaffected. The decorative `Hellix-Bilia-SemiBold.woff2` referenced by the type gallery is absent; do not attempt to load it.

- [ ] **Step 1: Copy the three woff2 files into the web public dir**

```bash
mkdir -p web/public/fonts
cp "design-system/fonts/Hellix-Regular-ma.woff2" web/public/fonts/
cp "design-system/fonts/Hellix-SemiBold-ma.woff2" web/public/fonts/
cp "design-system/fonts/Hellix-Bold-webfont.woff2" web/public/fonts/
```

- [ ] **Step 2: Add `@font-face` declarations to `web/src/index.css`**

Insert immediately after the `@import "tailwindcss";` line:
```css
@font-face {
  font-family: "Hellix";
  src: url("/fonts/Hellix-Regular-ma.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Hellix";
  src: url("/fonts/Hellix-SemiBold-ma.woff2") format("woff2");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Hellix";
  src: url("/fonts/Hellix-Bold-webfont.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 3: Verify**

Run: `npm -w @argus/web run dev`, open http://localhost:5757, confirm body text renders in Hellix (rounded geometric sans, distinct from system UI). Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add web/public/fonts web/src/index.css
git commit -m "feat(ds): bundle Hellix typeface and font-face declarations"
```

---

## Task 4: IrisMark brand component

**Files:**
- Create: `web/src/ds/IrisMark.tsx`
- Test: `web/src/ds/IrisMark.test.tsx`

**Interfaces:**
- Produces: `<IrisMark size?: number />` — renders a `<canvas>` (default 28px) with an animated iris; under `prefers-reduced-motion` it draws one static frame.

- [ ] **Step 1: Write the failing render test `web/src/ds/IrisMark.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { IrisMark } from "./IrisMark";

describe("IrisMark", () => {
  it("renders a sized canvas", () => {
    const { container } = render(<IrisMark size={40} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("width", "40");
    expect(canvas).toHaveAttribute("height", "40");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- IrisMark`
Expected: FAIL — cannot resolve `./IrisMark`.

- [ ] **Step 3: Implement `web/src/ds/IrisMark.tsx`**

```tsx
import { useEffect, useRef } from "react";

const AGENTS = [
  { a: 0.5, r: 0.86, c: "54,227,232" },
  { a: 1.55, r: 0.62, c: "54,227,232" },
  { a: 2.4, r: 0.9, c: "255,178,36" },
  { a: 3.3, r: 0.7, c: "54,227,232" },
  { a: 4.2, r: 0.88, c: "255,87,101" },
  { a: 5.25, r: 0.58, c: "47,230,164" },
];

export function IrisMark({ size = 28 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W * 0.46;
    const TAU = Math.PI * 2;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    function draw(t: number) {
      ctx.clearRect(0, 0, W, H);
      // outer ring
      ctx.strokeStyle = "rgba(54,227,232,0.55)";
      ctx.lineWidth = Math.max(1, W * 0.03);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      // pupil
      ctx.fillStyle = "#36e3e8";
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.22, 0, TAU);
      ctx.fill();
      // orbiting tracked agents
      for (const g of AGENTS) {
        const ang = g.a + (reduce ? 0 : t * 0.0006);
        const x = cx + Math.cos(ang) * R * g.r;
        const y = cy + Math.sin(ang) * R * g.r;
        ctx.fillStyle = `rgb(${g.c})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2, W * 0.045), 0, TAU);
        ctx.fill();
      }
    }

    if (reduce) {
      draw(0);
      return;
    }
    let raf = 0;
    let start = 0;
    const loop = (ts: number) => {
      if (!start) start = ts;
      draw(ts - start);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- IrisMark`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/IrisMark.tsx web/src/ds/IrisMark.test.tsx
git commit -m "feat(ds): add animated IrisMark brand component"
```

---

# Phase 1 — Primitives & status model

## Task 5: Status model (`ds/status.ts`) — the single source of truth

**Files:**
- Create: `web/src/ds/status.ts`
- Test: `web/src/ds/status.test.ts`

**Interfaces:**
- Consumes: `AgentStatus` from `web/src/types.ts`.
- Produces:
  - `type DsStatus = "working" | "done" | "failed" | "queued" | "idle" | "await"`
  - `interface StatusToken { token: "run"|"ok"|"fail"|"queue"|"idle"|"await"; label: string; glow: boolean }`
  - `const STATUS: Record<DsStatus, StatusToken>`
  - `function toDsStatus(s: AgentStatus): DsStatus`

- [ ] **Step 1: Write the failing test `web/src/ds/status.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { STATUS, toDsStatus } from "./status";

describe("STATUS record", () => {
  it("maps each status to its color token", () => {
    expect(STATUS.working.token).toBe("run");
    expect(STATUS.done.token).toBe("ok");
    expect(STATUS.failed.token).toBe("fail");
    expect(STATUS.queued.token).toBe("queue");
    expect(STATUS.idle.token).toBe("idle");
    expect(STATUS.await.token).toBe("await");
  });

  it("glows only for working, failed, await", () => {
    expect(STATUS.working.glow).toBe(true);
    expect(STATUS.failed.glow).toBe(true);
    expect(STATUS.await.glow).toBe(true);
    expect(STATUS.done.glow).toBe(false);
    expect(STATUS.queued.glow).toBe(false);
    expect(STATUS.idle.glow).toBe(false);
  });

  it('labels "await" as "Needs approval"', () => {
    expect(STATUS.await.label).toBe("Needs approval");
  });
});

describe("toDsStatus", () => {
  it("passes through known statuses", () => {
    expect(toDsStatus("working")).toBe("working");
    expect(toDsStatus("done")).toBe("done");
    expect(toDsStatus("failed")).toBe("failed");
    expect(toDsStatus("queued")).toBe("queued");
    expect(toDsStatus("idle")).toBe("idle");
  });

  it("folds stopped and unknown into idle", () => {
    expect(toDsStatus("stopped")).toBe("idle");
    expect(toDsStatus("unknown")).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- status`
Expected: FAIL — cannot resolve `./status`.

- [ ] **Step 3: Implement `web/src/ds/status.ts`**

```ts
import type { AgentStatus } from "../types";

export type DsStatus =
  | "working"
  | "done"
  | "failed"
  | "queued"
  | "idle"
  | "await";

export type ColorToken = "run" | "ok" | "fail" | "queue" | "idle" | "await";

export interface StatusToken {
  /** Tailwind color token name (text-<token>, bg-<token>, etc.). */
  token: ColorToken;
  /** Human-facing label. */
  label: string;
  /** Whether this status emits a glow on rails/badges. */
  glow: boolean;
}

export const STATUS: Record<DsStatus, StatusToken> = {
  working: { token: "run", label: "Working", glow: true },
  done: { token: "ok", label: "Done", glow: false },
  failed: { token: "fail", label: "Failed", glow: true },
  queued: { token: "queue", label: "Queued", glow: false },
  idle: { token: "idle", label: "Idle", glow: false },
  await: { token: "await", label: "Needs approval", glow: true },
};

export function toDsStatus(s: AgentStatus): DsStatus {
  switch (s) {
    case "working":
    case "done":
    case "failed":
    case "queued":
    case "idle":
      return s;
    case "stopped":
    case "unknown":
    default:
      return "idle";
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- status`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/status.ts web/src/ds/status.test.ts
git commit -m "feat(ds): add single-source status model with await state"
```

---

## Task 6: Format helpers (`ds/format.ts`)

**Files:**
- Create: `web/src/ds/format.ts`
- Test: `web/src/ds/format.test.ts`

**Interfaces:**
- Produces:
  - `function formatDuration(ms: number): string` — compact ETA: `"12m"`, `"7h 41m"`, `"2d 14h"`, `"now"` for <=0.
  - `function sparklinePoints(values: number[], width?: number, height?: number): string` — SVG polyline `points` scaled to `width`×`height` (default 100×26), y inverted so larger values sit higher.

- [ ] **Step 1: Write the failing test `web/src/ds/format.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { formatDuration, sparklinePoints } from "./format";

describe("formatDuration", () => {
  it("renders minutes under an hour", () => {
    expect(formatDuration(12 * 60_000)).toBe("12m");
  });
  it("renders hours and minutes under a day", () => {
    expect(formatDuration((7 * 60 + 41) * 60_000)).toBe("7h 41m");
  });
  it("renders days and hours past a day", () => {
    expect(formatDuration((2 * 24 * 60 + 14 * 60) * 60_000)).toBe("2d 14h");
  });
  it('returns "now" for non-positive input', () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5000)).toBe("now");
  });
});

describe("sparklinePoints", () => {
  it("maps a flat series to the vertical mid-line", () => {
    expect(sparklinePoints([5, 5, 5], 100, 26)).toBe("0,13 50,13 100,13");
  });
  it("puts the max at the top (y=0) and min at the bottom", () => {
    expect(sparklinePoints([0, 10], 100, 26)).toBe("0,26 100,0");
  });
  it("returns empty string for empty input", () => {
    expect(sparklinePoints([], 100, 26)).toBe("");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- format`
Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 3: Implement `web/src/ds/format.ts`**

```ts
export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function sparklinePoints(
  values: number[],
  width = 100,
  height = 26,
): string {
  const n = values.length;
  if (n === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * width;
      // y inverted: max -> 0 (top), min -> height (bottom); flat -> midline
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- format`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/format.ts web/src/ds/format.test.ts
git commit -m "feat(ds): add formatDuration and sparklinePoints helpers"
```

---

## Task 7: Surface & layout primitives (`Card`, `Section`, `EmptyState`, `TimeAgo`)

**Files:**
- Create: `web/src/ds/Card.tsx`, `web/src/ds/Section.tsx`, `web/src/ds/EmptyState.tsx`, `web/src/ds/TimeAgo.tsx`
- Test: `web/src/ds/primitives.test.tsx`

**Interfaces:**
- Produces:
  - `<Card className? children />` — `bg-surface border-line rounded-tile` panel.
  - `<Section title children className? />` — mono uppercase label + content.
  - `<EmptyState children />` — dashed-border centered placeholder.
  - `<TimeAgo iso />` — relative time in `text-ink-faint`.

- [ ] **Step 1: Write the failing test `web/src/ds/primitives.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";
import { Section } from "./Section";
import { EmptyState } from "./EmptyState";

describe("primitives", () => {
  it("Card renders children on a surface", () => {
    const { container } = render(<Card>hi</Card>);
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-surface");
  });
  it("Section shows its title and children", () => {
    render(<Section title="Watch">body</Section>);
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
  it("EmptyState renders its message", () => {
    render(<EmptyState>nothing here</EmptyState>);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- primitives`
Expected: FAIL — cannot resolve `./Card`.

- [ ] **Step 3: Implement the four primitives**

`web/src/ds/Card.tsx`:
```tsx
import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-tile border border-line bg-surface p-4 transition hover:border-ink-faint/40 ${className}`}
    >
      {children}
    </div>
  );
}
```

`web/src/ds/Section.tsx`:
```tsx
import type { ReactNode } from "react";

export function Section({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 ${className}`}>
      <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}
```

`web/src/ds/EmptyState.tsx`:
```tsx
import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-tile border border-dashed border-line px-6 py-16 text-center text-ink-faint">
      {children}
    </div>
  );
}
```

`web/src/ds/TimeAgo.tsx`:
```tsx
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  return (
    <span className="font-mono text-ink-faint" title={iso ?? undefined}>
      {relativeTime(iso)}
    </span>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- primitives`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/Card.tsx web/src/ds/Section.tsx web/src/ds/EmptyState.tsx web/src/ds/TimeAgo.tsx web/src/ds/primitives.test.tsx
git commit -m "feat(ds): add surface and layout primitives on tokens"
```

---

## Task 8: `StatusPill`

**Files:**
- Create: `web/src/ds/StatusPill.tsx`
- Test: `web/src/ds/StatusPill.test.tsx`

**Interfaces:**
- Consumes: `DsStatus`, `STATUS` from `./status`.
- Produces: `<StatusPill status: DsStatus />` — mono uppercase pill colored by token; `await` shows a pulsing dot.

- [ ] **Step 1: Write the failing test `web/src/ds/StatusPill.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill status="working" />);
    expect(screen.getByText("Working")).toBeInTheDocument();
  });
  it('shows "Needs approval" for await', () => {
    render(<StatusPill status="await" />);
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- StatusPill`
Expected: FAIL — cannot resolve `./StatusPill`.

- [ ] **Step 3: Implement `web/src/ds/StatusPill.tsx`**

Tailwind needs literal class strings, so map token → classes explicitly:
```tsx
import { STATUS, type DsStatus, type ColorToken } from "./status";

const PILL: Record<ColorToken, string> = {
  run: "text-run bg-run/12",
  ok: "text-ok bg-ok/12",
  fail: "text-fail bg-fail/14",
  queue: "text-queue bg-queue/12",
  idle: "text-idle bg-idle/12",
  await: "text-await bg-await/14",
};

export function StatusPill({ status }: { status: DsStatus }) {
  const { token, label } = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-current px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.13em] ${PILL[token]}`}
    >
      {status === "await" && (
        <span className="h-1.5 w-1.5 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-current shadow-[0_0_8px_1px_currentColor]" />
      )}
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- StatusPill`
Expected: PASS.

- [ ] **Step 5: Visual parity check**

Compare against `design-system/components/status-pill/index.html` (open both). Pills match color/casing; `await` pulses; under reduced-motion the dot is static.

- [ ] **Step 6: Commit**

```bash
git add web/src/ds/StatusPill.tsx web/src/ds/StatusPill.test.tsx
git commit -m "feat(ds): add StatusPill driven by status model"
```

---

## Task 9: `ConnectionPill`

**Files:**
- Create: `web/src/ds/ConnectionPill.tsx`
- Test: `web/src/ds/ConnectionPill.test.tsx`

**Interfaces:**
- Produces: `<ConnectionPill live: boolean />` — `live` → eye-colored "Live" with ping dot; otherwise "Reconnecting…" in idle.

- [ ] **Step 1: Write the failing test `web/src/ds/ConnectionPill.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionPill } from "./ConnectionPill";

describe("ConnectionPill", () => {
  it("shows Live when connected", () => {
    render(<ConnectionPill live />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
  it("shows Reconnecting when down", () => {
    render(<ConnectionPill live={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- ConnectionPill`
Expected: FAIL — cannot resolve `./ConnectionPill`.

- [ ] **Step 3: Implement `web/src/ds/ConnectionPill.tsx`**

```tsx
export function ConnectionPill({ live }: { live: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.08em] ${
        live
          ? "border-ok/40 bg-ok/10 text-ok"
          : "border-idle/40 bg-idle/10 text-idle"
      }`}
    >
      <span className="relative h-2 w-2 rounded-full bg-current">
        {live && (
          <span className="absolute -inset-1 animate-[ping-ring_1.8s_ease-out_infinite] rounded-full bg-current opacity-50" />
        )}
      </span>
      {live ? "Live" : "Reconnecting…"}
    </span>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- ConnectionPill`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/ConnectionPill.tsx web/src/ds/ConnectionPill.test.tsx
git commit -m "feat(ds): add ConnectionPill live indicator"
```

---

## Task 10: `HealthCounter`

**Files:**
- Create: `web/src/ds/HealthCounter.tsx`
- Test: `web/src/ds/HealthCounter.test.tsx`

**Interfaces:**
- Produces: `<HealthCounter label: string value: ReactNode tone?: "ink"|"run"|"fail"|"live" />` — big numeral over a mono label; `tone` colors the numeral (`live` uses the eye).

- [ ] **Step 1: Write the failing test `web/src/ds/HealthCounter.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HealthCounter } from "./HealthCounter";

describe("HealthCounter", () => {
  it("renders value and label", () => {
    render(<HealthCounter label="Agents" value={12} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- HealthCounter`
Expected: FAIL — cannot resolve `./HealthCounter`.

- [ ] **Step 3: Implement `web/src/ds/HealthCounter.tsx`**

```tsx
import type { ReactNode } from "react";

const TONE = {
  ink: "text-ink",
  run: "text-run",
  fail: "text-fail",
  live: "text-eye",
} as const;

export function HealthCounter({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="rounded-tile border border-line bg-ground-2 px-5 py-3.5 text-center">
      <div className={`text-4xl font-extrabold leading-none ${TONE[tone]}`}>
        {value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- HealthCounter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/HealthCounter.tsx web/src/ds/HealthCounter.test.tsx
git commit -m "feat(ds): add HealthCounter stat tile"
```

---

# Phase 2 — Views

## Task 11: `Sparkline`

**Files:**
- Create: `web/src/ds/Sparkline.tsx`
- Test: `web/src/ds/Sparkline.test.tsx`

**Interfaces:**
- Consumes: `sparklinePoints` from `./format`.
- Produces: `<Sparkline label, value, sub?, values: number[], tone?: "ok"|"eye"|"fail" />`.

- [ ] **Step 1: Write the failing test `web/src/ds/Sparkline.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders label, value and a polyline", () => {
    const { container } = render(
      <Sparkline label="Runs" value="28" values={[1, 3, 2, 5]} />,
    );
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(container.querySelector("polyline")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- Sparkline`
Expected: FAIL — cannot resolve `./Sparkline`.

- [ ] **Step 3: Implement `web/src/ds/Sparkline.tsx`**

```tsx
import type { ReactNode } from "react";
import { sparklinePoints } from "./format";

const STROKE = {
  ok: "#2fe6a4",
  eye: "#36e3e8",
  fail: "#ff5765",
} as const;

export function Sparkline({
  label,
  value,
  sub,
  values,
  tone = "ok",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  values: number[];
  tone?: keyof typeof STROKE;
}) {
  return (
    <div className="w-40 rounded-tile border border-line bg-ground-2 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-0.5 text-2xl font-extrabold">
        {value}
        {sub && <small className="text-[0.55em] font-semibold text-ink-faint"> {sub}</small>}
      </div>
      <svg
        viewBox="0 0 100 26"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="mt-2 block h-[30px] w-full"
      >
        <polyline
          fill="none"
          stroke={STROKE[tone]}
          strokeWidth={2}
          points={sparklinePoints(values, 100, 26)}
        />
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- Sparkline`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/Sparkline.tsx web/src/ds/Sparkline.test.tsx
git commit -m "feat(ds): add Sparkline component"
```

---

## Task 12: `AgentTile`

**Files:**
- Create: `web/src/ds/AgentTile.tsx`
- Test: `web/src/ds/AgentTile.test.tsx`

**Interfaces:**
- Consumes: `Agent` from `../types`; `toDsStatus`, `STATUS` from `./status`; `TimeAgo`.
- Produces: `<AgentTile agent: Agent onApprove?: () => void onRevise?: () => void />` — status rail + glow, name/id, status pill, detail, tempo sweep (working) or approval gate (await), footer (live dot + folder + updated).

- [ ] **Step 1: Write the failing test `web/src/ds/AgentTile.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTile } from "./AgentTile";
import type { Agent } from "../types";

const base: Agent = {
  short: "7a1b",
  sessionId: null,
  name: "idea-sweep",
  status: "working",
  tempo: "fast",
  detail: "red → green on scheduler-prune test",
  result: null,
  template: null,
  cwd: "C:/GIT/argus",
  cliVersion: null,
  inFlight: { tasks: 2, queued: 0, kinds: [] },
  createdAt: null,
  updatedAt: new Date().toISOString(),
  firstTerminalAt: null,
  live: true,
  pid: 1,
};

describe("AgentTile", () => {
  it("renders name, id and status", () => {
    render(<AgentTile agent={base} />);
    expect(screen.getByText("idea-sweep")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("shows an approval gate and fires callbacks when await", async () => {
    const onApprove = vi.fn();
    const onRevise = vi.fn();
    render(
      <AgentTile
        agent={{ ...base, status: "unknown", live: false }}
        dsStatusOverride="await"
        onApprove={onApprove}
        onRevise={onRevise}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /revise/i }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onRevise).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- AgentTile`
Expected: FAIL — cannot resolve `./AgentTile`.

- [ ] **Step 3: Implement `web/src/ds/AgentTile.tsx`**

```tsx
import type { Agent } from "../types";
import { STATUS, toDsStatus, type DsStatus, type ColorToken } from "./status";
import { StatusPill } from "./StatusPill";
import { TimeAgo } from "./TimeAgo";

const RAIL: Record<ColorToken, string> = {
  run: "bg-run shadow-[0_0_14px_1px_var(--color-run)]",
  ok: "bg-ok",
  fail: "bg-fail shadow-[0_0_16px_2px_var(--color-fail)]",
  queue: "bg-queue",
  idle: "bg-idle",
  await: "bg-await shadow-[0_0_16px_2px_var(--color-await)] animate-[pulse_1.4s_ease-in-out_infinite]",
};

export function AgentTile({
  agent,
  dsStatusOverride,
  onApprove,
  onRevise,
}: {
  agent: Agent;
  dsStatusOverride?: DsStatus;
  onApprove?: () => void;
  onRevise?: () => void;
}) {
  const ds = dsStatusOverride ?? toDsStatus(agent.status);
  const { token } = STATUS[ds];
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;

  return (
    <div className="relative flex flex-col gap-2 overflow-hidden rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-3.5 py-3 pl-4">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight">{agent.name}</div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">job {agent.short}</div>
        </div>
        <StatusPill status={ds} />
      </div>

      {agent.detail && (
        <div className="text-[12.5px] leading-snug text-ink-dim">{agent.detail}</div>
      )}

      {ds === "working" && (
        <div className="relative h-[5px] overflow-hidden rounded-full bg-ink-faint/15">
          <i className="absolute inset-y-0 w-2/5 animate-[sweep_1.6s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-run to-transparent" />
        </div>
      )}

      {ds === "await" && (onApprove || onRevise) && (
        <div className="mt-px flex gap-1.5">
          <button
            type="button"
            onClick={onApprove}
            className="flex-1 rounded-md border border-ok bg-ok/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onRevise}
            className="flex-1 rounded-md border border-await bg-await/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await"
          >
            Revise
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 font-mono text-[10px] text-ink-faint">
        {agent.live && <span className="text-eye">● live</span>}
        {folder && <span>{folder}</span>}
        {agent.inFlight && agent.inFlight.tasks > 0 && (
          <span className="text-run/80">{agent.inFlight.tasks} in flight</span>
        )}
        <span className="ml-auto">
          <TimeAgo iso={agent.updatedAt} />
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- AgentTile`
Expected: PASS.

- [ ] **Step 5: Visual parity check**

Compare against `design-system/components/agent-tile/index.html`: rail color + glow per status, tempo sweep on working, gate on await, footer meter. Confirm reduced-motion stops the sweep/pulse.

- [ ] **Step 6: Commit**

```bash
git add web/src/ds/AgentTile.tsx web/src/ds/AgentTile.test.tsx
git commit -m "feat(ds): add AgentTile with status rail, tempo sweep, approval gate"
```

---

## Task 13: `SchedulerRow`

**Files:**
- Create: `web/src/ds/SchedulerRow.tsx`
- Test: `web/src/ds/SchedulerRow.test.tsx`

**Interfaces:**
- Consumes: `formatDuration` from `./format`.
- Produces: `<SchedulerRow name, etaMs: number | null, trigger: string />` — name + eye-colored ETA + mono trigger description. `etaMs` null renders `"—"`.

- [ ] **Step 1: Write the failing test `web/src/ds/SchedulerRow.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchedulerRow } from "./SchedulerRow";

describe("SchedulerRow", () => {
  it("renders name, formatted eta and trigger", () => {
    render(
      <SchedulerRow name="nightly-qa" etaMs={(7 * 60 + 41) * 60_000} trigger="daily · 02:00" />,
    );
    expect(screen.getByText("nightly-qa")).toBeInTheDocument();
    expect(screen.getByText("7h 41m")).toBeInTheDocument();
    expect(screen.getByText("daily · 02:00")).toBeInTheDocument();
  });
  it("renders a dash when eta is null", () => {
    render(<SchedulerRow name="x" etaMs={null} trigger="paused" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- SchedulerRow`
Expected: FAIL — cannot resolve `./SchedulerRow`.

- [ ] **Step 3: Implement `web/src/ds/SchedulerRow.tsx`**

```tsx
import { formatDuration } from "./format";

export function SchedulerRow({
  name,
  etaMs,
  trigger,
}: {
  name: string;
  etaMs: number | null;
  trigger: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-2.5 gap-y-1">
      <div className="text-sm font-semibold">{name}</div>
      <div className="text-right font-mono text-sm font-bold text-eye">
        {etaMs == null ? "—" : formatDuration(etaMs)}
      </div>
      <div className="col-start-1 font-mono text-[11px] text-ink-faint">{trigger}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- SchedulerRow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/SchedulerRow.tsx web/src/ds/SchedulerRow.test.tsx
git commit -m "feat(ds): add SchedulerRow component"
```

---

## Task 14: `AlertStrip`

**Files:**
- Create: `web/src/ds/AlertStrip.tsx`
- Test: `web/src/ds/AlertStrip.test.tsx`

**Interfaces:**
- Produces: `<AlertStrip subject: string message: string when?: string />` — fail-toned banner, `role="status"`, pulsing "Failed" badge.

- [ ] **Step 1: Write the failing test `web/src/ds/AlertStrip.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertStrip } from "./AlertStrip";

describe("AlertStrip", () => {
  it("renders subject, message and badge", () => {
    render(
      <AlertStrip subject="deploy-bot" message="exit 1 · ActiveMQ refused" when="4m ago" />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("deploy-bot")).toBeInTheDocument();
    expect(screen.getByText(/ActiveMQ refused/)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- AlertStrip`
Expected: FAIL — cannot resolve `./AlertStrip`.

- [ ] **Step 3: Implement `web/src/ds/AlertStrip.tsx`**

```tsx
export function AlertStrip({
  subject,
  message,
  when,
}: {
  subject: string;
  message: string;
  when?: string;
}) {
  return (
    <div
      role="status"
      className="flex w-full items-center gap-3.5 rounded-panel border border-fail/45 bg-gradient-to-r from-fail/20 to-fail/[0.06] px-5 py-3.5 shadow-[0_0_0_1px_rgb(255_87_101/0.12),0_8px_30px_rgb(255_87_101/0.10)]"
    >
      <span className="animate-[pulse_2.2s_ease-in-out_infinite] rounded-md border border-fail/50 bg-fail/20 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-fail">
        Failed
      </span>
      <span className="text-[17px] font-semibold">
        <b className="text-ink">{subject}</b>{" "}
        <span className="font-medium text-ink-dim">{message}</span>
      </span>
      {when && <span className="ml-auto font-mono text-[13px] text-ink-dim">{when}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm -w @argus/web run test -- AlertStrip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ds/AlertStrip.tsx web/src/ds/AlertStrip.test.tsx
git commit -m "feat(ds): add AlertStrip failure banner"
```

---

## Task 15: `ActivityEvent` + barrel export

**Files:**
- Create: `web/src/ds/ActivityEvent.tsx`
- Create: `web/src/ds/index.ts`
- Test: `web/src/ds/ActivityEvent.test.tsx`

**Interfaces:**
- Produces:
  - `<ActivityEvent time: string children: ReactNode tone?: "default"|"ok"|"fail" />` — mono time + sans text row.
  - `web/src/ds/index.ts` re-exports the whole library.

- [ ] **Step 1: Write the failing test `web/src/ds/ActivityEvent.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityEvent } from "./ActivityEvent";

describe("ActivityEvent", () => {
  it("renders time and content", () => {
    render(<ActivityEvent time="18:10">deploy-bot failed</ActivityEvent>);
    expect(screen.getByText("18:10")).toBeInTheDocument();
    expect(screen.getByText("deploy-bot failed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- ActivityEvent`
Expected: FAIL — cannot resolve `./ActivityEvent`.

- [ ] **Step 3: Implement `web/src/ds/ActivityEvent.tsx`**

```tsx
import type { ReactNode } from "react";

export function ActivityEvent({
  time,
  children,
}: {
  time: string;
  children: ReactNode;
  tone?: "default" | "ok" | "fail";
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-2.5">
      <span className="pt-px font-mono text-[11px] text-ink-faint">{time}</span>
      <span className="text-[13px] leading-snug text-ink-dim">{children}</span>
    </div>
  );
}
```

- [ ] **Step 4: Create the barrel `web/src/ds/index.ts`**

```ts
export * from "./status";
export * from "./format";
export { IrisMark } from "./IrisMark";
export { Card } from "./Card";
export { Section } from "./Section";
export { EmptyState } from "./EmptyState";
export { TimeAgo } from "./TimeAgo";
export { StatusPill } from "./StatusPill";
export { ConnectionPill } from "./ConnectionPill";
export { HealthCounter } from "./HealthCounter";
export { Sparkline } from "./Sparkline";
export { AgentTile } from "./AgentTile";
export { SchedulerRow } from "./SchedulerRow";
export { AlertStrip } from "./AlertStrip";
export { ActivityEvent } from "./ActivityEvent";
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npm -w @argus/web run test -- ActivityEvent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/ds/ActivityEvent.tsx web/src/ds/index.ts web/src/ds/ActivityEvent.test.tsx
git commit -m "feat(ds): add ActivityEvent and ds barrel export"
```

---

## Task 16: App shell — wordmark, IrisMark, ConnectionPill; remove duplicated status map

**Files:**
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `IrisMark`, `ConnectionPill`, `AgentTile`, `HealthCounter`, `EmptyState` from `./ds`.
- Produces: the nav shell on tokens; `AgentsView` rebuilt on `ds/` components; the local `STATUS_STYLE`, `StatusPill`, `AgentCard`, `Stat`, `timeAgo` definitions removed from `App.tsx`.

- [ ] **Step 1: Replace the top of `App.tsx` (imports + delete local primitives)**

Remove the `STATUS_STYLE` constant, the local `StatusPill`, `AgentCard`, `Stat`, and `timeAgo` functions (lines ~15–104 in the current file). Replace the import block with:
```tsx
import { useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { AgentStatus } from "./types";
import { AgentTile, HealthCounter, ConnectionPill, IrisMark, EmptyState } from "./ds";
import Sessions from "./views/Sessions";
import ActivityFeed from "./views/ActivityFeed";
import Projects from "./views/Projects";
import Stats from "./views/Stats";
import Inventory from "./views/Inventory";
import Tasks from "./views/Tasks";
import Search from "./views/Search";
import Cron from "./views/Cron";
import Schedules from "./views/Schedules";
import CommandCenter from "./views/CommandCenter";
import AgentDetail from "./views/AgentDetail";
```
> `CommandCenter` is created in Task 18; if implementing strictly in order, add its import and tab entry in Task 18 instead and omit them here.

- [ ] **Step 2: Rebuild `AgentsView` body**

Replace the `AgentsView` function with:
```tsx
function AgentsView() {
  const { agents, loading, error, live } = useAgents();

  const stats = useMemo(() => {
    const by = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
    return {
      total: agents.length,
      live: agents.filter((a) => a.live).length,
      working: by("working"),
      failed: by("failed"),
    };
  }, [agents]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-3xl font-extrabold tracking-tight">
            <IrisMark size={30} /> ARG<span className="text-eye">U</span>S
          </h1>
          <p className="mt-1 text-sm text-ink-dim">
            The all-seeing monitor for your Claude Code agents
          </p>
        </div>
        <ConnectionPill live={live} />
      </header>

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HealthCounter label="Agents" value={stats.total} />
        <HealthCounter label="Live" value={stats.live} tone="live" />
        <HealthCounter label="Working" value={stats.working} tone="run" />
        <HealthCounter label="Failed" value={stats.failed} tone="fail" />
      </section>

      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading agents…</p>
      ) : agents.length === 0 ? (
        <EmptyState>No background agents found yet. Launch one and it’ll appear here.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {agents.map((a) => (
            <a key={a.short} href={`#/agent/${encodeURIComponent(a.short)}`} className="block">
              <AgentTile agent={a} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update the nav shell branding**

In the `<nav>` block, replace the `👁️ Argus` span with:
```tsx
<span className="flex shrink-0 items-center gap-2 text-sm font-bold">
  <IrisMark size={18} /> ARG<span className="text-eye">U</span>S
</span>
```
And change the nav container classes from `border-white/10 bg-[#0a0b0f]/80` to `border-line bg-ground/80`, active tab from `bg-white/10 text-white` to `bg-surface-2 text-ink`, inactive from `text-white/70 hover:text-white` to `text-ink-dim hover:text-ink` (and the monitoring row inactive `text-ink-faint hover:text-ink-dim`).

- [ ] **Step 4: Verify build, tests, and visual**

Run: `npm -w @argus/web run build && npm -w @argus/web run test`
Expected: build passes; all tests green.
Run `npm -w @argus/web run dev`, confirm the Agents view shows iris mark, ARG**U**S wordmark, health counters, agent tiles, and the connection pill. Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx
git commit -m "refactor(web): rebuild app shell + Agents view on design system"
```

---

## Task 17: Migrate remaining views onto tokens & primitives

**Files:**
- Modify: `web/src/views/Schedules.tsx`, `ActivityFeed.tsx`, `Stats.tsx`, `Sessions.tsx`, `Projects.tsx`, `Search.tsx`, `Inventory.tsx`, `Tasks.tsx`, `Cron.tsx`, `AgentDetail.tsx`
- Modify: `web/src/components/ui.tsx` (re-export shim, then removal)

**Interfaces:**
- Consumes: everything from `./ds`.

> This task is repeated per view. Do one view per commit. The mechanical rules below are the whole job — there is no per-view bespoke code beyond swapping classes/components.

- [ ] **Step 1: Point the old `ui.tsx` at the new library (transition shim)**

Replace `web/src/components/ui.tsx` entire contents with:
```tsx
export { StatusPill, Card, Section, EmptyState, TimeAgo } from "../ds";
export type { DsStatus as Status } from "../ds";
```
This keeps any view still importing from `components/ui` working while you migrate.

- [ ] **Step 2: For each view, apply the token swap**

In every file under `web/src/views/`, replace:
- `bg-white/[0.03]` / `bg-white/[0.05]` → `bg-surface` (hover `hover:border-ink-faint/40`)
- `border-white/10` → `border-line`; `border-white/15` → `border-line`
- `text-white` → `text-ink`; `text-white/70` → `text-ink-dim`; `text-white/40` / `text-white/45` → `text-ink-faint`
- status utilities `bg-amber-500/15 text-amber-300 …` → use `<StatusPill status={toDsStatus(x)} />`
- raw stat blocks → `<HealthCounter>`; "next up" schedule rows → `<SchedulerRow>`; failure banners → `<AlertStrip>`; activity rows → `<ActivityEvent>`; section headers → `<Section>`; empty placeholders → `<EmptyState>`.
- Import from `../ds` instead of `../components/ui`.

- [ ] **Step 3: After each view, verify and commit**

Run: `npm -w @argus/web run build`
Expected: passes.
Commit per view, e.g.:
```bash
git add web/src/views/Schedules.tsx
git commit -m "refactor(web): migrate Schedules view to design system"
```
Repeat Steps 2–3 for: ActivityFeed, Stats, Sessions, Projects, Search, Inventory, Tasks, Cron, AgentDetail.

- [ ] **Step 4: Remove the shim once no view imports `components/ui`**

Run: `grep -rn "components/ui" web/src` → expect no matches.
Then:
```bash
git rm web/src/components/ui.tsx
git commit -m "refactor(web): remove legacy ui.tsx shim"
```

- [ ] **Step 5: Final grep gate**

Run:
```bash
grep -rnE "bg-white/\[|amber-|emerald-|rose-|slate-|sky-|STATUS_STYLE" web/src
```
Expected: no matches (no glass surfaces, no hardcoded status palettes, no duplicated map). Fix any stragglers, then commit.

---

# Phase 3 — Command Center

## Task 18: Pipeline types + `usePipeline` stub

**Files:**
- Create: `web/src/ds/pipeline.ts`
- Create: `web/src/ds/usePipeline.ts`
- Test: `web/src/ds/pipeline.test.ts`

**Interfaces:**
- Produces:
  - `interface PipelineTile { jobShort: string|null; name: string; subId: string; status: DsStatus; detail: string; tokens?: number; costUsd?: number; updatedAt: string|null }`
  - `interface PipelinePhase { id: string; index: number; name: string; tiles: PipelineTile[] }`
  - `interface PipelineState { feature: string; phases: PipelinePhase[] }`
  - `function usePipeline(): PipelineState` (stub returning the 7-phase mock).

- [ ] **Step 1: Write the failing test `web/src/ds/pipeline.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { STUB_PIPELINE } from "./usePipeline";

const PHASES = [
  "brainstorm", "design", "spec", "plan", "implement", "review", "approve",
];

describe("STUB_PIPELINE", () => {
  it("has the seven canonical phases in order", () => {
    expect(STUB_PIPELINE.phases.map((p) => p.id)).toEqual(PHASES);
    STUB_PIPELINE.phases.forEach((p, i) => expect(p.index).toBe(i + 1));
  });
  it("contains at least one await tile (the approval gate)", () => {
    const all = STUB_PIPELINE.phases.flatMap((p) => p.tiles);
    expect(all.some((t) => t.status === "await")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- pipeline`
Expected: FAIL — cannot resolve `./usePipeline`.

- [ ] **Step 3: Implement `web/src/ds/pipeline.ts`**

```ts
import type { DsStatus } from "./status";

export interface PipelineTile {
  jobShort: string | null;
  name: string;
  subId: string;
  status: DsStatus;
  detail: string;
  tokens?: number;
  costUsd?: number;
  updatedAt: string | null;
}

export interface PipelinePhase {
  id: string;
  index: number;
  name: string;
  tiles: PipelineTile[];
}

export interface PipelineState {
  feature: string;
  phases: PipelinePhase[];
}
```

- [ ] **Step 4: Implement `web/src/ds/usePipeline.ts`**

```ts
import type { PipelineState } from "./pipeline";

export const STUB_PIPELINE: PipelineState = {
  feature: "scheduler-prune",
  phases: [
    {
      id: "brainstorm", index: 1, name: "Brainstorm",
      tiles: [{ jobShort: "7a1b", name: "idea-sweep", subId: "9 directions", status: "done", detail: "Converged on prune-by-age + dead-letter requeue.", tokens: 48000, costUsd: 0.71, updatedAt: null }],
    },
    {
      id: "design", index: 2, name: "Design",
      tiles: [{ jobShort: "7a2c", name: "design-doc", subId: "4 diagrams", status: "done", detail: "Sequence + state model approved.", tokens: 72000, costUsd: 1.08, updatedAt: null }],
    },
    {
      id: "spec", index: 3, name: "Write spec",
      tiles: [{ jobShort: "7b04", name: "spec-author", subId: "SPEC-218", status: "done", detail: "Acceptance criteria + edge cases written.", tokens: 61000, costUsd: 0.92, updatedAt: null }],
    },
    {
      id: "plan", index: 4, name: "Impl plan",
      tiles: [{ jobShort: "7b91", name: "plan-author", subId: "PLAN-218", status: "await", detail: "8-step plan ready · approve to start, or send back to revise.", tokens: 34000, costUsd: 0.51, updatedAt: null }],
    },
    {
      id: "implement", index: 5, name: "Implement",
      tiles: [
        { jobShort: "2c8d44", name: "dev · TDD", subId: "task 3", status: "working", detail: "red → green on scheduler-prune test · 2 in flight", tokens: 88000, costUsd: 1.32, updatedAt: null },
        { jobShort: null, name: "migration-gen", subId: "task 5", status: "queued", detail: "Waits on plan task 6 · dead-letter migration.", tokens: 0, costUsd: 0, updatedAt: null },
      ],
    },
    {
      id: "review", index: 6, name: "Review",
      tiles: [
        { jobShort: "5e30", name: "code-review", subId: "PR #482", status: "working", detail: "Scanning diff (8 files) · pass 2/3.", tokens: 53000, costUsd: 0.8, updatedAt: null },
        { jobShort: "5e31", name: "ci-gate", subId: "PR #480", status: "failed", detail: "exit 1 — 2 flaky tests on requeue path.", tokens: 41000, costUsd: 0.62, updatedAt: null },
      ],
    },
    {
      id: "approve", index: 7, name: "Approve · iterate",
      tiles: [
        { jobShort: "5e30", name: "code-review", subId: "PR #482", status: "await", detail: "Review passed · awaiting sign-off to squash-merge.", tokens: 53000, costUsd: 0.8, updatedAt: null },
        { jobShort: "6f12", name: "merge-bot", subId: "PR #479", status: "done", detail: "Squash-merged to main. Release event published.", tokens: 96000, costUsd: 1.44, updatedAt: null },
      ],
    },
  ],
};

/**
 * Stub feed for the Command Center board. The return shape is the data
 * contract a future "derive pipeline from ~/.claude" implementation must
 * satisfy; the board UI does not change when the source becomes real.
 */
export function usePipeline(): PipelineState {
  return STUB_PIPELINE;
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npm -w @argus/web run test -- pipeline`
Expected: PASS.

- [ ] **Step 6: Add pipeline exports to the barrel**

Append to `web/src/ds/index.ts`:
```ts
export * from "./pipeline";
export { usePipeline, STUB_PIPELINE } from "./usePipeline";
```

- [ ] **Step 7: Commit**

```bash
git add web/src/ds/pipeline.ts web/src/ds/usePipeline.ts web/src/ds/pipeline.test.ts web/src/ds/index.ts
git commit -m "feat(ds): add pipeline data contract and stub feed"
```

---

## Task 19: Command Center board view + nav tab

**Files:**
- Create: `web/src/views/CommandCenter.tsx`
- Modify: `web/src/App.tsx` (import + tab entry)
- Test: `web/src/views/CommandCenter.test.tsx`

**Interfaces:**
- Consumes: `usePipeline`, `STATUS`, `toDsStatus` not needed (tiles already `DsStatus`); reuses `AgentTile` styling concepts via a lightweight inline tile (tiles here are `PipelineTile`, not `Agent`).
- Produces: `CommandCenter` default export; new primary nav tab `command`.

- [ ] **Step 1: Write the failing test `web/src/views/CommandCenter.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CommandCenter from "./CommandCenter";

describe("CommandCenter", () => {
  it("renders all seven phase columns", () => {
    render(<CommandCenter />);
    for (const name of [
      "Brainstorm", "Design", "Write spec", "Impl plan", "Implement", "Review", "Approve · iterate",
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });
  it("renders an approval gate for await tiles", () => {
    render(<CommandCenter />);
    expect(screen.getAllByRole("button", { name: /approve/i }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm -w @argus/web run test -- CommandCenter`
Expected: FAIL — cannot resolve `./CommandCenter`.

- [ ] **Step 3: Implement `web/src/views/CommandCenter.tsx`**

```tsx
import { usePipeline } from "../ds";
import { STATUS, type ColorToken, type DsStatus } from "../ds";
import { StatusPill } from "../ds";
import type { PipelineTile } from "../ds";

const RAIL: Record<ColorToken, string> = {
  run: "bg-run shadow-[0_0_14px_1px_var(--color-run)]",
  ok: "bg-ok",
  fail: "bg-fail shadow-[0_0_16px_2px_var(--color-fail)]",
  queue: "bg-queue",
  idle: "bg-idle",
  await: "bg-await shadow-[0_0_16px_2px_var(--color-await)] animate-[pulse_1.4s_ease-in-out_infinite]",
};

function Tile({ tile }: { tile: PipelineTile }) {
  const token = STATUS[tile.status].token;
  return (
    <article className="relative flex flex-col gap-1.5 overflow-hidden rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-3 py-2.5 pl-3.5">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight">{tile.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {tile.jobShort ? `job ${tile.jobShort}` : "job ——"} · {tile.subId}
          </div>
        </div>
        <StatusPill status={tile.status} />
      </div>
      <div className="text-[12px] leading-snug text-ink-dim">{tile.detail}</div>
      {tile.status === "await" && (
        <div className="mt-px flex gap-1.5">
          <button type="button" className="flex-1 rounded-md border border-ok bg-ok/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok">
            Approve
          </button>
          <button type="button" className="flex-1 rounded-md border border-await bg-await/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await">
            Revise
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 font-mono text-[10px] text-ink-faint">
        {tile.tokens != null && <span className="text-ink-dim">{Math.round(tile.tokens / 1000)}k tok</span>}
        {tile.costUsd != null && <span>· ${tile.costUsd.toFixed(2)}</span>}
      </div>
    </article>
  );
}

export default function CommandCenter() {
  const pipeline = usePipeline();
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-8">
      <header className="mb-5 flex items-baseline gap-3.5">
        <span className="text-[22px] font-extrabold tracking-[0.03em]">
          ARG<span className="text-eye">U</span>S · command center
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          feature: {pipeline.feature} · {pipeline.phases.length} phases
        </span>
      </header>
      <div className="flex items-start gap-3.5 overflow-x-auto pb-2.5">
        {pipeline.phases.map((phase) => (
          <section key={phase.id} className="flex w-[248px] shrink-0 flex-col gap-2.5">
            <div className="flex items-center gap-2 px-0.5 pb-0.5">
              <span className="font-mono text-[10px] text-ink-faint">
                {String(phase.index).padStart(2, "0")}
              </span>
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">
                {phase.name}
              </span>
              <span className="ml-auto rounded-full border border-line px-2 py-px font-mono text-[11px] text-ink-faint">
                {phase.tiles.length}
              </span>
            </div>
            <div className="mb-0.5 h-0.5 rounded-full bg-line" />
            {phase.tiles.map((tile, i) => (
              <Tile key={`${tile.jobShort ?? "x"}-${i}`} tile={tile} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

// silence unused import warning for DsStatus if tree-shaken types differ
export type { DsStatus };
```

- [ ] **Step 4: Wire the nav tab in `App.tsx`**

Ensure `import CommandCenter from "./views/CommandCenter";` is present (added in Task 16 Step 1), and add to the `TABS` array as the first primary entry:
```tsx
{ id: "command", label: "Command Center", group: "primary", render: () => <CommandCenter /> },
```

- [ ] **Step 5: Run tests + build**

Run: `npm -w @argus/web run test && npm -w @argus/web run build`
Expected: all green; build passes.

- [ ] **Step 6: Visual parity check**

Compare against `design-system/Command Center.html` and `design-system/components/agent-tile/index.html`: 7 columns, rails/glows per status, await gates, token/cost meter. Confirm reduced-motion stops sweeps/pulses.

- [ ] **Step 7: Commit**

```bash
git add web/src/views/CommandCenter.tsx web/src/views/CommandCenter.test.tsx web/src/App.tsx
git commit -m "feat(web): add Command Center kanban board on stub pipeline"
```

---

# Phase 4 — Gallery retirement

## Task 20: Parity verification + remove `design-system/`

**Files:**
- Remove: `design-system/`

- [ ] **Step 1: Full verification sweep**

Run:
```bash
npm -w @argus/web run test
npm -w @argus/web run build
grep -rnE "bg-white/\[|amber-|emerald-|rose-|slate-|sky-|STATUS_STYLE|👁️" web/src
```
Expected: tests green; build passes; grep returns no matches.

- [ ] **Step 2: Confirm every gallery card has a React counterpart**

Checklist (visual compare each against its `design-system/` source): colors→`@theme`, type→fonts, iris-mark→`IrisMark`, status-pill→`StatusPill`, connection-pill→`ConnectionPill`, health-counter→`HealthCounter`, stat-sparkline→`Sparkline`, agent-tile→`AgentTile`, scheduler-row→`SchedulerRow`, alert-strip→`AlertStrip`, activity-event→`ActivityEvent`, Command Center→`CommandCenter`. All present and faithful.

- [ ] **Step 3: Remove the gallery (preserved in git history)**

```bash
git rm -r design-system
git commit -m "chore: retire design-system gallery; React ds/ is now source of truth"
```

- [ ] **Step 4: Final build**

Run: `npm -w @argus/web run build`
Expected: passes with the gallery gone.

---

## Self-Review (completed during authoring)

- **Spec coverage:** token layer (Task 2), fonts + Bilia/license handling (Task 3), status model incl. `await` + dedup (Tasks 5, 16, 17), all 8 gallery components + 4 primitives + IrisMark (Tasks 4, 7–15), Command Center contract + board (Tasks 18–19), gallery retirement (Task 20), reduced-motion (Task 2 base + each component), verification greps (Tasks 17, 20). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO-as-work; every code step shows complete code. The one inline note (CommandCenter import ordering) is a sequencing aid, not a placeholder.
- **Type consistency:** `DsStatus`, `ColorToken`, `StatusToken`, `STATUS`, `toDsStatus`, `PipelineTile/Phase/State`, `usePipeline`, `formatDuration`, `sparklinePoints` are defined once and referenced with matching names/signatures throughout.
