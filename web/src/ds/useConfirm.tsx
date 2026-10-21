import { useRef, useState, type MouseEvent } from "react";
import { ConfirmPanel, type Question } from "./ConfirmPanel";

/**
 * A confirm opened by a button. `toggle(key)` is the button's onClick — it
 * opens that button's question, or closes it when pressed again — and `armed`
 * says which one is open, for its `aria-expanded`. One question at a time: a
 * card asks about its Delete or its Stop, never both.
 *
 * `question(q, run)` renders the open question where the call site wants it.
 * It is built each render rather than stored when the button was pressed, so
 * going ahead acts on what is on screen now (the instances running now, not
 * the ones running when Stop was pressed). Either answer hands focus back to
 * the button that asked, the place the reader left.
 */
export function useConfirm() {
  const [armed, setArmed] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  return {
    armed,
    toggle: (key: string) => (e: MouseEvent<HTMLElement>) => {
      opener.current = e.currentTarget;
      setArmed((open) => (open === key ? null : key));
    },
    question: (q: Question, run: () => void) => (
      <ConfirmPanel
        // A different question is a fresh panel, so its safe answer takes focus.
        key={armed}
        question={q}
        onAnswer={(yes) => {
          setArmed(null);
          opener.current?.focus();
          if (yes) run();
        }}
      />
    ),
  };
}
