import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

const TONE = {
  default: "[&_b]:text-ink",
  ok: "[&_b]:text-ok",
  fail: "[&_b]:text-fail",
} as const;

/** The mark beside the line: a failure and a success are told apart before the
 *  sentence is read, and anything else is a quiet dot. */
const MARK: Record<keyof typeof TONE, { icon: IconName; className: string }> = {
  default: { icon: "dot", className: "text-ink-faint" },
  ok: { icon: "check-circle", className: "text-ok" },
  fail: { icon: "x-circle", className: "text-fail" },
};

/**
 * One line of an activity feed: when, what kind, and the sentence.
 *
 * The time is set in the brand face's tabular figures rather than monospace —
 * it is a clock reading beside a sentence, not machine text — and the bold
 * subject of the sentence takes the tone, so "**deploy-bot** failed" reads red
 * where it matters and nowhere else.
 */
export function ActivityEvent({
  time,
  tone = "default",
  icon,
  children,
}: {
  time: string;
  children: ReactNode;
  tone?: keyof typeof TONE;
  /** Overrides the tone's default mark — a bolt for a launch, a bell for an alert. */
  icon?: IconName;
}) {
  const mark = MARK[tone];
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2.5 py-1">
      <span className="min-w-[2.75rem] pt-px text-caption tabular-nums text-ink-faint">{time}</span>
      <Icon name={icon ?? mark.icon} size={14} className={`mt-[3px] ${mark.className}`} />
      <span
        className={`break-words text-small leading-snug text-ink-dim [&_b]:font-semibold ${TONE[tone]}`}
      >
        {children}
      </span>
    </div>
  );
}
