import type { ColorToken } from "./status";

export const RAIL: Record<ColorToken, string> = {
  run: "bg-run shadow-[0_0_14px_1px_var(--color-run)]",
  ok: "bg-ok",
  fail: "bg-fail shadow-[0_0_16px_2px_var(--color-fail)]",
  queue: "bg-queue",
  idle: "bg-idle",
  await:
    "bg-await shadow-[0_0_16px_2px_var(--color-await)] animate-[pulse_1.4s_ease-in-out_infinite]",
};

/** Status-tinted border + gradient from-stop for tile surfaces (pairs with `to-surface`). */
export const TILE_SKIN: Record<ColorToken, string> = {
  run: "border-run/30 from-surface-2",
  ok: "border-line from-surface-2",
  fail: "border-fail/40 from-fail/10",
  queue: "border-line from-surface-2",
  idle: "border-line from-surface-2",
  await: "border-await/42 from-await/12",
};

/** Detail-text tint on tinted tiles; fall back to text-ink-dim. */
export const TILE_DETAIL: Partial<Record<ColorToken, string>> = {
  fail: "text-[#ffc4ca]",
  await: "text-[#dcc8ff]",
};
