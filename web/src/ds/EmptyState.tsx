import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Nothing to show — said in a way that tells you what would be here and how to
 * get it there.
 *
 * It was a dashed outline around a line of grey text, which is what a broken
 * layout looks like; the same box said "no data", "all clear" and "you have not
 * set this up yet", three different messages with three different next steps.
 * `title` is the message, `children` the explanation, `action` the next step,
 * and `tone="calm"` marks good news so it is not mistaken for missing data.
 */
export function EmptyState({
  children,
  title,
  icon,
  action,
  tone = "neutral",
  compact = false,
}: {
  children?: ReactNode;
  title?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  tone?: "neutral" | "calm";
  /** A short inline version, for a section inside a page rather than a page. */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-tile border border-line bg-surface/50 text-center ${
        compact ? "gap-2 px-5 py-6" : "gap-3 px-6 py-12 sm:py-14"
      }`}
    >
      {icon && (
        <span
          className={`flex items-center justify-center rounded-full border ${
            compact ? "h-9 w-9" : "h-11 w-11"
          } ${
            tone === "calm"
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-line-strong bg-surface-2 text-ink-dim"
          }`}
        >
          <Icon name={icon} size={compact ? 17 : 20} />
        </span>
      )}
      {title && <p className="text-heading font-semibold text-ink">{title}</p>}
      {children && (
        <div className={`max-w-lg text-ink-dim ${title ? "text-small" : "text-body"}`}>
          {children}
        </div>
      )}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
