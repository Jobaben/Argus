import type { ColorToken } from "./status";

export const RAIL: Record<ColorToken, string> = {
  run: "bg-run shadow-[0_0_14px_1px_var(--color-run)]",
  ok: "bg-ok",
  fail: "bg-fail shadow-[0_0_16px_2px_var(--color-fail)]",
  queue: "bg-queue",
  idle: "bg-idle",
  await: "bg-await shadow-[0_0_16px_2px_var(--color-await)] animate-[pulse_1.4s_ease-in-out_infinite]",
};
