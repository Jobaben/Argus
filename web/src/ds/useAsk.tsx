import { useCallback, useState, type ReactNode } from "react";
import { ConfirmPanel, type Question } from "./ConfirmPanel";

/** Asks a question mid-flight and resolves with the answer: true to go ahead. */
export type Ask = (question: Question) => Promise<boolean>;

/**
 * The in-app confirm for a question that only arises part-way through an
 * action — a save the server refused because instances are running, say —
 * where there is no button press to open it from. `ask` resolves when the
 * question is answered; `question` is the panel to render where it should
 * appear, and null while nothing is being asked. Kept apart from
 * `useConfirm` so the shell, which uses that, does not carry this too.
 *
 * Focus goes back to whatever held it when the question was asked (the button
 * that started the action), so answering does not drop it to the page.
 */
export function useAsk(): [ask: Ask, question: ReactNode] {
  const [open, setOpen] = useState<{
    question: Question;
    answer: (yes: boolean) => void;
  } | null>(null);
  const ask = useCallback<Ask>((question) => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise<boolean>((resolve) =>
      setOpen({
        question,
        answer: (yes) => {
          setOpen(null);
          back?.focus();
          resolve(yes);
        },
      }),
    );
  }, []);
  return [ask, open && <ConfirmPanel question={open.question} onAnswer={open.answer} />];
}
