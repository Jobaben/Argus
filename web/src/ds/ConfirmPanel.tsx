import { useId } from "react";
import { Button } from "./Button";
import type { IconName } from "./Icon";

/**
 * What the app asks before an action that destroys, discards or overrides
 * something. It replaces the browser's `confirm()`, which drew an unthemed
 * light box over the console, could only offer "OK" and "Cancel", and put
 * straight quotes round every name.
 */
export interface Question {
  /** The question, naming what it acts on: Delete schedule “Nightly”? */
  title: string;
  /** What else happens when it goes ahead, when anything does. */
  detail?: string;
  /** The verb on the button that goes ahead: "Delete schedule". */
  confirm: string;
  /** The safe answer, as specific as the verb: "Keep", "Keep running". */
  cancel?: string;
  /** Red for an action that destroys or discards work; secondary for a go-ahead
   *  that loses nothing. */
  tone?: "danger" | "secondary";
  icon?: IconName;
}

/**
 * The question, in place, with the verb and the safe answer side by side. It
 * takes a line of its own and wraps inside it on a phone rather than squeezing
 * into the row of buttons it was opened from. Focus lands on the safe answer,
 * so an Enter pressed out of habit keeps everything, and Escape answers the
 * same way.
 */
export function ConfirmPanel({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (yes: boolean) => void;
}) {
  const id = useId();
  const { title, detail, confirm, cancel = "Cancel", tone = "danger", icon } = question;
  return (
    <div
      role="group"
      aria-labelledby={`${id}q`}
      aria-describedby={detail ? `${id}d` : undefined}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Answered here, not by the surface around it: a drawer's own Escape
        // would close the drawer, and the edit in it, instead.
        e.stopPropagation();
        onAnswer(false);
      }}
      className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-line-strong bg-surface-2 px-3 py-2 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
    >
      <p className="min-w-0 flex-1 basis-56 text-small text-ink-dim">
        <span id={`${id}q`} className="font-semibold text-ink">
          {title}
        </span>
        {detail && (
          <>
            {" "}
            <span id={`${id}d`}>{detail}</span>
          </>
        )}
      </p>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" autoFocus onClick={() => onAnswer(false)}>
          {cancel}
        </Button>
        <Button variant={tone} size="sm" icon={icon} onClick={() => onAnswer(true)}>
          {confirm}
        </Button>
      </div>
    </div>
  );
}
