/**
 * The control language.
 *
 * There was no button primitive, so there were thirty-odd buttons: an "ok"
 * action styled four different ways, destructive actions in six, and the most
 * consequential control in the product — approving a gate — set in 10px mono
 * capitals indistinguishable from "Reset total". These variants are a ranking,
 * and the ranking is the point: one `primary` per surface for the thing you
 * most likely came to do, `secondary` for its alternatives, `ghost` for the
 * rest, and colour only where the action *is* a status change.
 *
 * - `primary`   — solid ink. Brand-neutral on purpose: the status colours stay
 *                 free to mean status.
 * - `approve`   — solid ok-green. Approving is "make this succeed".
 * - `attention` — solid await-violet. "Review" on something waiting for you.
 * - `danger`    — fail-red outline. Never solid: a destructive action should
 *                 never be the loudest thing on screen.
 *
 * The class strings live here, apart from the components in `Button.tsx`, so an
 * `<a>` or a `<summary>` can wear them too.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "approve" | "attention";
export type ButtonSize = "sm" | "md" | "lg";

export const BASE =
  "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-semibold transition duration-(--duration-quick) disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 motion-safe:active:scale-[0.97] motion-safe:active:duration-(--duration-press)";

export const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-ground shadow-[inset_0_-1px_0_rgb(10_15_22/0.18)] hover:bg-white focus-visible:outline-offset-2",
  secondary:
    "border border-line-strong bg-surface-2 text-ink hover:border-ink-faint/45 hover:bg-surface-3",
  ghost: "text-ink-dim hover:bg-surface-2 hover:text-ink",
  danger: "border border-fail/35 text-fail hover:border-fail/60 hover:bg-fail/10",
  approve: "bg-ok text-ground hover:brightness-110",
  attention: "bg-await text-ground hover:brightness-110",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-caption",
  md: "h-8 px-3 text-small",
  lg: "h-10 px-4 text-body",
};

export const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 17 };

export const SQUARE: Record<ButtonSize, string> = {
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-10 w-10",
};

/** The class string, for an `<a>` or a `<summary>` that has to look like a button. */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  extra = "",
): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}${extra ? ` ${extra}` : ""}`;
}

/**
 * Text inputs, selects and textareas. One field style instead of the ten that
 * had grown (two backgrounds, three radii, two borders); the focus state is a
 * border and a soft ring rather than the global outline, because a field is
 * where the caret is and the ring has to sit flush with the box.
 */
export const fieldClass =
  "min-w-0 rounded-control border border-line-strong bg-ground-2 px-2.5 py-1.5 text-small text-ink placeholder:text-ink-faint transition-colors duration-(--duration-quick) hover:border-ink-faint/50 focus:border-eye/60 focus:outline-none focus:ring-2 focus:ring-eye/20 disabled:opacity-50 aria-[invalid=true]:border-fail/60";

/** A field's visible label. */
export const labelClass = "text-caption font-semibold text-ink-dim";

/**
 * A small metadata chip — a model name, a trigger kind, a count. Neutral by
 * default; tones exist for the chips that *are* statuses.
 */
export function chipClass(
  tone: "neutral" | "run" | "ok" | "fail" | "queue" | "await" | "eye" = "neutral",
): string {
  const t = {
    neutral: "border-line text-ink-dim",
    run: "border-run/35 bg-run/10 text-run",
    ok: "border-ok/35 bg-ok/10 text-ok",
    fail: "border-fail/35 bg-fail/10 text-fail",
    queue: "border-queue/35 bg-queue/10 text-queue",
    await: "border-await/40 bg-await/10 text-await",
    eye: "border-eye/35 bg-eye/10 text-eye",
  }[tone];
  return `inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-micro font-semibold ${t}`;
}
