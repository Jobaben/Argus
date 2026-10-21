import type { KeyboardEvent } from "react";

/** What Tab can land on, skipping what the browser's own tab order skips. */
const TAB_STOPS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab and Shift+Tab, kept inside a modal dialog. Call it from the dialog's own
 * `onKeyDown`.
 *
 * `aria-modal` tells a screen reader that the page behind is out of reach, but
 * the browser's tab order ignores it: from the palette's input, and from the
 * shortcut sheet's Close button, Tab went to <body> and then to the skip link
 * and the nav behind the scrim while the dialog stayed open over them. So the
 * dialog moves focus itself, through its own controls in document order, and
 * wraps at both ends. When focus is on none of them (the dialog surface, after
 * a click on its text), Tab goes to the first control and Shift+Tab to the
 * last.
 */
export function containTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(TAB_STOPS));
  if (stops.length === 0) return;
  const at = stops.indexOf(document.activeElement as HTMLElement);
  const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
  stops[next].focus();
}
